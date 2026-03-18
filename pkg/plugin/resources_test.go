package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

func TestHandleListClustersReturnsAccessibleClusters(t *testing.T) {
	app := &App{
		catalog: NewCatalogService(
			&settings.Settings{
				Clusters: []settings.ClusterProfile{
					{ID: "viewer", DisplayName: "Viewer Cluster", SlurmClusterName: "viewer", AccessRule: settings.AccessRule{AllowedRoles: []string{"Viewer", "Editor", "Admin"}}},
					{ID: "admin", DisplayName: "Admin Cluster", SlurmClusterName: "admin", AccessRule: settings.AccessRule{AllowedRoles: []string{"Admin"}}},
				},
			},
			func(cluster settings.ClusterProfile) (JobRepository, error) {
				return &stubJobRepository{}, nil
			},
		),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/clusters", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleListClusters(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var payload struct {
		Clusters []ClusterSummary `json:"clusters"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(payload.Clusters) != 1 {
		t.Fatalf("expected 1 cluster, got %d", len(payload.Clusters))
	}
	if payload.Clusters[0].ID != "viewer" {
		t.Fatalf("expected viewer cluster, got %q", payload.Clusters[0].ID)
	}
}

func TestHandleListJobsRequiresClusterID(t *testing.T) {
	app := &App{
		catalog: NewCatalogService(&settings.Settings{}, func(cluster settings.ClusterProfile) (JobRepository, error) {
			return &stubJobRepository{}, nil
		}),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleListJobs(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", rec.Code)
	}
}

func TestHandleListJobsReturnsTotalAndNextCursor(t *testing.T) {
	app := &App{
		catalog: NewCatalogService(
			&settings.Settings{
				Clusters: []settings.ClusterProfile{
					{
						ID:               "a100",
						DisplayName:      "A100",
						SlurmClusterName: "gpu_cluster",
						AccessRule:       settings.AccessRule{AllowedRoles: []string{"Viewer", "Editor", "Admin"}},
					},
				},
			},
			func(cluster settings.ClusterProfile) (JobRepository, error) {
				return &stubJobRepository{
					listJobs: []slurm.Job{
						{
							JobID:     42,
							Name:      "serve_llm",
							User:      "researcher1",
							Partition: "gpu-a100",
							State:     "RUNNING",
							Nodes:     []string{"gpu-node001"},
							NodeCount: 1,
							GPUsTotal: 8,
							StartTime: 1700000000,
						},
					},
					totalJobs: 250,
				}, nil
			},
		),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/jobs?clusterId=a100&limit=100", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleListJobs(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var payload struct {
		Jobs       []JobRecord `json:"jobs"`
		NextCursor string      `json:"nextCursor"`
		Total      int         `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(payload.Jobs) != 1 {
		t.Fatalf("expected 1 job, got %d", len(payload.Jobs))
	}
	if payload.Total != 250 {
		t.Fatalf("expected total 250, got %d", payload.Total)
	}
	if payload.NextCursor == "" {
		t.Fatal("expected next cursor to be set")
	}
}

func TestHandleListJobMetadataOptionsRejectsUnknownField(t *testing.T) {
	app := &App{
		catalog: NewCatalogService(&settings.Settings{}, func(cluster settings.ClusterProfile) (JobRepository, error) {
			return &stubJobRepository{}, nil
		}),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/jobs/metadata/options?clusterId=a100&field=workDir", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleListJobMetadataOptions(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", rec.Code)
	}
}

