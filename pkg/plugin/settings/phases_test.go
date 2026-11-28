package settings

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// multiClusterWithPhases is the multi-cluster settings shape with one
// cluster that carries the given phases object (nil for none).
func multiClusterWithPhases(t *testing.T, phases any) []byte {
	t.Helper()
	cluster := map[string]any{
		"id":                   "cluster-a",
		"displayName":          "Cluster A",
		"connectionId":         "default",
		"slurmClusterName":     "cluster_a",
		"metricsDatasourceUid": "prom-a",
	}
	if phases != nil {
		cluster["phases"] = phases
	}
	raw, err := json.Marshal(map[string]any{
		"connections": []map[string]any{{"id": "default", "dbHost": "db:3306", "dbUser": "slurm", "securePasswordRef": "dbPassword"}},
		"clusters":    []map[string]any{cluster},
	})
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	return raw
}

func parseForTest(t *testing.T, raw []byte) (*Settings, error) {
	t.Helper()
	return Parse(backend.AppInstanceSettings{
		JSONData:                raw,
		DecryptedSecureJSONData: map[string]string{"dbPassword": "secret"},
	})
}

func TestParsePhaseSettingsMultiCluster(t *testing.T) {
	raw := multiClusterWithPhases(t, map[string]any{
		"enabled":                        true,
		"gpuPowerMetric":                 "nvidia_smi_power_draw_watts",
		"gpuUtilizationMetric":           "nvidia_smi_utilization_gpu_ratio",
		"storageWriteMetrics":            []string{"node_disk_written_bytes_total", "lustre:write_bytes_total"},
		"idleGpuUtilizationPercent":      0,
		"stallMinutes":                   30,
		"checkpointMinWriteMibPerSecond": 0.5,
	})
	cfg, err := parseForTest(t, raw)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	phases := cfg.Clusters[0].Phases
	if phases == nil {
		t.Fatal("expected the phases settings to be kept")
	}
	if !phases.Enabled || phases.GPUPowerMetric != "nvidia_smi_power_draw_watts" || phases.GPUUtilizationMetric != "nvidia_smi_utilization_gpu_ratio" {
		t.Fatalf("unexpected phases settings: %+v", phases)
	}
	if len(phases.StorageWriteMetrics) != 2 || phases.StorageWriteMetrics[1] != "lustre:write_bytes_total" {
		t.Fatalf("unexpected storage write metrics: %v", phases.StorageWriteMetrics)
	}
	// An explicit 0 is a value, not "use the default".
	if phases.IdleGPUUtilizationPercent == nil || *phases.IdleGPUUtilizationPercent != 0 {
		t.Fatalf("expected idleGpuUtilizationPercent 0, got %v", phases.IdleGPUUtilizationPercent)
	}
	if phases.StallMinutes == nil || *phases.StallMinutes != 30 {
		t.Fatalf("expected stallMinutes 30, got %v", phases.StallMinutes)
	}
	if phases.CheckpointMinWriteMiBPerSecond == nil || *phases.CheckpointMinWriteMiBPerSecond != 0.5 {
		t.Fatalf("expected checkpointMinWriteMibPerSecond 0.5, got %v", phases.CheckpointMinWriteMiBPerSecond)
	}
}

func TestParseKeepsNoPhaseSettingsForAClusterThatDoesNotUseThem(t *testing.T) {
	for name, phases := range map[string]any{
		"no key":           nil,
		"empty object":     map[string]any{},
		"enabled false":    map[string]any{"enabled": false},
		"empty fields":     map[string]any{"gpuPowerMetric": "", "storageWriteMetrics": []string{}},
		"null thresholds":  map[string]any{"stallMinutes": nil},
		"explicit default": map[string]any{"enabled": false, "gpuUtilizationMetric": ""},
	} {
		t.Run(name, func(t *testing.T) {
			cfg, err := parseForTest(t, multiClusterWithPhases(t, phases))
			if err != nil {
				t.Fatalf("Parse returned error: %v", err)
			}
			if cfg.Clusters[0].Phases != nil {
				t.Fatalf("expected no phases settings, got %+v", cfg.Clusters[0].Phases)
			}
		})
	}
}

