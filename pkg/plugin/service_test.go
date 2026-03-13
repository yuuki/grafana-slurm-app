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
	totalJobs        int
	lastListOpts     slurm.ListJobsOptions
	metadataValues   []string
	lastMetadataOpts slurm.ListMetadataValuesOptions
	getJob           *slurm.Job
	getErr           error
}

func (s *stubJobRepository) ListJobs(_ context.Context, opts slurm.ListJobsOptions) ([]slurm.Job, int, error) {
	s.lastListOpts = opts
	return s.listJobs, s.totalJobs, nil
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
				{ID: "viewer", DisplayName: "Viewer Cluster", SlurmClusterName: "viewer", AggregationNodeLabels: []string{"host.name", "instance"}, AccessRule: settings.AccessRule{AllowedRoles: []string{"Viewer", "Editor", "Admin"}}},
				{ID: "editor", DisplayName: "Editor Cluster", SlurmClusterName: "editor", AggregationNodeLabels: []string{"host.name", "instance"}, AccessRule: settings.AccessRule{AllowedRoles: []string{"Editor", "Admin"}}},
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
	if len(clusters[0].AggregationNodeLabels) != 2 || clusters[0].AggregationNodeLabels[0] != "host.name" || clusters[0].AggregationNodeLabels[1] != "instance" {
		t.Fatalf("expected aggregation node labels to be exposed, got %#v", clusters[0].AggregationNodeLabels)
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
					JobID:      10001,
					Name:       "pretrain_llm",
					User:       "researcher1",
					Partition:  "gpu-a100",
					State:      "RUNNING",
					Nodes:      []string{"gpu-node001", "gpu-node002"},
					NodeCount:  2,
					GPUsTotal:  16,
					SubmitTime: 1699999700,
					StartTime:  1700000000,
					EndTime:    0,
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

func TestCatalogServiceListJobsReturnsTotalCount(t *testing.T) {
	repo := &stubJobRepository{
		listJobs: []slurm.Job{
			{
				JobID:      10001,
				Name:       "pretrain_llm",
				User:       "researcher1",
				Partition:  "gpu-a100",
				State:      "RUNNING",
				Nodes:      []string{"gpu-node001"},
				NodeCount:  1,
				GPUsTotal:  8,
				SubmitTime: 1699999700,
				StartTime:  1700000000,
			},
		},
		totalJobs: 250,
	}
	svc := NewCatalogService(
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
	)

	jobs, total, err := svc.ListJobs(context.Background(), &backend.User{Role: "Viewer"}, ListJobsQuery{
		ClusterID: "a100",
		Options: slurm.ListJobsOptions{
			Limit:  100,
			Offset: 100,
		},
	})
	if err != nil {
		t.Fatalf("ListJobs returned error: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("expected 1 job, got %d", len(jobs))
	}
	if total != 250 {
		t.Fatalf("expected total 250, got %d", total)
	}
	if repo.lastListOpts.Offset != 100 {
		t.Fatalf("expected offset 100, got %d", repo.lastListOpts.Offset)
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