func TestHandleListJobMetadataOptionsReturnsValues(t *testing.T) {
	repo := &stubJobRepository{
		metadataValues: []string{"researcher1", "researcher2"},
	}
	app := &App{
		catalog: NewCatalogService(
			&settings.Settings{
				Clusters: []settings.ClusterProfile{
					{
						ID:               "a100",
						DisplayName:      "A100",
						SlurmClusterName: "gpu_cluster",
						AccessRule:       settings.AccessRule{AllowedRoles: []string{"Viewer", "Editor", "Admin"}},
					},
				},
			},
			func(cluster settings.ClusterProfile) (JobRepository, error) {
				return repo, nil
			},
		),
	}

	req := httptest.NewRequest(
		http.MethodGet,
		"/api/jobs/metadata/options?clusterId=a100&field=user&query=res&partition=gpu-a100&state=RUNNING",
		nil,
	)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleListJobMetadataOptions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var payload struct {
		Values []string `json:"values"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(payload.Values) != 2 || payload.Values[0] != "researcher1" {
		t.Fatalf("unexpected metadata values: %#v", payload.Values)
	}
	if repo.lastMetadataOpts.Field != "user" {
		t.Fatalf("expected field user, got %q", repo.lastMetadataOpts.Field)
	}
	if repo.lastMetadataOpts.Query != "res" {
		t.Fatalf("expected query res, got %q", repo.lastMetadataOpts.Query)
	}
	if repo.lastMetadataOpts.Partition != "gpu-a100" {
		t.Fatalf("expected partition gpu-a100, got %q", repo.lastMetadataOpts.Partition)
	}
	if repo.lastMetadataOpts.State != "RUNNING" {
		t.Fatalf("expected state RUNNING, got %q", repo.lastMetadataOpts.State)
	}
}

func TestHandleGetJobReturnsClusterScopedPayload(t *testing.T) {
	app := &App{
		catalog: NewCatalogService(
			&settings.Settings{
				Clusters: []settings.ClusterProfile{
					{
						ID:                "a100",
						DisplayName:       "A100",
						SlurmClusterName:  "gpu_cluster",
						DefaultTemplateID: "overview",
						AccessRule:        settings.AccessRule{AllowedRoles: []string{"Viewer", "Editor", "Admin"}},
					},
				},
			},
			func(cluster settings.ClusterProfile) (JobRepository, error) {
				return &stubJobRepository{
					getJob: &slurm.Job{
						JobID:     42,
						Name:      "serve_llm",
						User:      "researcher1",
						Partition: "gpu-a100",
						State:     "RUNNING",
						Nodes:     []string{"gpu-node001"},
						NodeCount: 1,
						GPUsTotal: 8,
						StartTime: 1700000000,
					},
				}, nil
			},
		),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/jobs/a100/42", nil)
	req.SetPathValue("clusterId", "a100")
	req.SetPathValue("jobId", "42")
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleGetJob(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var payload JobRecord
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if payload.ClusterID != "a100" {
		t.Fatalf("expected cluster id a100, got %q", payload.ClusterID)
	}
	if payload.TemplateID != "inference" {
		t.Fatalf("expected inference template, got %q", payload.TemplateID)
	}
}

func TestHandleAutoFilterMetricsRequiresServiceURL(t *testing.T) {
	app := &App{
		settings: &settings.Settings{},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", http.NoBody)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", rec.Code)
	}
}

func TestHandleAutoFilterMetricsRejectsInvalidJSON(t *testing.T) {
	app := &App{
		settings: &settings.Settings{MetricSifterServiceURL: "http://metricsifter:8000"},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", bytes.NewBufferString("{"))
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", rec.Code)
	}
}

func TestHandleAutoFilterMetricsRequiresClusterAndJobID(t *testing.T) {
	app := &App{
		settings: &settings.Settings{MetricSifterServiceURL: "http://metricsifter:8000"},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", bytes.NewReader(mustJSON(t, map[string]any{
		"clusterId":  "",
		"jobId":      "",
		"timestamps": []int64{1700000000000},
		"series":     []map[string]any{},
	})))
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", rec.Code)
	}
}

func TestHandleAutoFilterMetricsProxiesRequestAndResponse(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/v1/filter" {
			t.Fatalf("expected /v1/filter, got %s", r.URL.Path)
		}

		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload["clusterId"] != "a100" {
			t.Fatalf("expected clusterId to be forwarded, got %#v", payload["clusterId"])
		}
		params, ok := payload["params"].(map[string]any)
		if !ok {
			t.Fatalf("expected params to be forwarded, got %#v", payload["params"])
		}
		if params["bandwidth"] != 4.5 {
			t.Fatalf("expected bandwidth 4.5, got %#v", params["bandwidth"])
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"selectedMetricKeys":  []string{"raw:gpu:DCGM_FI_DEV_GPU_UTIL"},
			"selectedSeriesIds":   []string{"gpu:DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400"},
			"selectedSeriesCount": 1,
			"totalSeriesCount":    2,
			"selectedMetricCount": 1,
			"totalMetricCount":    2,
		})
	}))
	defer sidecar.Close()

	app := &App{
		settings:               &settings.Settings{MetricSifterServiceURL: sidecar.URL},
		metricSifterHTTPClient: sidecar.Client(),
	}

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/metrics/auto-filter",
		bytes.NewReader(mustJSON(t, map[string]any{
			"clusterId":  "a100",
			"jobId":      "10001",
			"timestamps": []int64{1700000000000},
			"series": []map[string]any{
				{
					"seriesId":   "gpu:DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400",
					"metricKey":  "raw:gpu:DCGM_FI_DEV_GPU_UTIL",
					"metricName": "DCGM_FI_DEV_GPU_UTIL",
					"values":     []float64{20},
				},
			},
			"params": map[string]any{
				"searchMethod":           "bottomup",
				"costModel":              "rbf",
				"penalty":                "bic",
				"penaltyAdjust":          2.0,
				"bandwidth":              4.5,
				"segmentSelectionMethod": "max",
				"nJobs":                  -1,
				"withoutSimpleFilter":    true,
			},
		})),
	)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d, body=%s", rec.Code, rec.Body.String())
	}

	var respPayload autoFilterResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &respPayload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(respPayload.SelectedSeriesIDs) != 1 {
		t.Fatalf("expected 1 selectedSeriesIds, got %d", len(respPayload.SelectedSeriesIDs))
	}
	if respPayload.SelectedSeriesIDs[0] != "gpu:DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400" {
		t.Fatalf("unexpected selectedSeriesIds[0]: %q", respPayload.SelectedSeriesIDs[0])
	}
}

func TestHandleAutoFilterMetricsFallsBackToDefaultParams(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		params, ok := payload["params"].(map[string]any)
		if !ok {
			t.Fatalf("expected default params to be forwarded, got %#v", payload["params"])
		}
		if params["searchMethod"] != "pelt" {
			t.Fatalf("expected searchMethod pelt, got %#v", params["searchMethod"])
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"selectedMetricKeys":  []string{},
			"selectedSeriesCount": 0,
			"totalSeriesCount":    0,
			"selectedMetricCount": 0,
			"totalMetricCount":    0,
		})
	}))
	defer sidecar.Close()

	app := &App{
		settings: &settings.Settings{
			MetricSifterServiceURL: sidecar.URL,
			MetricSifterDefaultParams: &settings.MetricSifterParams{
				SearchMethod:           "pelt",
				CostModel:              "l2",
				Penalty:                "bic",
				PenaltyAdjust:          2,
				Bandwidth:              2.5,
				SegmentSelectionMethod: "weighted_max",
				NJobs:                  1,
				WithoutSimpleFilter:    false,
			},
		},
		metricSifterHTTPClient: sidecar.Client(),
	}

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/metrics/auto-filter",
		bytes.NewReader(mustJSON(t, map[string]any{
			"clusterId":  "a100",
			"jobId":      "10001",
			"timestamps": []int64{1700000000000},
			"series":     []map[string]any{},
		})),
	)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleAutoFilterMetricsReturnsGatewayTimeout(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(50 * time.Millisecond)
		writeJSON(w, http.StatusOK, map[string]any{})
	}))
	server.Listener = listener
	server.Start()
	defer server.Close()

	app := &App{
		settings: &settings.Settings{MetricSifterServiceURL: server.URL},
		metricSifterHTTPClient: &http.Client{
			Timeout: 10 * time.Millisecond,
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", bytes.NewReader(mustJSON(t, map[string]any{
		"clusterId":  "a100",
		"jobId":      "10001",
		"timestamps": []int64{1700000000000},
		"series":     []map[string]any{},
	})))
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected status 504, got %d", rec.Code)
	}
}

func TestHandleAutoFilterMetricsMapsUpstreamErrorResponses(t *testing.T) {
	for _, statusCode := range []int{http.StatusBadRequest, http.StatusInternalServerError} {
		t.Run(http.StatusText(statusCode), func(t *testing.T) {
			sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSONError(w, statusCode, "upstream failed")
			}))
			defer sidecar.Close()

			app := &App{
				settings:               &settings.Settings{MetricSifterServiceURL: sidecar.URL},
				metricSifterHTTPClient: sidecar.Client(),
			}

			req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", bytes.NewReader(mustJSON(t, map[string]any{
				"clusterId":  "a100",
				"jobId":      "10001",
				"timestamps": []int64{1700000000000},
				"series":     []map[string]any{},
			})))
			req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
			rec := httptest.NewRecorder()

			app.handleAutoFilterMetrics(rec, req)

			if rec.Code != http.StatusBadGateway {
				t.Fatalf("expected status 502, got %d", rec.Code)
			}
		})
	}
}

func TestHandleAutoFilterMetricsRejectsInvalidUpstreamJSON(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{"))
	}))
	defer sidecar.Close()

	app := &App{
		settings:               &settings.Settings{MetricSifterServiceURL: sidecar.URL},
		metricSifterHTTPClient: sidecar.Client(),
	}

	req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", bytes.NewReader(mustJSON(t, map[string]any{
		"clusterId":  "a100",
		"jobId":      "10001",
		"timestamps": []int64{1700000000000},
		"series":     []map[string]any{},
	})))
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected status 502, got %d", rec.Code)
	}
}

func mustJSON(t *testing.T, payload any) []byte {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return raw
}
