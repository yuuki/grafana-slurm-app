package settings

import (
	"bytes"
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

// twoClustersWithPhases is the multi-cluster shape with cluster-a, which
// carries the given phases value, and cluster-b with valid phase settings.
func twoClustersWithPhases(t *testing.T, phases any) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"connections": []map[string]any{{"id": "default", "dbHost": "db:3306", "dbUser": "slurm", "securePasswordRef": "dbPassword"}},
		"clusters": []map[string]any{
			{"id": "cluster-a", "connectionId": "default", "slurmClusterName": "cluster_a", "phases": phases},
			{"id": "cluster-b", "connectionId": "default", "slurmClusterName": "cluster_b", "phases": map[string]any{"enabled": true, "stallMinutes": 20}},
		},
	})
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	return raw
}

// An invalid phases block belongs to an optional feature. It turns the
// feature off for its cluster and leaves the reason; it never makes Parse
// fail, which would stop every route of every cluster.
func TestParseTurnsPhasesOffForAClusterWithInvalidPhaseSettings(t *testing.T) {
	tooMany := []string{"a_total", "b_total", "c_total", "d_total", "e_total"}
	cases := map[string]struct {
		phases any
		want   string
	}{
		"power metric with selector":              {map[string]any{"gpuPowerMetric": `power{gpu="0"}`}, "gpuPowerMetric must be a Prometheus metric name"},
		"utilization metric with space":           {map[string]any{"gpuUtilizationMetric": "gpu util"}, "gpuUtilizationMetric must be a Prometheus metric name"},
		"utilization metric with operator":        {map[string]any{"gpuUtilizationMetric": "a or b"}, "gpuUtilizationMetric must be a Prometheus metric name"},
		"metric name that starts with a digit":    {map[string]any{"gpuPowerMetric": "9metric"}, "gpuPowerMetric must be a Prometheus metric name"},
		"storage metric that starts with a digit": {map[string]any{"storageWriteMetrics": []string{"1_total"}}, "storageWriteMetrics must be Prometheus metric names"},
		"metric name too long":                    {map[string]any{"gpuPowerMetric": strings.Repeat("a", 201)}, "gpuPowerMetric must be a Prometheus metric name"},
		"storage metric with selector":            {map[string]any{"storageWriteMetrics": []string{"ok_total", "bad}"}}, "storageWriteMetrics must be Prometheus metric names"},
		"empty storage metric":                    {map[string]any{"storageWriteMetrics": []string{""}}, "storageWriteMetrics must be Prometheus metric names"},
		"too many storage metrics":                {map[string]any{"storageWriteMetrics": tooMany}, "storageWriteMetrics must name at most 4 metrics"},
		"repeated storage metric":                 {map[string]any{"storageWriteMetrics": []string{"a_total", "a_total"}}, "storageWriteMetrics must not repeat a metric"},
		"negative idle threshold":                 {map[string]any{"idleGpuUtilizationPercent": -0.1}, "idleGpuUtilizationPercent must be between 0 and 50"},
		"idle threshold above 50":                 {map[string]any{"idleGpuUtilizationPercent": 50.1}, "idleGpuUtilizationPercent must be between 0 and 50"},
		"stall time of zero":                      {map[string]any{"stallMinutes": 0}, "stallMinutes must be between 1 and 1440"},
		"stall time above a day":                  {map[string]any{"stallMinutes": 1441}, "stallMinutes must be between 1 and 1440"},
		"negative write rate":                     {map[string]any{"checkpointMinWriteMibPerSecond": -1}, "checkpointMinWriteMibPerSecond must be between 0 and 1048576"},
		"invalid while turned off":                {map[string]any{"enabled": false, "stallMinutes": 0}, "stallMinutes must be between 1 and 1440"},
		"invalid while turned on":                 {map[string]any{"enabled": true, "stallMinutes": 0}, "stallMinutes must be between 1 and 1440"},
		"injection while turned on":               {map[string]any{"enabled": true, "gpuUtilizationMetric": "up{} or vector(1)"}, "gpuUtilizationMetric must be a Prometheus metric name"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			cfg, err := parseForTest(t, twoClustersWithPhases(t, tc.phases))
			if err != nil {
				t.Fatalf("Parse must not fail for an invalid phases block, got %v", err)
			}
			broken, other := cfg.Clusters[0], cfg.Clusters[1]
			if broken.Phases != nil {
				t.Fatalf("expected the invalid phases block to be dropped, got %+v", broken.Phases)
			}
			if want := "phases " + tc.want; broken.PhasesError != want {
				t.Fatalf("expected reason %q, got %q", want, broken.PhasesError)
			}
			enabled, _ := tc.phases.(map[string]any)["enabled"].(bool)
			if broken.PhasesWanted != enabled {
				t.Fatalf("expected PhasesWanted %v, got %v", enabled, broken.PhasesWanted)
			}
			if other.Phases == nil || !other.Phases.Enabled || other.Phases.StallMinutes == nil || *other.Phases.StallMinutes != 20 || other.PhasesError != "" {
				t.Fatalf("expected the other cluster to keep its phase settings, got %+v (%q)", other.Phases, other.PhasesError)
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

// A value of the wrong type in the phases block must not make the settings
// of the whole plugin unreadable either.
func TestParseTurnsPhasesOffForPhaseSettingsOfTheWrongType(t *testing.T) {
	cases := map[string]struct {
		phases any
		want   string
		wanted bool
	}{
		"enabled as text":        {map[string]any{"enabled": "yes"}, "phases enabled has the wrong type (string)", true},
		"enabled as a number":    {map[string]any{"enabled": 1}, "phases enabled has the wrong type (number)", true},
		"threshold as text":      {map[string]any{"stallMinutes": "10"}, "phases stallMinutes has the wrong type (string)", false},
		"threshold as text, on":  {map[string]any{"enabled": true, "stallMinutes": "10"}, "phases stallMinutes has the wrong type (string)", true},
		"threshold as text, off": {map[string]any{"enabled": false, "stallMinutes": "10"}, "phases stallMinutes has the wrong type (string)", false},
		"storage metrics as one": {map[string]any{"storageWriteMetrics": "node_disk_written_bytes_total"}, "phases storageWriteMetrics has the wrong type (string)", false},
		"phases as a list":       {[]string{"enabled"}, "phases must be an object", false},
		"phases as text":         {"on", "phases must be an object", false},
		"phases as a number":     {5, "phases must be an object", false},
		"phases as true":         {true, "phases must be an object", false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			cfg, err := parseForTest(t, twoClustersWithPhases(t, tc.phases))
			if err != nil {
				t.Fatalf("Parse must not fail for a phases block of the wrong type, got %v", err)
			}
			broken, other := cfg.Clusters[0], cfg.Clusters[1]
			if broken.Phases != nil || broken.PhasesError != tc.want || broken.PhasesWanted != tc.wanted {
				t.Fatalf("expected no phases, reason %q, wanted %v; got %+v, %q, %v", tc.want, tc.wanted, broken.Phases, broken.PhasesError, broken.PhasesWanted)
			}
			if other.Phases == nil || !other.Phases.Enabled || other.PhasesError != "" {
				t.Fatalf("expected the other cluster to keep its phase settings, got %+v (%q)", other.Phases, other.PhasesError)
			}
		})
	}
}

// A cluster whose phases key is null, absent or valid has no error.
func TestParseSetsNoPhasesErrorForValidOrAbsentPhaseSettings(t *testing.T) {
	for name, raw := range map[string][]byte{
		"absent":  multiClusterWithPhases(t, nil),
		"empty":   multiClusterWithPhases(t, map[string]any{}),
		"enabled": multiClusterWithPhases(t, map[string]any{"enabled": true}),
		"null":    []byte(`{"connections":[{"id":"default","dbHost":"db:3306","dbUser":"slurm"}],"clusters":[{"id":"cluster-a","connectionId":"default","slurmClusterName":"cluster_a","phases":null}]}`),
		"legacy":  []byte(`{"dbHost":"legacy-db:3306","dbUser":"slurm","clusterName":"legacy_cluster","promDatasourceUid":"prom-legacy","phases":{"stallMinutes":-1}}`),
	} {
		t.Run(name, func(t *testing.T) {
			cfg, err := parseForTest(t, raw)
			if err != nil {
				t.Fatalf("Parse returned error: %v", err)
			}
			if cfg.Clusters[0].PhasesError != "" || cfg.Clusters[0].PhasesWanted {
				t.Fatalf("expected no phases error, got %q (wanted %v)", cfg.Clusters[0].PhasesError, cfg.Clusters[0].PhasesWanted)
			}
		})
	}
}

// "enabled: true" alone is a setting, not an empty block: it must reach the
// frontend, or the feature could not be turned on with the defaults.
func TestParseKeepsPhaseSettingsThatOnlyEnableTheFeature(t *testing.T) {
	cfg, err := parseForTest(t, multiClusterWithPhases(t, map[string]any{"enabled": true}))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	phases := cfg.Clusters[0].Phases
	if phases == nil || !phases.Enabled {
		t.Fatalf("expected enabled phase settings, got %+v", phases)
	}
	if (&PhaseSettings{Enabled: true}).isZero() {
		t.Fatal("phase settings that enable the feature are not zero")
	}
	out, err := json.Marshal(phases)
	if err != nil || string(out) != `{"enabled":true}` {
		t.Fatalf("expected {\"enabled\":true}, got %s (%v)", out, err)
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
		if err := cluster.Phases.problem(); err != nil {
			t.Fatalf("Parse(%q): cluster %q keeps invalid phases settings: %v", jsonData, cluster.ID, err)
		}
		if cluster.PhasesError != "" {
			t.Fatalf("Parse(%q): cluster %q keeps phases settings and a phases error %q", jsonData, cluster.ID, cluster.PhasesError)
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

// checkPhasesDoNotFailParse is called by FuzzParse for settings that Parse
// rejects: the phases blocks are never the reason. The same settings without
// any phases key must be rejected too.
func checkPhasesDoNotFailParse(t *testing.T, jsonData []byte) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(jsonData))
	decoder.UseNumber()
	var root map[string]any
	if err := decoder.Decode(&root); err != nil {
		return
	}
	clusters, ok := root["clusters"].([]any)
	if !ok {
		return
	}
	removed := false
	for _, item := range clusters {
		if cluster, ok := item.(map[string]any); ok {
			if _, has := cluster["phases"]; has {
				delete(cluster, "phases")
				removed = true
			}
		}
	}
	if !removed {
		return
	}
	without, err := json.Marshal(root)
	if err != nil {
		return
	}
	if _, err := Parse(backend.AppInstanceSettings{JSONData: without, DecryptedSecureJSONData: map[string]string{"dbPassword": "s", "shared": "s"}}); err == nil {
		t.Fatalf("Parse(%q) fails, and succeeds without the phases keys (%q): a phases block made the settings unusable", jsonData, without)
	}
}
