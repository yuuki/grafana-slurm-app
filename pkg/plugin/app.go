package plugin

import (
	"context"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
)

type App struct {
	backend.CallResourceHandler
	settings    *settings.Settings
	repoManager *RepositoryManager
	catalog     *CatalogService
}

func NewApp(ctx context.Context, appSettings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	cfg, err := settings.Parse(appSettings)
	if err != nil {
		return nil, err
	}

	repoManager := NewRepositoryManager(cfg)

	app := &App{
		settings:    cfg,
		repoManager: repoManager,
		catalog:     NewCatalogService(cfg, repoManager.RepositoryForCluster),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/clusters", app.handleListClusters)
	mux.HandleFunc("GET /api/jobs", app.handleListJobs)
	mux.HandleFunc("GET /api/jobs/{clusterId}/{jobId}", app.handleGetJob)
	mux.HandleFunc("GET /api/templates", app.handleListTemplates)
	mux.HandleFunc("POST /api/dashboards/export", app.handleExportDashboard)

	app.CallResourceHandler = httpadapter.New(mux)

	return app, nil
}

func (a *App) Dispose() {
	if a.repoManager != nil {
		a.repoManager.Close()
	}
}

func (a *App) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if len(a.settings.Clusters) == 0 {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "No clusters configured. Please configure at least one Slurm cluster.",
		}, nil
	}

	if err := a.repoManager.Ping(ctx); err != nil {
		log.DefaultLogger.Warn("Failed to connect to one or more slurmdbd databases", "error", err)
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "Failed to connect to configured slurmdbd database(s): " + err.Error(),
		}, nil
	}

	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "Connected to configured slurmdbd database(s) successfully.",
	}, nil
}
