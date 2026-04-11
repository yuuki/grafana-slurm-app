package plugin

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
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

	writeJSON(w, http.StatusOK, buildDashboardPayload(*job, cluster, req.Panels, req.FolderUID))
}

type autoFilterSeries struct {
	SeriesID   string     `json:"seriesId"`
	MetricKey  string     `json:"metricKey"`
	MetricName string     `json:"metricName"`
	Values     []*float64 `json:"values"`
}

type autoFilterRequest struct {
	ClusterID  string                       `json:"clusterId"`
	JobID      string                       `json:"jobId"`
	Timestamps []int64                      `json:"timestamps"`
	Series     []autoFilterSeries           `json:"series"`
	Params     *settings.MetricSifterParams `json:"params,omitempty"`
}

type autoFilterResponse struct {
	SelectedMetricKeys  []string `json:"selectedMetricKeys"`
	SelectedSeriesIDs   []string `json:"selectedSeriesIds,omitempty"`
	SelectedSeriesCount int      `json:"selectedSeriesCount"`
	TotalSeriesCount    int      `json:"totalSeriesCount"`
	SelectedMetricCount int      `json:"selectedMetricCount"`
	TotalMetricCount    int      `json:"totalMetricCount"`
	SelectedWindow      *struct {
		FromMS int64 `json:"fromMs"`
		ToMS   int64 `json:"toMs"`
	} `json:"selectedWindow,omitempty"`
}

func (a *App) handleAutoFilterMetrics(w http.ResponseWriter, r *http.Request) {
	if a.settings == nil || strings.TrimSpace(a.settings.MetricSifterServiceURL) == "" {
		writeJSONError(w, http.StatusBadRequest, "metricsifter service URL is not configured")
		return
	}

	var req autoFilterRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20*1024*1024)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid auto-filter payload")
		return
	}
	if req.ClusterID == "" || req.JobID == "" {
		writeJSONError(w, http.StatusBadRequest, "clusterId and jobId are required")
		return
	}
	if req.Params == nil {
		req.Params = a.settings.EffectiveMetricSifterParams()
	} else {
		req.Params = req.Params.Clone()
		req.Params.Defaults()
	}
	if err := req.Params.Validate(); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	body, err := json.Marshal(req)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to encode auto-filter payload")
		return
	}

	upstreamReq, err := http.NewRequestWithContext(
		r.Context(),
		http.MethodPost,
		strings.TrimRight(a.settings.MetricSifterServiceURL, "/")+"/v1/filter",
		bytes.NewReader(body),
	)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to build auto-filter request")
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")

	client := a.metricSifterHTTPClient
	if client == nil {
		client = &http.Client{}
	}

	resp, err := client.Do(upstreamReq)
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			writeJSONError(w, http.StatusGatewayTimeout, "metricsifter request timed out")
			return
		}
		writeJSONError(w, http.StatusBadGateway, "metricsifter request failed")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusBadRequest {
		writeJSONError(w, http.StatusBadGateway, "metricsifter returned an error")
		return
	}

	var payload autoFilterResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 5*1024*1024)).Decode(&payload); err != nil {
		writeJSONError(w, http.StatusBadGateway, "invalid metricsifter response")
		return
	}

	writeJSON(w, http.StatusOK, payload)
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

func parseJobFilter(q url.Values) slurm.JobFilter {
	f := slurm.JobFilter{
		User:      q.Get("user"),
		Account:   q.Get("account"),
		Partition: q.Get("partition"),
		State:     q.Get("state"),
		Name:      q.Get("name"),
	}
	if v := q.Get("nodesMin"); v != "" {
		f.NodesMin = clampNonNegativeInt(v)
	}
	if v := q.Get("nodesMax"); v != "" {
		f.NodesMax = clampNonNegativeInt(v)
	}
	if v := q.Get("elapsedMin"); v != "" {
		f.ElapsedMin = clampNonNegativeInt64(v)
	}
	if v := q.Get("elapsedMax"); v != "" {
		f.ElapsedMax = clampNonNegativeInt64(v)
	}
	if v := q.Get("nodeNames"); v != "" {
		var names []string
		for _, n := range strings.Split(v, ",") {
			n = strings.TrimSpace(n)
			if n != "" {
				names = append(names, n)
			}
		}
		f.NodeNames = names
	}
	if v := q.Get("nodeMatchMode"); v != "" {
		v = strings.ToUpper(v)
		if v == "AND" || v == "OR" {
			f.NodeMatchMode = v
		}
	}
	return f
}

func parseListOptions(q url.Values) slurm.ListJobsOptions {
	offset := decodeCursor(q.Get("cursor"))
	opts := slurm.ListJobsOptions{
		JobFilter: parseJobFilter(q),
		Offset:    offset,
		Limit:     100,
	}

	if v := q.Get("from"); v != "" {
		opts.From = clampNonNegativeInt64(v)
	}
	if v := q.Get("to"); v != "" {
		opts.To = clampNonNegativeInt64(v)
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
		JobFilter: parseJobFilter(q),
		Field:     field,
		Query:     q.Get("query"),
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

func clampNonNegativeInt(s string) int {
	v, _ := strconv.Atoi(s)
	if v < 0 {
		return 0
	}
	return v
}

func clampNonNegativeInt64(s string) int64 {
	v, _ := strconv.ParseInt(s, 10, 64)
	if v < 0 {
		return 0
	}
	return v
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
