package plugin

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/templates"
)

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (a *App) handleListClusters(w http.ResponseWriter, r *http.Request) {
	user := backend.UserFromContext(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"clusters": a.catalog.ListClusters(user),
	})
}

func (a *App) handleListJobs(w http.ResponseWriter, r *http.Request) {
	clusterID := r.URL.Query().Get("clusterId")
	if clusterID == "" {
		writeJSONError(w, http.StatusBadRequest, "clusterId is required")
		return
	}

	user := backend.UserFromContext(r.Context())
	query := r.URL.Query()
	templateOverride := query.Get("template")

	if jobIDStr := query.Get("jobId"); jobIDStr != "" {
		jobID, err := strconv.ParseUint(jobIDStr, 10, 32)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid job ID")
			return
		}
		job, err := a.catalog.GetJob(r.Context(), user, clusterID, uint32(jobID), templateOverride)
		if err != nil {
			a.writeCatalogError(w, err, "Failed to get job")
			return
		}
		jobs := []JobRecord{}
		if job != nil {
			jobs = append(jobs, *job)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"jobs":       jobs,
			"nextCursor": "",
			"total":      len(jobs),
		})
		return
	}

	opts := parseListOptions(query)
	jobs, total, err := a.catalog.ListJobs(r.Context(), user, ListJobsQuery{
		ClusterID:        clusterID,
		TemplateOverride: templateOverride,
		Options:          opts,
	})
	if err != nil {
		a.writeCatalogError(w, err, "Failed to list jobs")
		return
	}

	nextCursor := ""
	if opts.Limit > 0 && opts.Offset+len(jobs) < total {
		nextCursor = encodeCursor(opts.Offset + len(jobs))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"jobs":       jobs,
		"nextCursor": nextCursor,
		"total":      total,
	})
}

func (a *App) handleListJobMetadataOptions(w http.ResponseWriter, r *http.Request) {
	clusterID := r.URL.Query().Get("clusterId")
	if clusterID == "" {
		writeJSONError(w, http.StatusBadRequest, "clusterId is required")
		return
	}

	opts, err := parseMetadataValuesOptions(r.URL.Query())
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	user := backend.UserFromContext(r.Context())
	values, err := a.catalog.ListMetadataValues(r.Context(), user, clusterID, opts)
	if err != nil {
		a.writeCatalogError(w, err, "Failed to list job metadata options")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"values": values,
	})
}

func (a *App) handleGetJob(w http.ResponseWriter, r *http.Request) {
	clusterID := r.PathValue("clusterId")
	if clusterID == "" {
		writeJSONError(w, http.StatusBadRequest, "clusterId is required")
		return
	}

	jobIDStr := r.PathValue("jobId")
	jobID, err := strconv.ParseUint(jobIDStr, 10, 32)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid job ID")
		return
	}

	user := backend.UserFromContext(r.Context())
	job, err := a.catalog.GetJob(r.Context(), user, clusterID, uint32(jobID), r.URL.Query().Get("template"))
	if err != nil {
		a.writeCatalogError(w, err, "Failed to get job")
		return
	}
	if job == nil {
		writeJSONError(w, http.StatusNotFound, "job not found")
		return
	}

	writeJSON(w, http.StatusOK, job)
}

func (a *App) handleListTemplates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"templates": templates.Builtins(),
	})
}

func (a *App) handleExportDashboard(w http.ResponseWriter, r *http.Request) {
	user := backend.UserFromContext(r.Context())
	if user == nil || (user.Role != "Editor" && user.Role != "Admin") {
		writeJSONError(w, http.StatusForbidden, "dashboard export requires Editor or Admin role")
		return
	}
	var req exportDashboardRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1*1024*1024)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid export payload")
		return
	}
	if req.ClusterID == "" || req.JobID == 0 {
		writeJSONError(w, http.StatusBadRequest, "clusterId and jobId are required")
		return
	}

	cluster, err := a.catalog.getCluster(req.ClusterID, user)
	if err != nil {
		a.writeCatalogError(w, err, "Failed to resolve cluster for export")
		return
	}
	job, err := a.catalog.GetJob(r.Context(), user, req.ClusterID, req.JobID, req.Template)
	if err != nil {
		a.writeCatalogError(w, err, "Failed to resolve job for export")
		return
	}
	if job == nil {
		writeJSONError(w, http.StatusNotFound, "job not found")
		return
	}

	result, err := a.exportDashboard(r.Context(), buildDashboardPayload(*job, cluster))
	if err != nil {
		log.DefaultLogger.Error("Failed to export dashboard", "error", err, "clusterId", req.ClusterID, "jobId", req.JobID)
		writeJSONError(w, http.StatusInternalServerError, "dashboard export failed")
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (a *App) writeCatalogError(w http.ResponseWriter, err error, logMessage string) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeJSONError(w, http.StatusForbidden, "access denied for cluster")
	case errors.Is(err, ErrClusterNotFound):
		writeJSONError(w, http.StatusNotFound, "cluster not found")
	default:
		log.DefaultLogger.Error(logMessage, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "request failed")
	}
}

func parseListOptions(q url.Values) slurm.ListJobsOptions {
	offset := decodeCursor(q.Get("cursor"))
	opts := slurm.ListJobsOptions{
		User:      q.Get("user"),
		Account:   q.Get("account"),
		Partition: q.Get("partition"),
		State:     q.Get("state"),
		Name:      q.Get("name"),
		Offset:    offset,
		Limit:     100,
	}

	if v := q.Get("from"); v != "" {
		opts.From, _ = strconv.ParseInt(v, 10, 64)
	}
	if v := q.Get("to"); v != "" {
		opts.To, _ = strconv.ParseInt(v, 10, 64)
	}
	if v := q.Get("limit"); v != "" {
		limit, _ := strconv.Atoi(v)
		if limit > 0 && limit <= 1000 {
			opts.Limit = limit
		}
	}

	return opts
}

func parseMetadataValuesOptions(q url.Values) (slurm.ListMetadataValuesOptions, error) {
	field := q.Get("field")
	if !isSupportedMetadataField(field) {
		return slurm.ListMetadataValuesOptions{}, fmt.Errorf("field must be one of name, user, account, partition")
	}

	opts := slurm.ListMetadataValuesOptions{
		Field:     field,
		Query:     q.Get("query"),
		User:      q.Get("user"),
		Account:   q.Get("account"),
		Partition: q.Get("partition"),
		State:     q.Get("state"),
		Name:      q.Get("name"),
		Limit:     50,
	}

	if v := q.Get("limit"); v != "" {
		limit, _ := strconv.Atoi(v)
		if limit > 0 && limit <= 100 {
			opts.Limit = limit
		}
	}

	return opts, nil
}

func isSupportedMetadataField(field string) bool {
	switch field {
	case "name", "user", "account", "partition":
		return true
	default:
		return false
	}
}

func encodeCursor(offset int) string {
	return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%d", offset)))
}

func decodeCursor(cursor string) int {
	if cursor == "" {
		return 0
	}
	raw, err := base64.StdEncoding.DecodeString(cursor)
	if err != nil {
		return 0
	}
	offset, err := strconv.Atoi(string(raw))
	if err != nil {
		return 0
	}
	return offset
}
