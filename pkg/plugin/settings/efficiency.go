package settings

import (
	"fmt"
	"math"
	"regexp"
)

// EfficiencySettings are the optional per-cluster settings of the job
// efficiency scorecard. The backend only stores, validates and serves them:
// the frontend builds the scorecard's PromQL, because only the frontend can
// reach the metrics datasource (through Grafana's datasource proxy).
//
// An absent object, an empty string or a nil threshold selects the default,
// which the frontend owns (src/pages/JobDashboard/efficiency/settings.ts) and
// which matches the NVIDIA DCGM exporter. The thresholds are pointers so
// that an explicit 0 is a value and not "use the default".
type EfficiencySettings struct {
	// GPUUtilizationMetric is the per-GPU utilization gauge, in percent.
	GPUUtilizationMetric string `json:"gpuUtilizationMetric,omitempty"`
	// GPUMemoryUsedMetric and GPUMemoryFreeMetric are the per-GPU memory
	// gauges, in MiB. A GPU's capacity is the sum of the two.
	GPUMemoryUsedMetric string `json:"gpuMemoryUsedMetric,omitempty"`
	GPUMemoryFreeMetric string `json:"gpuMemoryFreeMetric,omitempty"`
	// GPUIDLabel is the label that tells the GPUs of one node apart.
	GPUIDLabel string `json:"gpuIdLabel,omitempty"`
	// IdleGPUUtilizationPercent is the idle baseline: a GPU is active in a
	// time bucket when its utilization exceeds this value.
	IdleGPUUtilizationPercent *float64 `json:"idleGpuUtilizationPercent,omitempty"`
	// LowGPUMemoryPercent flags a job whose fullest GPU stayed below this
	// share of its memory capacity.
	LowGPUMemoryPercent *float64 `json:"lowGpuMemoryPercent,omitempty"`
}

var (
	// The frontend puts these names into PromQL without quoting, so only the
	// classic Prometheus metric name characters are accepted.
	efficiencyMetricNamePattern = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)
	// Dots are accepted like in the other label settings (host.name); the
	// frontend quotes such a name for Prometheus.
	efficiencyLabelNamePattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.]*$`)
)

func (e *EfficiencySettings) isZero() bool {
	return e == nil || *e == EfficiencySettings{}
}

// Validate checks the fields that are set; unset fields select the default.
func (e *EfficiencySettings) Validate() error {
	if e == nil {
		return nil
	}
	metrics := []struct{ key, value string }{
		{"gpuUtilizationMetric", e.GPUUtilizationMetric},
		{"gpuMemoryUsedMetric", e.GPUMemoryUsedMetric},
		{"gpuMemoryFreeMetric", e.GPUMemoryFreeMetric},
	}
	for _, metric := range metrics {
		if metric.value != "" && !efficiencyMetricNamePattern.MatchString(metric.value) {
			return fmt.Errorf("efficiency %s must be a Prometheus metric name", metric.key)
		}
	}
	if e.GPUIDLabel != "" && !efficiencyLabelNamePattern.MatchString(e.GPUIDLabel) {
		return fmt.Errorf("efficiency gpuIdLabel must be a Prometheus label name")
	}
	thresholds := []struct {
		key   string
		value *float64
	}{
		{"idleGpuUtilizationPercent", e.IdleGPUUtilizationPercent},
		{"lowGpuMemoryPercent", e.LowGPUMemoryPercent},
	}
	for _, threshold := range thresholds {
		if threshold.value == nil {
			continue
		}
		if v := *threshold.value; math.IsNaN(v) || v < 0 || v > 100 {
			return fmt.Errorf("efficiency %s must be between 0 and 100", threshold.key)
		}
	}
	return nil
}
