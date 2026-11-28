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

// "enabled: true" alone must reach the frontend: it turns the feature on
// with the defaults.
func TestListClustersServesPhaseSettingsThatOnlyEnableTheFeature(t *testing.T) {
	clusters := listClustersJSON(t, strings.Replace(multiClusterSettings, "%s", `,"phases":{"enabled":true}`, 1))
	var cluster struct {
		Phases json.RawMessage `json:"phases"`
	}
	if err := json.Unmarshal(clusters[0], &cluster); err != nil {
		t.Fatalf("unmarshal cluster: %v", err)
	}
	if string(cluster.Phases) != `{"enabled":true}` {
		t.Fatalf("expected phases {\"enabled\":true}, got %s", cluster.Phases)
	}
}

// An invalid phases block turns the feature off for its cluster. The other
// clusters, and every other key of the cluster, are served as before. The
// reason is served only when the block asked for the feature.
func TestListClustersKeepsWorkingWithInvalidPhaseSettings(t *testing.T) {
	const template = `{"connections":[{"id":"default","dbHost":"db:3306","dbUser":"slurm","securePasswordRef":"dbPassword"}],` +
		`"clusters":[{"id":"cluster-a","displayName":"Cluster A","connectionId":"default","slurmClusterName":"cluster_a","metricsDatasourceUid":"prom-a","phases":%s},` +
		`{"id":"cluster-b","displayName":"Cluster B","connectionId":"default","slurmClusterName":"cluster_b","metricsDatasourceUid":"prom-b","phases":{"enabled":true}}]}`
	reference := listClustersJSON(t, strings.Replace(multiClusterSettings, "%s", "", 1))[0]
	cases := map[string]struct {
		phases    string
		wantError string
	}{
		"invalid value, feature not asked for": {`{"stallMinutes":0}`, ""},
		"invalid value, feature turned off":    {`{"enabled":false,"stallMinutes":0}`, ""},
		"invalid value, feature asked for":     {`{"enabled":true,"stallMinutes":0}`, "phases stallMinutes must be between 1 and 1440"},
		"metric name that is a query":          {`{"enabled":true,"gpuUtilizationMetric":"up{} or vector(1)"}`, "phases gpuUtilizationMetric must be a Prometheus metric name"},
		"enabled of the wrong type":            {`{"enabled":"yes"}`, "phases enabled has the wrong type (string)"},
		"phases of the wrong type":             {`"on"`, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			clusters := listClustersJSON(t, strings.Replace(template, "%s", tc.phases, 1))
			if len(clusters) != 2 {
				t.Fatalf("expected both clusters, got %d", len(clusters))
			}
			var broken map[string]json.RawMessage
			if err := json.Unmarshal(clusters[0], &broken); err != nil {
				t.Fatalf("unmarshal cluster: %v", err)
			}
			if _, ok := broken["phases"]; ok {
				t.Fatalf("expected no phases for the cluster with invalid settings, got %s", broken["phases"])
			}
			var gotError string
			if raw, ok := broken["phasesError"]; ok {
				if err := json.Unmarshal(raw, &gotError); err != nil {
					t.Fatalf("unmarshal phasesError: %v", err)
				}
			}
			if gotError != tc.wantError {
				t.Fatalf("expected phasesError %q, got %q", tc.wantError, gotError)
			}
			if tc.wantError == "" && string(clusters[0]) != string(reference) {
				t.Fatalf("expected the cluster to be served as without phase settings:\n got  %s\n want %s", clusters[0], reference)
			}
			var other struct {
				ID     string          `json:"id"`
				Phases json.RawMessage `json:"phases"`
			}
			if err := json.Unmarshal(clusters[1], &other); err != nil || other.ID != "cluster-b" || string(other.Phases) != `{"enabled":true}` {
				t.Fatalf("expected cluster-b with its phase settings, got %s (%v)", clusters[1], err)
			}
		})
	}
}
