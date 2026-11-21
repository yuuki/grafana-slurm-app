package settings

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func floatPtr(v float64) *float64 { return &v }

// multiClusterSettings returns the multi-cluster settings shape with one
// cluster whose "efficiency" object is efficiency (omitted when nil).
func multiClusterSettings(t *testing.T, efficiency map[string]any) []byte {
	t.Helper()
	cluster := map[string]any{
		"id":                   "a100",
		"displayName":          "A100 Cluster",
		"connectionId":         "default",
		"slurmClusterName":     "gpu_cluster",
		"metricsDatasourceUid": "prom-main",
	}
	if efficiency != nil {
		cluster["efficiency"] = efficiency
	}
	raw, err := json.Marshal(map[string]any{
		"connections": []map[string]any{
			{"id": "default", "dbHost": "mysql:3306", "dbUser": "slurm", "securePasswordRef": "dbPassword"},
		},
		"clusters": []map[string]any{cluster},
	})
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	return raw
}

func TestParseEfficiencySettingsMultiCluster(t *testing.T) {
	raw := multiClusterSettings(t, map[string]any{
		"gpuUtilizationMetric":      "nvidia_gpu_utilization",
		"gpuMemoryUsedMetric":       "nvidia_gpu_memory_used_mib",
		"gpuMemoryFreeMetric":       "site:gpu_memory_free_mib",
		"gpuIdLabel":                "gpu.index",
		"idleGpuUtilizationPercent": 0,
		"lowGpuMemoryPercent":       25.5,
	})

	cfg, err := Parse(backend.AppInstanceSettings{JSONData: raw})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	got := cfg.Clusters[0].Efficiency
	if got == nil {
		t.Fatalf("expected efficiency settings to be parsed")
	}
	if got.GPUUtilizationMetric != "nvidia_gpu_utilization" ||
		got.GPUMemoryUsedMetric != "nvidia_gpu_memory_used_mib" ||
		got.GPUMemoryFreeMetric != "site:gpu_memory_free_mib" ||
		got.GPUIDLabel != "gpu.index" {
		t.Fatalf("unexpected efficiency names: %+v", got)
	}
	// An explicit 0 is a threshold, not "use the default".
	if got.IdleGPUUtilizationPercent == nil || *got.IdleGPUUtilizationPercent != 0 {
		t.Fatalf("expected idleGpuUtilizationPercent 0, got %v", got.IdleGPUUtilizationPercent)
	}
	if got.LowGPUMemoryPercent == nil || *got.LowGPUMemoryPercent != 25.5 {
		t.Fatalf("expected lowGpuMemoryPercent 25.5, got %v", got.LowGPUMemoryPercent)
	}
}

func TestParseEfficiencySettingsAbsentOrEmptyMeansDefaults(t *testing.T) {
	for name, efficiency := range map[string]map[string]any{
		"absent": nil,
		"empty":  {},
		"blank":  {"gpuUtilizationMetric": "", "gpuIdLabel": ""},
	} {
		t.Run(name, func(t *testing.T) {
			cfg, err := Parse(backend.AppInstanceSettings{JSONData: multiClusterSettings(t, efficiency)})
			if err != nil {
				t.Fatalf("Parse returned error: %v", err)
			}
			if cfg.Clusters[0].Efficiency != nil {
				t.Fatalf("expected nil efficiency settings, got %+v", cfg.Clusters[0].Efficiency)
			}
		})
	}
}

// The legacy single-cluster shape has no place for efficiency settings: the
// migrated cluster keeps every default.
func TestParseLegacySingleClusterHasDefaultEfficiency(t *testing.T) {
	raw, err := json.Marshal(map[string]any{
		"dbHost":            "legacy-db:3306",
		"dbUser":            "slurm",
		"clusterName":       "legacy_cluster",
		"promDatasourceUid": "prom-legacy",
		// Not a legacy key: must not leak into the migrated cluster.
		"efficiency": map[string]any{"gpuIdLabel": "minor_number"},
	})
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{
		JSONData:                raw,
		DecryptedSecureJSONData: map[string]string{"dbPassword": "secret"},
	})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if len(cfg.Clusters) != 1 {
		t.Fatalf("expected 1 cluster from legacy migration, got %d", len(cfg.Clusters))
	}
	if cfg.Clusters[0].Efficiency != nil {
		t.Fatalf("expected nil efficiency settings on the legacy cluster, got %+v", cfg.Clusters[0].Efficiency)
	}
}

