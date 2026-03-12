package settings

import (
	"encoding/json"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestParseProfilesAndDefaults(t *testing.T) {
	settingsJSON := map[string]any{
		"metricsifterServiceUrl": "http://metricsifter:8000",
		"connections": []map[string]any{
			{
				"id":                "shared-slurmdbd",
				"dbHost":            "shared-db:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "sharedPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "shared-slurmdbd",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-a100",
				"defaultTemplateId":    "distributed-training",
				"accessRule": map[string]any{
					"allowedRoles": []string{"Viewer", "Editor", "Admin"},
				},
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{
		JSONData: raw,
		DecryptedSecureJSONData: map[string]string{
			"sharedPassword": "secret",
		},
	})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if len(cfg.Connections) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(cfg.Connections))
	}
	if cfg.MetricSifterServiceURL != "http://metricsifter:8000" {
		t.Fatalf("expected metricsifter service url to be parsed, got %q", cfg.MetricSifterServiceURL)
	}
	if cfg.Connections[0].Password != "secret" {
		t.Fatalf("expected password to resolve from secure json")
	}
	if len(cfg.Clusters) != 1 {
		t.Fatalf("expected 1 cluster, got %d", len(cfg.Clusters))
	}
	cluster := cfg.Clusters[0]
	if cluster.NodeExporterPort != "9100" {
		t.Fatalf("expected default node exporter port 9100, got %q", cluster.NodeExporterPort)
	}
	if cluster.DCGMExporterPort != "9400" {
		t.Fatalf("expected default dcgm exporter port 9400, got %q", cluster.DCGMExporterPort)
	}
	if cluster.InstanceLabel != "instance" {
		t.Fatalf("expected default instance label, got %q", cluster.InstanceLabel)
	}
	if len(cluster.AggregationNodeLabels) != 2 || cluster.AggregationNodeLabels[0] != "host.name" || cluster.AggregationNodeLabels[1] != "instance" {
		t.Fatalf("expected default aggregation node labels [host.name instance], got %#v", cluster.AggregationNodeLabels)
	}
	if cluster.NodeMatcherMode != "host:port" {
		t.Fatalf("expected default node matcher mode host:port, got %q", cluster.NodeMatcherMode)
	}
}

func TestParseRejectsUnknownConnectionReference(t *testing.T) {
	settingsJSON := map[string]any{
		"connections": []map[string]any{},
		"clusters": []map[string]any{
			{
				"id":               "broken",
				"displayName":      "Broken",
				"connectionId":     "missing",
				"slurmClusterName": "gpu_cluster",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	if _, err := Parse(backend.AppInstanceSettings{JSONData: raw}); err == nil {
		t.Fatalf("expected Parse to fail for unknown connection reference")
	}
}

func TestParseRejectsNonHTTPMetricSifterURL(t *testing.T) {
	settingsJSON := map[string]any{
		"metricsifterServiceUrl": "ftp://metricsifter.internal",
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	if _, err := Parse(backend.AppInstanceSettings{JSONData: raw}); err == nil {
		t.Fatalf("expected Parse to fail for non-http metricsifter URL")
	}
}

func TestParseMetricSifterDefaultParams(t *testing.T) {
	defaults := DefaultMetricSifterParams()
	settingsJSON := map[string]any{
		"metricsifterServiceUrl": "http://metricsifter:8000",
		"metricsifterDefaultParams": map[string]any{
			"searchMethod":           "bottomup",
			"costModel":              "rbf",
			"penalty":                12.5,
			"penaltyAdjust":          3.5,
			"bandwidth":              4.25,
			"segmentSelectionMethod": "max",
			"nJobs":                  -1,
			"withoutSimpleFilter":    true,
		},
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{JSONData: raw})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if cfg.MetricSifterDefaultParams == nil {
		t.Fatalf("expected metricsifter default params to be parsed")
	}
	if cfg.MetricSifterDefaultParams.PenaltyAdjust != 3.5 {
		t.Fatalf("expected penalty adjust 3.5, got %v", cfg.MetricSifterDefaultParams.PenaltyAdjust)
	}
	if cfg.MetricSifterDefaultParams.WithoutSimpleFilter != true {
		t.Fatalf("expected withoutSimpleFilter true")
	}
	if defaults.SearchMethod != "pelt" {
		t.Fatalf("expected default search method pelt, got %q", defaults.SearchMethod)
	}
}
