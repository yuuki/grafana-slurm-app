package plugin

import (
	"context"
	"fmt"
	"sync"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

type RepositoryManager struct {
	settings *settings.Settings

	mu    sync.Mutex
	repos map[string]*slurm.Repository
}

func NewRepositoryManager(cfg *settings.Settings) *RepositoryManager {
	return &RepositoryManager{
		settings: cfg,
		repos:    map[string]*slurm.Repository{},
	}
}

func (m *RepositoryManager) RepositoryForCluster(cluster settings.ClusterProfile) (JobRepository, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if repo, ok := m.repos[cluster.ID]; ok {
		return repo, nil
	}

	connection, err := m.connectionForCluster(cluster)
	if err != nil {
		return nil, err
	}

	repo, err := slurm.NewRepository(connection.DSN(), cluster.SlurmClusterName)
	if err != nil {
		return nil, err
	}
	m.repos[cluster.ID] = repo
	return repo, nil
}

func (m *RepositoryManager) Ping(ctx context.Context) error {
	m.mu.Lock()
	clusters := append([]settings.ClusterProfile(nil), m.settings.Clusters...)
	m.mu.Unlock()

	if len(clusters) == 0 {
		return fmt.Errorf("no clusters configured")
	}
	for _, cluster := range clusters {
		repo, err := m.RepositoryForCluster(cluster)
		if err != nil {
			return err
		}
		slurmRepo, ok := repo.(*slurm.Repository)
		if !ok {
			continue
		}
		if err := slurmRepo.Ping(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (m *RepositoryManager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	var firstErr error
	for clusterID, repo := range m.repos {
		if err := repo.Close(); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("closing repository for cluster %s: %w", clusterID, err)
		}
	}
	return firstErr
}

func (m *RepositoryManager) connectionForCluster(cluster settings.ClusterProfile) (settings.ConnectionProfile, error) {
	for _, connection := range m.settings.Connections {
		if connection.ID == cluster.ConnectionID {
			return connection, nil
		}
	}
	return settings.ConnectionProfile{}, fmt.Errorf("connection not found for cluster %s", cluster.ID)
}
