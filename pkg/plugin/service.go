package plugin

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/templates"
)

var (
	ErrForbidden       = errors.New("forbidden")
	ErrClusterNotFound = errors.New("cluster not found")
)

type JobRepository interface {
	ListJobs(ctx context.Context, opts slurm.ListJobsOptions) ([]slurm.Job, error)
	GetJob(ctx context.Context, jobID uint32) (*slurm.Job, error)
}

type RepositoryProvider func(cluster settings.ClusterProfile) (JobRepository, error)

type ClusterSummary struct {
	ID                   string                   `json:"id"`
	DisplayName          string                   `json:"displayName"`
	SlurmClusterName     string                   `json:"slurmClusterName"`
	MetricsDatasourceUID string                   `json:"metricsDatasourceUid"`
	MetricsType          settings.MetricsType     `json:"metricsType"`
	InstanceLabel        string                   `json:"instanceLabel"`
	NodeExporterPort     string                   `json:"nodeExporterPort"`
	DCGMExporterPort     string                   `json:"dcgmExporterPort"`
	NodeMatcherMode      settings.NodeMatcherMode `json:"nodeMatcherMode"`
	DefaultTemplateID    string                   `json:"defaultTemplateId"`
}

type JobRecord struct {
	ClusterID  string   `json:"clusterId"`
	JobID      uint32   `json:"jobId"`
	Name       string   `json:"name"`
	User       string   `json:"user"`
	Account    string   `json:"account"`
	Partition  string   `json:"partition"`
	State      string   `json:"state"`
	Nodes      []string `json:"nodes"`
	NodeCount  int      `json:"nodeCount"`
	GPUsTotal  int      `json:"gpusTotal"`
	StartTime  int64    `json:"startTime"`
	EndTime    int64    `json:"endTime"`
	ExitCode   int      `json:"exitCode"`
	WorkDir    string   `json:"workDir"`
	TRES       string   `json:"tres"`
	TemplateID string   `json:"templateId"`
}

type ListJobsQuery struct {
	ClusterID        string
	TemplateOverride string
	Options          slurm.ListJobsOptions
}

type CatalogService struct {
	settings     *settings.Settings
	repoProvider RepositoryProvider
}

func NewCatalogService(cfg *settings.Settings, repoProvider RepositoryProvider) *CatalogService {
	return &CatalogService{
		settings:     cfg,
		repoProvider: repoProvider,
	}
}

func (s *CatalogService) ListClusters(user *backend.User) []ClusterSummary {
	clusters := make([]ClusterSummary, 0, len(s.settings.Clusters))
	for _, cluster := range s.settings.Clusters {
		if !isClusterAccessible(cluster, user) {
			continue
		}
		clusters = append(clusters, ClusterSummary{
			ID:                   cluster.ID,
			DisplayName:          cluster.DisplayName,
			SlurmClusterName:     cluster.SlurmClusterName,
			MetricsDatasourceUID: cluster.MetricsDatasourceUID,
			MetricsType:          cluster.MetricsType,
			InstanceLabel:        cluster.InstanceLabel,
			NodeExporterPort:     cluster.NodeExporterPort,
			DCGMExporterPort:     cluster.DCGMExporterPort,
			NodeMatcherMode:      cluster.NodeMatcherMode,
			DefaultTemplateID:    cluster.DefaultTemplateID,
		})
	}
	sort.Slice(clusters, func(i, j int) bool {
		return clusters[i].DisplayName < clusters[j].DisplayName
	})
	return clusters
}

func (s *CatalogService) ListJobs(ctx context.Context, user *backend.User, query ListJobsQuery) ([]JobRecord, error) {
	cluster, err := s.getCluster(query.ClusterID, user)
	if err != nil {
		return nil, err
	}
	repo, err := s.repoProvider(cluster)
	if err != nil {
		return nil, fmt.Errorf("creating repository for cluster %s: %w", cluster.ID, err)
	}
	jobs, err := repo.ListJobs(ctx, query.Options)
	if err != nil {
		return nil, err
	}

	result := make([]JobRecord, 0, len(jobs))
	for _, job := range jobs {
		result = append(result, jobRecordFromSlurm(job, cluster, query.TemplateOverride))
	}
	return result, nil
}

func (s *CatalogService) GetJob(ctx context.Context, user *backend.User, clusterID string, jobID uint32, templateOverride string) (*JobRecord, error) {
	cluster, err := s.getCluster(clusterID, user)
	if err != nil {
		return nil, err
	}
	repo, err := s.repoProvider(cluster)
	if err != nil {
		return nil, fmt.Errorf("creating repository for cluster %s: %w", cluster.ID, err)
	}
	job, err := repo.GetJob(ctx, jobID)
	if err != nil {
		return nil, err
	}
	if job == nil {
		return nil, nil
	}

	record := jobRecordFromSlurm(*job, cluster, templateOverride)
	return &record, nil
}

func (s *CatalogService) getCluster(clusterID string, user *backend.User) (settings.ClusterProfile, error) {
	for _, cluster := range s.settings.Clusters {
		if cluster.ID != clusterID {
			continue
		}
		if !isClusterAccessible(cluster, user) {
			return settings.ClusterProfile{}, ErrForbidden
		}
		return cluster, nil
	}
	return settings.ClusterProfile{}, ErrClusterNotFound
}

func isClusterAccessible(cluster settings.ClusterProfile, user *backend.User) bool {
	if user == nil {
		return false
	}
	if !cluster.AccessRule.AllowsRole(user.Role) {
		return false
	}
	if !cluster.AccessRule.AllowsUser(user.Login) {
		return false
	}
	return true
}

func jobRecordFromSlurm(job slurm.Job, cluster settings.ClusterProfile, templateOverride string) JobRecord {
	return JobRecord{
		ClusterID:  cluster.ID,
		JobID:      job.JobID,
		Name:       job.Name,
		User:       job.User,
		Account:    job.Account,
		Partition:  job.Partition,
		State:      job.State,
		Nodes:      job.Nodes,
		NodeCount:  job.NodeCount,
		GPUsTotal:  job.GPUsTotal,
		StartTime:  job.StartTime,
		EndTime:    job.EndTime,
		ExitCode:   job.ExitCode,
		WorkDir:    job.WorkDir,
		TRES:       job.TRES,
		TemplateID: templates.SelectTemplateID(job, cluster, templateOverride),
	}
}
