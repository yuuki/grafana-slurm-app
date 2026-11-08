package plugin

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
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
					totalJobs:   250,
					listHasMore: true,
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
	cursor, err := decodeJobsCursor(payload.NextCursor)
	if err != nil {
		t.Fatalf("next cursor %q: %v", payload.NextCursor, err)
	}
	if cursor.After == nil || *cursor.After != (slurm.JobKey{StartTime: 1700000000, JobID: 42}) || cursor.Offset != 1 {
		t.Fatalf("next cursor = %+v, want after job 42 started at 1700000000, offset 1", cursor)
	}

	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	assertJSONKeys(t, raw, "jobs", "nextCursor", "total")
}

func TestHandleListJobsPassesRangeFilters(t *testing.T) {
	repo := &stubJobRepository{
		listJobs:  []slurm.Job{},
		totalJobs: 0,
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

	req := httptest.NewRequest(http.MethodGet,
		"/api/jobs?clusterId=a100&nodesMin=2&nodesMax=8&elapsedMin=3600&elapsedMax=86400", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleListJobs(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	if repo.lastListOpts.NodesMin != 2 {
		t.Fatalf("expected NodesMin 2, got %d", repo.lastListOpts.NodesMin)
	}
	if repo.lastListOpts.NodesMax != 8 {
		t.Fatalf("expected NodesMax 8, got %d", repo.lastListOpts.NodesMax)
	}
	if repo.lastListOpts.ElapsedMin != 3600 {
		t.Fatalf("expected ElapsedMin 3600, got %d", repo.lastListOpts.ElapsedMin)
	}
	if repo.lastListOpts.ElapsedMax != 86400 {
		t.Fatalf("expected ElapsedMax 86400, got %d", repo.lastListOpts.ElapsedMax)
	}
}

func TestHandleListJobMetadataOptionsPassesRangeFilters(t *testing.T) {
	repo := &stubJobRepository{
		metadataValues: []string{"alice"},
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

	req := httptest.NewRequest(http.MethodGet,
		"/api/jobs/metadata/options?clusterId=a100&field=user&nodesMin=4&elapsedMax=7200", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleListJobMetadataOptions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	if repo.lastMetadataOpts.NodesMin != 4 {
		t.Fatalf("expected NodesMin 4, got %d", repo.lastMetadataOpts.NodesMin)
	}
	if repo.lastMetadataOpts.ElapsedMax != 7200 {
		t.Fatalf("expected ElapsedMax 7200, got %d", repo.lastMetadataOpts.ElapsedMax)
	}
}

func TestHandleListJobsClampsNegativeValues(t *testing.T) {
	repo := &stubJobRepository{
		listJobs:  []slurm.Job{},
		totalJobs: 0,
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

	req := httptest.NewRequest(http.MethodGet,
		"/api/jobs?clusterId=a100&nodesMin=-5&from=-100&elapsedMin=-3600", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleListJobs(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	if repo.lastListOpts.NodesMin != 0 {
		t.Fatalf("expected NodesMin clamped to 0, got %d", repo.lastListOpts.NodesMin)
	}
	if repo.lastListOpts.From != 0 {
		t.Fatalf("expected From clamped to 0, got %d", repo.lastListOpts.From)
	}
	if repo.lastListOpts.ElapsedMin != 0 {
		t.Fatalf("expected ElapsedMin clamped to 0, got %d", repo.lastListOpts.ElapsedMin)
	}
}

func listJobsTestApp(repo *stubJobRepository) *App {
	return &App{catalog: NewCatalogService(
		&settings.Settings{Clusters: []settings.ClusterProfile{
			{
				ID:               "a100",
				DisplayName:      "A100",
				SlurmClusterName: "gpu_cluster",
				AccessRule:       settings.AccessRule{AllowedRoles: []string{"Viewer"}},
			},
		}},
		func(cluster settings.ClusterProfile) (JobRepository, error) {
			return repo, nil
		},
	)}
}

type listJobsPayload struct {
	Jobs       []JobRecord `json:"jobs"`
	NextCursor string      `json:"nextCursor"`
	Total      int         `json:"total"`
}

func serveListJobs(t *testing.T, app *App, query string) (*httptest.ResponseRecorder, listJobsPayload) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/jobs?"+query, nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()
	app.handleListJobs(rec, req)

	var payload listJobsPayload
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("unmarshal response: %v", err)
		}
	}
	return rec, payload
}

func legacyOffsetCursor(offset string) string {
	return base64.StdEncoding.EncodeToString([]byte(offset))
}

func TestHandleListJobsPassesKeysetCursor(t *testing.T) {
	repo := &stubJobRepository{
		listJobs: []slurm.Job{
			{JobID: 10100, StartTime: 1700000100},
			{JobID: 10099, StartTime: 1700000050},
		},
		totalJobs:   250,
		listHasMore: true,
	}
	after := slurm.JobKey{StartTime: 1700000100, JobID: 10101}

	rec, payload := serveListJobs(t, listJobsTestApp(repo),
		"clusterId=a100&nodeNames=node001&cursor="+url.QueryEscape(encodeJobsCursor(after, 100)))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if repo.lastListOpts.After == nil || *repo.lastListOpts.After != after || repo.lastListOpts.Offset != 100 {
		t.Fatalf("repository got after %+v offset %d, want after %+v offset 100",
			repo.lastListOpts.After, repo.lastListOpts.Offset, after)
	}
	next, err := decodeJobsCursor(payload.NextCursor)
	if err != nil {
		t.Fatalf("next cursor %q: %v", payload.NextCursor, err)
	}
	if next.After == nil || *next.After != (slurm.JobKey{StartTime: 1700000050, JobID: 10099}) || next.Offset != 102 {
		t.Fatalf("next cursor = %+v, want after the last job (10099 at 1700000050), offset 102", next)
	}
}

// A page opened before the upgrade holds an offset cursor; it keeps its
// offset, and the page after it continues with a keyset cursor.
func TestHandleListJobsAcceptsLegacyOffsetCursor(t *testing.T) {
	repo := &stubJobRepository{
		listJobs:    []slurm.Job{{JobID: 10001, StartTime: 1700000000}},
		totalJobs:   250,
		listHasMore: true,
	}

	rec, payload := serveListJobs(t, listJobsTestApp(repo), "clusterId=a100&limit=100&cursor="+url.QueryEscape(legacyOffsetCursor("100")))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if repo.lastListOpts.After != nil || repo.lastListOpts.Offset != 100 {
		t.Fatalf("repository got after %+v offset %d, want offset 100 without a keyset",
			repo.lastListOpts.After, repo.lastListOpts.Offset)
	}
	next, err := decodeJobsCursor(payload.NextCursor)
	if err != nil {
		t.Fatalf("next cursor %q: %v", payload.NextCursor, err)
	}
	if next.After == nil || *next.After != (slurm.JobKey{StartTime: 1700000000, JobID: 10001}) || next.Offset != 101 {
		t.Fatalf("next cursor = %+v, want after job 10001, offset 101", next)
	}
}

// The next cursor follows the repository's HasMore, not the count, which can
// change between the count and the page queries.
func TestHandleListJobsLastPageHasNoNextCursor(t *testing.T) {
	repo := &stubJobRepository{
		listJobs:  []slurm.Job{{JobID: 10001, StartTime: 1700000000}},
		totalJobs: 250,
	}

	rec, payload := serveListJobs(t, listJobsTestApp(repo), "clusterId=a100&limit=1")

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	if payload.NextCursor != "" || payload.Total != 250 || len(payload.Jobs) != 1 {
		t.Fatalf("payload = %+v, want one job, total 250 and no next cursor", payload)
	}
}

// A malformed cursor is a bad request. It used to restart silently at the
// first page, and a negative offset made the node-filter path panic.
func TestHandleListJobsRejectsMalformedCursor(t *testing.T) {
	for _, tc := range []struct{ name, cursor string }{
		{"not base64", "not-base64!"},
		{"negative offset", legacyOffsetCursor("-1")},
		{"signed offset", legacyOffsetCursor("+5")},
		{"offset with spaces", legacyOffsetCursor(" 5")},
		{"offset out of range", legacyOffsetCursor("2147483648")},
		{"text", legacyOffsetCursor("abc")},
		{"decodes to nothing", "\r\n"},
		{"newline", legacyOffsetCursor("\n")},
		{"keyset missing offset", legacyOffsetCursor("k1:1700000000:42")},
		{"keyset extra field", legacyOffsetCursor("k1:1700000000:42:100:1")},
		{"keyset job ID out of range", legacyOffsetCursor("k1:1700000000:4294967296:0")},
		{"keyset negative offset", legacyOffsetCursor("k1:1700000000:42:-1")},
		{"keyset leading zero", legacyOffsetCursor("k1:01700000000:42:0")},
		{"keyset empty fields", legacyOffsetCursor("k1:::")},
		{"unknown version", legacyOffsetCursor("k2:1700000000:42:100")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &stubJobRepository{}
			rec, _ := serveListJobs(t, listJobsTestApp(repo),
				"clusterId=a100&nodeNames=node001&cursor="+url.QueryEscape(tc.cursor))

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status 400, got %d", rec.Code)
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("unmarshal error body: %v", err)
			}
			if body["error"] != "invalid cursor" {
				t.Fatalf("error = %#v, want \"invalid cursor\"", body["error"])
			}
			if repo.listCalls != 0 {
				t.Fatalf("repository called %d times for a malformed cursor", repo.listCalls)
			}
		})
	}
}

func TestJobsCursorRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		after  slurm.JobKey
		offset int
	}{
		{slurm.JobKey{StartTime: 1700000000, JobID: 42}, 100},
		{slurm.JobKey{StartTime: 0, JobID: 0}, 0},
		{slurm.JobKey{StartTime: math.MaxInt64, JobID: math.MaxUint32}, maxCursorOffset},
		{slurm.JobKey{StartTime: math.MinInt64, JobID: 1}, 1},
	} {
		cursor := encodeJobsCursor(tc.after, tc.offset)
		got, err := decodeJobsCursor(cursor)
		if err != nil {
			t.Fatalf("decodeJobsCursor(%q): %v", cursor, err)
		}
		if got.After == nil || *got.After != tc.after || got.Offset != tc.offset {
			t.Fatalf("decodeJobsCursor(encodeJobsCursor(%+v, %d)) = %+v", tc.after, tc.offset, got)
		}
	}
}

func TestDecodeJobsCursorLegacyOffsets(t *testing.T) {
	for _, tc := range []struct {
		cursor string
		offset int
	}{
		{"", 0},
		{"MA==", 0},   // "0"
		{"Mg==", 2},   // "2", used by e2e/tests/api/list-jobs.spec.ts
		{"MTAw", 100}, // "100", the second page of an earlier version
		{legacyOffsetCursor("007"), 7},
		{legacyOffsetCursor("2147483647"), maxCursorOffset},
	} {
		got, err := decodeJobsCursor(tc.cursor)
		if err != nil {
			t.Fatalf("decodeJobsCursor(%q): %v", tc.cursor, err)
		}
		if got.After != nil || got.Offset != tc.offset {
			t.Fatalf("decodeJobsCursor(%q) = %+v, want legacy offset %d", tc.cursor, got, tc.offset)
		}
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

func TestHandleNodeHealthReturnsAPIContract(t *testing.T) {
	app := nodeHealthTestApp(settings.AccessRule{AllowedRoles: []string{"Viewer"}})
	req := httptest.NewRequest(http.MethodGet, "/api/nodes/health?clusterId=a100&from=100&to=200", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	rec := httptest.NewRecorder()

	app.handleNodeHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	assertJSONKeys(t, payload, "cluster", "window", "baseline", "truncated", "nodes")
	cluster := payload["cluster"].(map[string]any)
	assertJSONKeys(t, cluster, "id", "name")
	if cluster["id"] != "a100" || cluster["name"] != "A100 Cluster" {
		t.Errorf("cluster = %#v, want API id and display name", cluster)
	}
	window := payload["window"].(map[string]any)
	assertJSONKeys(t, window, "from", "to")
	baseline := payload["baseline"].(map[string]any)
	assertJSONKeys(t, baseline, "totalJobs", "failedJobs", "failureRate")
	if baseline["failureRate"] != 0.5 {
		t.Errorf("baseline.failureRate = %#v, want 0.5", baseline["failureRate"])
	}
	if payload["truncated"] != true {
		t.Errorf("truncated = %#v, want true", payload["truncated"])
	}
	nodes := payload["nodes"].([]any)
	if len(nodes) == 0 {
		t.Fatal("nodes is empty, want ranked nodes")
	}
	firstNode := nodes[0].(map[string]any)
	assertJSONKeys(t, firstNode,
		"name", "totalJobs", "failedJobs", "nodeFailJobs", "failedNodeHits",
		"failureRate", "expectedFailures", "score", "lastFailureAt", "lowSample",
	)
	if firstNode["name"] != "bad-node" {
		t.Errorf("nodes[0].name = %#v, want bad-node", firstNode["name"])
	}
}

func TestHandleNodeHealthRejectsBadParams(t *testing.T) {
	tests := []struct {
		name string
		url  string
	}{
		{name: "missing cluster", url: "/api/nodes/health?from=100&to=200"},
		{name: "missing from", url: "/api/nodes/health?clusterId=a100&to=200"},
		{name: "missing to", url: "/api/nodes/health?clusterId=a100&from=100"},
		{name: "garbage from", url: "/api/nodes/health?clusterId=a100&from=nope&to=200"},
		{name: "garbage to", url: "/api/nodes/health?clusterId=a100&from=100&to=nope"},
		{name: "equal range", url: "/api/nodes/health?clusterId=a100&from=100&to=100"},
		{name: "inverted range", url: "/api/nodes/health?clusterId=a100&from=200&to=100"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app := nodeHealthTestApp(settings.AccessRule{AllowedRoles: []string{"Viewer"}})
			req := httptest.NewRequest(http.MethodGet, tt.url, nil)
			req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
			rec := httptest.NewRecorder()

			app.handleNodeHealth(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("unmarshal error body: %v", err)
			}
			assertJSONKeys(t, body, "error")
		})
	}
}

func TestHandleNodeHealthMapsCatalogAccessErrors(t *testing.T) {
	tests := []struct {
		name       string
		clusterID  string
		accessRule settings.AccessRule
		wantStatus int
		wantError  string
	}{
		{
			name:       "unknown cluster",
			clusterID:  "missing",
			accessRule: settings.AccessRule{AllowedRoles: []string{"Viewer"}},
			wantStatus: http.StatusNotFound,
			wantError:  "cluster not found",
		},
		{
			name:       "unauthorized user",
			clusterID:  "a100",
			accessRule: settings.AccessRule{AllowedRoles: []string{"Admin"}},
			wantStatus: http.StatusForbidden,
			wantError:  "access denied for cluster",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app := nodeHealthTestApp(tt.accessRule)
			req := httptest.NewRequest(http.MethodGet, "/api/nodes/health?clusterId="+tt.clusterID+"&from=100&to=200", nil)
			req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
			rec := httptest.NewRecorder()

			app.handleNodeHealth(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("unmarshal error body: %v", err)
			}
			assertJSONKeys(t, body, "error")
			if body["error"] != tt.wantError {
				t.Errorf("error = %#v, want %q", body["error"], tt.wantError)
			}
		})
	}
}

func nodeHealthTestApp(accessRule settings.AccessRule) *App {
	return &App{catalog: NewCatalogService(
		&settings.Settings{Clusters: []settings.ClusterProfile{
			{
				ID:               "a100",
				DisplayName:      "A100 Cluster",
				SlurmClusterName: "gpu_cluster",
				AccessRule:       accessRule,
			},
		}},
		func(cluster settings.ClusterProfile) (JobRepository, error) {
			return &stubJobRepository{
				nodeStatsJobs: []slurm.NodeStatsJob{
					{State: "FAILED", NodeList: "bad-node", EndTime: 190},
					{State: "COMPLETED", NodeList: "good-node", EndTime: 180},
				},
				nodeStatsTruncated: true,
			}, nil
		},
	)}
}

func assertJSONKeys(t *testing.T, got map[string]any, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("JSON keys = %#v, want exactly %v", got, want)
	}
	for _, key := range want {
		if _, ok := got[key]; !ok {
			t.Errorf("JSON is missing key %q: %#v", key, got)
		}
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
		catalog:                autoFilterTestCatalog(),
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
		catalog: autoFilterTestCatalog(),
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
		catalog:  autoFilterTestCatalog(),
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

// TestHandleAutoFilterMetricsCancelsUpstreamWithRequest checks that the
// MetricSifter call is bound to the incoming request: once Grafana cancels
// the request, the upstream call stops instead of running to the client
// timeout.
func TestHandleAutoFilterMetricsCancelsUpstreamWithRequest(t *testing.T) {
	started := make(chan struct{})
	upstreamCancelled := make(chan struct{})
	release := make(chan struct{})
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Reading the body to the end lets the server notice the client
		// going away and cancel r.Context().
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-r.Context().Done():
			close(upstreamCancelled)
		case <-release:
		}
	}))
	defer sidecar.Close()
	defer close(release) // runs first, so a failed test cannot block sidecar.Close

	app := &App{
		catalog:  autoFilterTestCatalog(),
		settings: &settings.Settings{MetricSifterServiceURL: sidecar.URL},
		// No client timeout: only the request context can end the call.
		metricSifterHTTPClient: sidecar.Client(),
	}

	ctx, cancel := context.WithCancel(backend.WithUser(context.Background(), &backend.User{Role: "Viewer"}))
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", bytes.NewReader(mustJSON(t, map[string]any{
		"clusterId":  "a100",
		"jobId":      "10001",
		"timestamps": []int64{1700000000000},
		"series":     []map[string]any{},
	}))).WithContext(ctx)
	rec := httptest.NewRecorder()

	handlerDone := make(chan struct{})
	go func() {
		defer close(handlerDone)
		app.handleAutoFilterMetrics(rec, req)
	}()

	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("upstream request never arrived")
	}
	cancel()

	select {
	case <-handlerDone:
	case <-time.After(10 * time.Second):
		t.Fatal("handler did not return after the request was cancelled")
	}
	select {
	case <-upstreamCancelled:
	case <-time.After(10 * time.Second):
		t.Fatal("upstream request was not cancelled with the incoming request")
	}
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected status 502, got %d", rec.Code)
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
				catalog:                autoFilterTestCatalog(),
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
		catalog:                autoFilterTestCatalog(),
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