func TestParseRejectsInvalidEfficiencySettings(t *testing.T) {
	tests := []struct {
		name       string
		efficiency map[string]any
		wantErr    string
	}{
		{name: "metric with selector", efficiency: map[string]any{"gpuUtilizationMetric": `DCGM_FI_DEV_GPU_UTIL{gpu="0"}`}, wantErr: "gpuUtilizationMetric"},
		{name: "metric with space", efficiency: map[string]any{"gpuMemoryUsedMetric": "DCGM FB USED"}, wantErr: "gpuMemoryUsedMetric"},
		{name: "metric starting with digit", efficiency: map[string]any{"gpuMemoryFreeMetric": "1free"}, wantErr: "gpuMemoryFreeMetric"},
		{name: "label with quote", efficiency: map[string]any{"gpuIdLabel": `gpu"`}, wantErr: "gpuIdLabel"},
		{name: "label with comma", efficiency: map[string]any{"gpuIdLabel": "gpu,UUID"}, wantErr: "gpuIdLabel"},
		{name: "negative idle baseline", efficiency: map[string]any{"idleGpuUtilizationPercent": -1}, wantErr: "idleGpuUtilizationPercent"},
		{name: "idle baseline above 100", efficiency: map[string]any{"idleGpuUtilizationPercent": 100.5}, wantErr: "idleGpuUtilizationPercent"},
		{name: "memory threshold above 100", efficiency: map[string]any{"lowGpuMemoryPercent": 101}, wantErr: "lowGpuMemoryPercent"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse(backend.AppInstanceSettings{JSONData: multiClusterSettings(t, tt.efficiency)})
			if err == nil {
				t.Fatalf("expected Parse to fail")
			}
			if !strings.Contains(err.Error(), tt.wantErr) || !strings.Contains(err.Error(), "cluster a100") {
				t.Fatalf("expected error naming cluster a100 and %s, got %v", tt.wantErr, err)
			}
		})
	}
}

func TestEfficiencySettingsValidate(t *testing.T) {
	var unset *EfficiencySettings
	if err := unset.Validate(); err != nil {
		t.Fatalf("nil settings must be valid, got %v", err)
	}
	if err := (&EfficiencySettings{}).Validate(); err != nil {
		t.Fatalf("empty settings must be valid, got %v", err)
	}
	boundaries := &EfficiencySettings{
		IdleGPUUtilizationPercent: floatPtr(0),
		LowGPUMemoryPercent:       floatPtr(100),
	}
	if err := boundaries.Validate(); err != nil {
		t.Fatalf("0 and 100 must be valid thresholds, got %v", err)
	}
	// JSON cannot carry NaN, but a caller building the struct could.
	if err := (&EfficiencySettings{LowGPUMemoryPercent: floatPtr(math.NaN())}).Validate(); err == nil {
		t.Fatalf("expected NaN threshold to be rejected")
	}
}

// The served JSON keeps an explicit 0 and omits what is unset, so the
// frontend can tell "0" from "default".
func TestParseEfficiencyDisabled(t *testing.T) {
	cfg, err := Parse(backend.AppInstanceSettings{JSONData: multiClusterSettings(t, map[string]any{"disabled": true})})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	got := cfg.Clusters[0].Efficiency
	if got == nil || !got.Disabled {
		t.Fatalf("expected efficiency to be disabled, got %+v", got)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(raw) != `{"disabled":true}` {
		t.Fatalf("unexpected JSON: %s", raw)
	}

	// "disabled": false is the default and leaves no efficiency object.
	cfg, err = Parse(backend.AppInstanceSettings{JSONData: multiClusterSettings(t, map[string]any{"disabled": false})})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if cfg.Clusters[0].Efficiency != nil {
		t.Fatalf("expected no efficiency settings, got %+v", cfg.Clusters[0].Efficiency)
	}
}

func TestEfficiencySettingsJSONOmitsUnsetFields(t *testing.T) {
	in := &EfficiencySettings{GPUIDLabel: "gpu", IdleGPUUtilizationPercent: floatPtr(0)}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(raw) != `{"gpuIdLabel":"gpu","idleGpuUtilizationPercent":0}` {
		t.Fatalf("unexpected JSON: %s", raw)
	}
}
