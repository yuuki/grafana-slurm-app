package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
)

// listClustersJSON runs GET /api/clusters against settings parsed from
// jsonData and returns the raw JSON of each cluster.
func listClustersJSON(t *testing.T, jsonData string) []json.RawMessage {
	t.Helper()
	cfg, err := settings.Parse(backend.AppInstanceSettings{
		JSONData:                []byte(jsonData),
		DecryptedSecureJSONData: map[string]string{"dbPassword": "secret"},
	})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	app := &App{
		settings: cfg,
		catalog: NewCatalogService(cfg, func(cluster settings.ClusterProfile) (JobRepository, error) {
			return &stubJobRepository{}, nil
		}),
	}
	req := httptest.NewRequest(http.MethodGet, "/api/clusters", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: "Viewer", Login: "viewer"}))
	rec := httptest.NewRecorder()
	app.handleListClusters(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	var payload struct {
		Clusters []json.RawMessage `json:"clusters"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	return payload.Clusters
}

const (
	multiClusterSettings = `{"connections":[{"id":"default","dbHost":"db:3306","dbUser":"slurm","securePasswordRef":"dbPassword"}],` +
		`"clusters":[{"id":"cluster-a","displayName":"Cluster A","connectionId":"default","slurmClusterName":"cluster_a","metricsDatasourceUid":"prom-a"%s}]}`
	legacySettings = `{"dbHost":"legacy-db:3306","dbUser":"slurm","clusterName":"legacy_cluster","promDatasourceUid":"prom-legacy"}`
)

// GET /api/clusters is a compatibility contract: the phases key is an
// addition, and a cluster that does not use the feature serves exactly the
// keys it served before, in both settings shapes.
func TestListClustersJSONIsUnchangedWithoutPhaseSettings(t *testing.T) {
	wantKeys := []string{
		"id", "displayName", "slurmClusterName", "metricsDatasourceUid", "metricsType", "aggregationNodeLabels",
		"instanceLabel", "nodeMatcherMode", "defaultTemplateId", "metricsFilterLabel", "metricsFilterValue",
	}
	for name, jsonData := range map[string]string{
		"multi-cluster":                strings.Replace(multiClusterSettings, "%s", "", 1),
		"multi-cluster, empty phases":  strings.Replace(multiClusterSettings, "%s", `,"phases":{}`, 1),
		"multi-cluster, phases off":    strings.Replace(multiClusterSettings, "%s", `,"phases":{"enabled":false}`, 1),
		"legacy single-cluster":        legacySettings,
		"legacy with a stray phases":   strings.Replace(legacySettings, "}", `,"phases":{"enabled":true}}`, 1),
		"multi-cluster, null phases":   strings.Replace(multiClusterSettings, "%s", `,"phases":null`, 1),
		"multi-cluster, empty metrics": strings.Replace(multiClusterSettings, "%s", `,"phases":{"storageWriteMetrics":[]}`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			clusters := listClustersJSON(t, jsonData)
			if len(clusters) != 1 {
				t.Fatalf("expected 1 cluster, got %d", len(clusters))
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(clusters[0], &fields); err != nil {
				t.Fatalf("unmarshal cluster: %v", err)
			}
			if len(fields) != len(wantKeys) {
				t.Fatalf("expected the keys %v, got %s", wantKeys, clusters[0])
			}
			for _, key := range wantKeys {
				if _, ok := fields[key]; !ok {
					t.Fatalf("expected the key %q in %s", key, clusters[0])
				}
			}
		})
	}
}

func TestListClustersServesPhaseSettings(t *testing.T) {
	phases := `,"phases":{"enabled":true,"gpuPowerMetric":"gpu_power_watts","storageWriteMetrics":["node_disk_written_bytes_total","fs_write_bytes_total"],` +
		`"idleGpuUtilizationPercent":0,"stallMinutes":15,"checkpointMinWriteMibPerSecond":2.5}`
	clusters := listClustersJSON(t, strings.Replace(multiClusterSettings, "%s", phases, 1))
	var cluster struct {
		Phases json.RawMessage `json:"phases"`
	}
	if err := json.Unmarshal(clusters[0], &cluster); err != nil {
		t.Fatalf("unmarshal cluster: %v", err)
	}
	// Unset fields (gpuUtilizationMetric) are left out; an explicit 0 is served.
	want := `{"enabled":true,"gpuPowerMetric":"gpu_power_watts","storageWriteMetrics":["node_disk_written_bytes_total","fs_write_bytes_total"],` +
		`"idleGpuUtilizationPercent":0,"stallMinutes":15,"checkpointMinWriteMibPerSecond":2.5}`
	if string(cluster.Phases) != want {
		t.Fatalf("expected phases %s, got %s", want, cluster.Phases)
	}
}

func TestListClustersHidesPhaseSettingsOfInaccessibleClusters(t *testing.T) {
	jsonData := `{"connections":[{"id":"default","dbHost":"db:3306","dbUser":"slurm","securePasswordRef":"dbPassword"}],` +
		`"clusters":[{"id":"cluster-a","displayName":"Cluster A","connectionId":"default","slurmClusterName":"cluster_a","metricsDatasourceUid":"prom-a",` +
		`"phases":{"enabled":true},"accessRule":{"allowedRoles":["Admin"]}}]}`
	if clusters := listClustersJSON(t, jsonData); len(clusters) != 0 {
		t.Fatalf("expected no cluster for a viewer, got %s", clusters)
	}
}