func TestHandleAutoFilterMetricsAllowsAuthorizedUser(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		catalog: NewCatalogService(
			&settings.Settings{
				Clusters: []settings.ClusterProfile{
					{
						ID:               "a100",
						DisplayName:      "A100",
						SlurmClusterName: "gpu_cluster",
						AccessRule:       settings.AccessRule{AllowedUsers: []string{"alice"}},
					},
				},
			},
			func(cluster settings.ClusterProfile) (JobRepository, error) {
				return &stubJobRepository{}, nil
			},
		),
		settings:               &settings.Settings{MetricSifterServiceURL: sidecar.URL},
		metricSifterHTTPClient: sidecar.Client(),
	}

	req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", bytes.NewReader(mustJSON(t, map[string]any{
		"clusterId":  "a100",
		"jobId":      "10001",
		"timestamps": []int64{1700000000000},
		"series":     []map[string]any{},
	})))
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer", Login: "alice"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 for authorized user, got %d, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleAutoFilterMetricsRejectsUnauthorizedUser(t *testing.T) {
	sidecarHit := false
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sidecarHit = true
		writeJSON(w, http.StatusOK, map[string]any{})
	}))
	defer sidecar.Close()

	app := &App{
		catalog: NewCatalogService(
			&settings.Settings{
				Clusters: []settings.ClusterProfile{
					{
						ID:               "a100",
						DisplayName:      "A100",
						SlurmClusterName: "gpu_cluster",
						AccessRule:       settings.AccessRule{AllowedRoles: []string{"Admin"}},
					},
				},
			},
			func(cluster settings.ClusterProfile) (JobRepository, error) {
				return &stubJobRepository{}, nil
			},
		),
		settings:               &settings.Settings{MetricSifterServiceURL: sidecar.URL},
		metricSifterHTTPClient: sidecar.Client(),
	}

	req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", bytes.NewReader(mustJSON(t, map[string]any{
		"clusterId":  "a100",
		"jobId":      "10001",
		"timestamps": []int64{1700000000000},
		"series":     []map[string]any{},
	})))
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer", Login: "bob"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status 403 for unauthorized user, got %d", rec.Code)
	}
	if sidecarHit {
		t.Fatal("unauthorized request must not reach the metricsifter sidecar")
	}
}