func TestParseKeepsPhaseSettingsThatAreTurnedOffButConfigured(t *testing.T) {
	cfg, err := parseForTest(t, multiClusterWithPhases(t, map[string]any{"enabled": false, "stallMinutes": 20}))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	phases := cfg.Clusters[0].Phases
	if phases == nil || phases.Enabled || phases.StallMinutes == nil || *phases.StallMinutes != 20 {
		t.Fatalf("expected the configured settings to be kept while off, got %+v", phases)
	}
}

// The legacy single-cluster shape has no place for the phases settings: the
// migrated cluster does not use the feature, whatever else the payload holds.
func TestParseLegacySingleClusterHasNoPhaseSettings(t *testing.T) {
	for name, raw := range map[string]string{
		"legacy":                     `{"dbHost":"legacy-db:3306","dbUser":"slurm","clusterName":"legacy_cluster","promDatasourceUid":"prom-legacy"}`,
		"legacy with stray phases":   `{"dbHost":"legacy-db:3306","dbUser":"slurm","clusterName":"legacy_cluster","promDatasourceUid":"prom-legacy","phases":{"enabled":true}}`,
		"legacy with invalid phases": `{"dbHost":"legacy-db:3306","dbUser":"slurm","clusterName":"legacy_cluster","phases":{"stallMinutes":-1}}`,
	} {
		t.Run(name, func(t *testing.T) {
			cfg, err := parseForTest(t, []byte(raw))
			if err != nil {
				t.Fatalf("Parse returned error: %v", err)
			}
			if len(cfg.Clusters) != 1 || cfg.Clusters[0].ID != "legacy_cluster" {
				t.Fatalf("expected the migrated legacy cluster, got %+v", cfg.Clusters)
			}
			if cfg.Clusters[0].Phases != nil {
				t.Fatalf("expected no phases settings on the migrated cluster, got %+v", cfg.Clusters[0].Phases)
			}
		})
	}
}

func TestParseRejectsInvalidPhaseSettings(t *testing.T) {
	tooMany := []string{"a_total", "b_total", "c_total", "d_total", "e_total"}
	cases := map[string]struct {
		phases any
		want   string
	}{
		"power metric with selector":       {map[string]any{"gpuPowerMetric": `power{gpu="0"}`}, "gpuPowerMetric must be a Prometheus metric name"},
		"utilization metric with space":    {map[string]any{"gpuUtilizationMetric": "gpu util"}, "gpuUtilizationMetric must be a Prometheus metric name"},
		"utilization metric with operator": {map[string]any{"gpuUtilizationMetric": "a or b"}, "gpuUtilizationMetric must be a Prometheus metric name"},
		"metric name too long":             {map[string]any{"gpuPowerMetric": strings.Repeat("a", 201)}, "gpuPowerMetric must be a Prometheus metric name"},
		"storage metric with selector":     {map[string]any{"storageWriteMetrics": []string{"ok_total", "bad}"}}, "storageWriteMetrics must be Prometheus metric names"},
		"empty storage metric":             {map[string]any{"storageWriteMetrics": []string{""}}, "storageWriteMetrics must be Prometheus metric names"},
		"too many storage metrics":         {map[string]any{"storageWriteMetrics": tooMany}, "storageWriteMetrics must name at most 4 metrics"},
		"repeated storage metric":          {map[string]any{"storageWriteMetrics": []string{"a_total", "a_total"}}, "storageWriteMetrics must not repeat a metric"},
		"negative idle threshold":          {map[string]any{"idleGpuUtilizationPercent": -0.1}, "idleGpuUtilizationPercent must be between 0 and 50"},
		"idle threshold above 50":          {map[string]any{"idleGpuUtilizationPercent": 50.1}, "idleGpuUtilizationPercent must be between 0 and 50"},
		"stall time of zero":               {map[string]any{"stallMinutes": 0}, "stallMinutes must be between 1 and 1440"},
		"stall time above a day":           {map[string]any{"stallMinutes": 1441}, "stallMinutes must be between 1 and 1440"},
		"negative write rate":              {map[string]any{"checkpointMinWriteMibPerSecond": -1}, "checkpointMinWriteMibPerSecond must be between 0 and 1.048576e+06"},
		"invalid while turned off":         {map[string]any{"enabled": false, "stallMinutes": 0}, "stallMinutes must be between 1 and 1440"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parseForTest(t, multiClusterWithPhases(t, tc.phases))
			if err == nil {
				t.Fatal("expected Parse to reject the settings")
			}
			if want := "cluster cluster-a: phases " + tc.want; err.Error() != want {
				t.Fatalf("expected error %q, got %q", want, err.Error())
			}
		})
	}
}

