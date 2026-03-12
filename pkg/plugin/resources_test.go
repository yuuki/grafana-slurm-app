package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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