func TestHandleAutoFilterMetricsRejectsUnknownCluster(t *testing.T) {
	sidecarHit := false
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sidecarHit = true
		writeJSON(w, http.StatusOK, map[string]any{})
	}))
	defer sidecar.Close()

	app := &App{
		catalog:                autoFilterTestCatalog(),
		settings:               &settings.Settings{MetricSifterServiceURL: sidecar.URL},
		metricSifterHTTPClient: sidecar.Client(),
	}

	req := httptest.NewRequest(http.MethodPost, "/api/metrics/auto-filter", bytes.NewReader(mustJSON(t, map[string]any{
		"clusterId":  "nonexistent",
		"jobId":      "10001",
		"timestamps": []int64{1700000000000},
		"series":     []map[string]any{},
	})))
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Admin", Login: "carol"}))
	rec := httptest.NewRecorder()

	app.handleAutoFilterMetrics(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status 404 for unknown cluster, got %d", rec.Code)
	}
	if sidecarHit {
		t.Fatal("request for unknown cluster must not reach the metricsifter sidecar")
	}
}

// autoFilterTestCatalog builds a catalog exposing an "a100" cluster accessible
// to Viewer/Editor/Admin roles, matching the fixtures used by the job handlers.
func autoFilterTestCatalog() *CatalogService {
	return NewCatalogService(
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
			return &stubJobRepository{}, nil
		},
	)
}

func mustJSON(t *testing.T, payload any) []byte {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return raw
}
