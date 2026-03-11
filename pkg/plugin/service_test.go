package plugin

import (
	"context"
	"errors"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

type stubJobRepository struct {
	listJobs         []slurm.Job
	metadataValues   []string
	lastMetadataOpts slurm.ListMetadataValuesOptions
	getJob           *slurm.Job
	getErr           error
}

func (s *stubJobRepository) ListJobs(_ context.Context, _ slurm.ListJobsOptions) ([]slurm.Job, error) {
	return s.listJobs, nil
}

func (s *stubJobRepository) ListMetadataValues(_ context.Context, opts slurm.ListMetadataValuesOptions) ([]string, error) {
	s.lastMetadataOpts = opts
	return s.metadataValues, nil
}

func (s *stubJobRepository) GetJob(_ context.Context, _ uint32) (*slurm.Job, error) {
	return s.getJob, s.getErr
}

func TestCatalogServiceFiltersClustersByRole(t *testing.T) {
	svc := NewCatalogService(
		&settings.Settings{
			Clusters: []settings.ClusterProfile{
				{ID: "viewer", DisplayName: "Viewer Cluster", SlurmClusterName: "viewer", AccessRule: settings.AccessRule{AllowedRoles: []string{"Viewer", "Editor", "Admin"}}},
				{ID: "editor", DisplayName: "Editor Cluster", SlurmClusterName: "editor", AccessRule: settings.AccessRule{AllowedRoles: []string{"Editor", "Admin"}}},
			},
		},
		func(cluster settings.ClusterProfile) (JobRepository, error) {
			return &stubJobRepository{}, nil
		},
	)

	clusters := svc.ListClusters(&backend.User{Role: "Viewer"})
	if len(clusters) != 1 {
		t.Fatalf("expected 1 cluster, got %d", len(clusters))
	}
	if clusters[0].ID != "viewer" {
		t.Fatalf("expected viewer cluster, got %q", clusters[0].ID)
	}
}

func TestCatalogServiceGetJobAddsClusterAndTemplate(t *testing.T) {
	svc := NewCatalogService(
		&settings.Settings{
			Clusters: []settings.ClusterProfile{
				{
					ID:                "a100",
					DisplayName:       "A100",
					ConnectionID:      "shared",
					SlurmClusterName:  "gpu_cluster",
					DefaultTemplateID: "overview",
					AccessRule:        settings.AccessRule{AllowedRoles: []string{"Viewer", "Editor", "Admin"}},
				},
			},
		},
		func(cluster settings.ClusterProfile) (JobRepository, error) {
			return &stubJobRepository{
				getJob: &slurm.Job{
					JobID:     10001,
					Name:      "pretrain_llm",
					User:      "researcher1",
					Partition: "gpu-a100",
					State:     "RUNNING",
					Nodes:     []string{"gpu-node001", "gpu-node002"},
					NodeCount: 2,
					GPUsTotal: 16,
					StartTime: 1700000000,
					EndTime:   0,
				},
			}, nil
		},
	)

	job, err := svc.GetJob(context.Background(), &backend.User{Role: "Viewer"}, "a100", 10001, "")
	if err != nil {
		t.Fatalf("GetJob returned error: %v", err)
	}
	if job.ClusterID != "a100" {
		t.Fatalf("expected cluster id a100, got %q", job.ClusterID)
	}
	if job.TemplateID != "distributed-training" {
		t.Fatalf("expected distributed-training template, got %q", job.TemplateID)
	}
}

func TestCatalogServiceRejectsUnauthorizedCluster(t *testing.T) {
	svc := NewCatalogService(
		&settings.Settings{
			Clusters: []settings.ClusterProfile{
				{ID: "admin", DisplayName: "Admin Cluster", SlurmClusterName: "admin", AccessRule: settings.AccessRule{AllowedRoles: []string{"Admin"}}},
			},
		},
		func(cluster settings.ClusterProfile) (JobRepository, error) {
			return &stubJobRepository{}, nil
		},
	)

	_, err := svc.GetJob(context.Background(), &backend.User{Role: "Viewer"}, "admin", 1, "")
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got %v", err)
	}
}