func TestParseAcceptsPhaseSettingsAtTheirLimits(t *testing.T) {
	for name, phases := range map[string]any{
		"lowest":  map[string]any{"idleGpuUtilizationPercent": 0, "stallMinutes": 1, "checkpointMinWriteMibPerSecond": 0},
		"highest": map[string]any{"idleGpuUtilizationPercent": 50, "stallMinutes": 1440, "checkpointMinWriteMibPerSecond": 1048576},
		"names":   map[string]any{"gpuPowerMetric": "_a:b_9", "storageWriteMetrics": []string{"a", "b", "c", strings.Repeat("d", 200)}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseForTest(t, multiClusterWithPhases(t, phases)); err != nil {
				t.Fatalf("Parse returned error: %v", err)
			}
		})
	}
}

func TestParseRejectsPhaseSettingsOfTheWrongType(t *testing.T) {
	for name, phases := range map[string]any{
		"enabled as text":        map[string]any{"enabled": "yes"},
		"threshold as text":      map[string]any{"stallMinutes": "10"},
		"storage metrics as one": map[string]any{"storageWriteMetrics": "node_disk_written_bytes_total"},
		"phases as a list":       []string{"enabled"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseForTest(t, multiClusterWithPhases(t, phases)); err == nil {
				t.Fatal("expected Parse to reject the settings")
			}
		})
	}
}

// Settings without the phases key must serialize exactly as before the key
// existed, in both settings shapes.
func TestClusterProfileJSONHasNoPhasesKeyByDefault(t *testing.T) {
	for name, raw := range map[string][]byte{
		"multi-cluster": multiClusterWithPhases(t, nil),
		"legacy":        []byte(`{"dbHost":"legacy-db:3306","dbUser":"slurm","clusterName":"legacy_cluster","promDatasourceUid":"prom-legacy"}`),
	} {
		t.Run(name, func(t *testing.T) {
			cfg, err := parseForTest(t, raw)
			if err != nil {
				t.Fatalf("Parse returned error: %v", err)
			}
			out, err := json.Marshal(cfg.Clusters[0])
			if err != nil {
				t.Fatalf("marshal cluster: %v", err)
			}
			if strings.Contains(string(out), "phases") {
				t.Fatalf("expected no phases key, got %s", out)
			}
		})
	}
}

func TestPhaseSettingsValidateNil(t *testing.T) {
	var phases *PhaseSettings
	if err := phases.Validate(); err != nil {
		t.Fatalf("expected nil settings to be valid, got %v", err)
	}
	if !phases.isZero() {
		t.Fatal("expected nil settings to be zero")
	}
}

// checkPhaseSettings is called by FuzzParse: accepted settings never keep an
// empty phases object, never keep an invalid one, and the migrated legacy
// cluster never has one.
func checkPhaseSettings(t *testing.T, jsonData []byte, s *Settings) {
	t.Helper()
	for _, cluster := range s.Clusters {
		if cluster.Phases == nil {
			continue
		}
		if cluster.Phases.isZero() {
			t.Fatalf("Parse(%q): cluster %q keeps an empty phases object", jsonData, cluster.ID)
		}
		if err := cluster.Phases.Validate(); err != nil {
			t.Fatalf("Parse(%q): cluster %q keeps invalid phases settings: %v", jsonData, cluster.ID, err)
		}
		for _, name := range append([]string{cluster.Phases.GPUPowerMetric, cluster.Phases.GPUUtilizationMetric}, cluster.Phases.StorageWriteMetrics...) {
			if strings.ContainsAny(name, "{}()[]\"' \t\n,=~!+-*/\\") {
				t.Fatalf("Parse(%q): cluster %q keeps a metric name that is not a plain name: %q", jsonData, cluster.ID, name)
			}
		}
	}
	var raw Settings
	if len(jsonData) > 0 && json.Unmarshal(jsonData, &raw) == nil && len(raw.Clusters) == 0 && len(s.Clusters) == 1 && s.Clusters[0].Phases != nil {
		t.Fatalf("Parse(%q): the migrated legacy cluster has phases settings %+v", jsonData, s.Clusters[0].Phases)
	}
}
