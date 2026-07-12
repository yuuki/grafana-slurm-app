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
	listJobs           []slurm.Job
	totalJobs          int
	lastListOpts       slurm.ListJobsOptions
	metadataValues     []string
	lastMetadataOpts   slurm.ListMetadataValuesOptions
	getJob             *slurm.Job
	getErr             error
	nodeStatsJobs      []slurm.NodeStatsJob
	nodeStatsTruncated bool
	nodeStatsErr       error
	lastNodeStatsFrom  int64
	lastNodeStatsTo    int64
	lastNodeStatsLimit int64
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

func (s *stubJobRepository) ListNodeStatsJobs(_ context.Context, from, to, limit int64) ([]slurm.NodeStatsJob, bool, error) {
	s.lastNodeStatsFrom = from
	s.lastNodeStatsTo = to
	s.lastNodeStatsLimit = limit
	return s.nodeStatsJobs, s.nodeStatsTruncated, s.nodeStatsErr
}

func TestCatalogServiceNodeHealth(t *testing.T) {
	repo := &stubJobRepository{
		nodeStatsJobs: []slurm.NodeStatsJob{
			{State: "FAILED", NodeList: "bad-node", EndTime: 190},
			{State: "COMPLETED", NodeList: "good-node", EndTime: 180},
		},
		nodeStatsTruncated: true,
	}
	svc := NewCatalogService(
		&settings.Settings{Clusters: []settings.ClusterProfile{
			{
				ID:               "a100",
				DisplayName:      "A100 Cluster",
				SlurmClusterName: "gpu_cluster",
				AccessRule:       settings.AccessRule{AllowedRoles: []string{"Viewer"}},
			},
		}},
		func(cluster settings.ClusterProfile) (JobRepository, error) { return repo, nil },
	)

	payload, err := svc.NodeHealth(context.Background(), "a100", &backend.User{Role: "Viewer"}, 100, 200)
	if err != nil {
		t.Fatalf("NodeHealth() error = %v", err)
	}
	if payload.Cluster.ID != "a100" || payload.Cluster.Name != "A100 Cluster" {
		t.Errorf("Cluster = %#v, want API id and display name", payload.Cluster)
	}
	if payload.Window.From != 100 || payload.Window.To != 200 {
		t.Errorf("Window = %#v, want from=100 to=200", payload.Window)
	}
	if !payload.Truncated {
		t.Error("Truncated = false, want true")
	}
	if payload.Baseline.TotalJobs != 2 || payload.Baseline.FailedJobs != 1 || payload.Baseline.FailureRate != 0.5 {
		t.Errorf("Baseline = %#v, want 2 total, 1 failed, rate 0.5", payload.Baseline)
	}
	if len(payload.Nodes) != 2 || payload.Nodes[0].Name != "bad-node" {
		t.Errorf("Nodes = %#v, want bad-node ranked first", payload.Nodes)
	}
	if repo.lastNodeStatsFrom != 100 || repo.lastNodeStatsTo != 200 || repo.lastNodeStatsLimit != 20000 {
		t.Errorf("ListNodeStatsJobs args = (%d, %d, %d), want (100, 200, 20000)", repo.lastNodeStatsFrom, repo.lastNodeStatsTo, repo.lastNodeStatsLimit)
	}
}

func TestCatalogServiceNodeHealthRejectsInaccessibleCluster(t *testing.T) {
	tests := []struct {
		name      string
		clusterID string
		wantErr   error
	}{
		{name: "unauthorized", clusterID: "admin", wantErr: ErrForbidden},
		{name: "unknown", clusterID: "missing", wantErr: ErrClusterNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			providerCalled := false
			svc := NewCatalogService(
				&settings.Settings{Clusters: []settings.ClusterProfile{
					{
						ID:               "admin",
						DisplayName:      "Admin Cluster",
						SlurmClusterName: "admin",
						AccessRule:       settings.AccessRule{AllowedRoles: []string{"Admin"}},
					},
				}},
				func(cluster settings.ClusterProfile) (JobRepository, error) {
					providerCalled = true
					return &stubJobRepository{}, nil
				},
			)

			_, err := svc.NodeHealth(context.Background(), tt.clusterID, &backend.User{Role: "Viewer"}, 100, 200)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("NodeHealth() error = %v, want %v", err, tt.wantErr)
			}
			if providerCalled {
				t.Fatal("repository provider called before cluster authorization")
			}
		})
	}
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
