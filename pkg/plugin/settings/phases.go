package settings

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
)

// PhaseSettings are the optional per-cluster settings of the job phase
// segmentation on the Job Dashboard. The backend only stores, validates and
// serves them: the frontend builds the queries and segments the timeline,
// because only the frontend can reach the metrics datasource (through
// Grafana's datasource proxy).
//
// The feature is off unless Enabled is true, so a cluster whose settings do
// not name it sends no query and shows nothing new. An absent object, an
// empty string, an empty list or a nil threshold selects the default, which
// the frontend owns (src/pages/JobDashboard/phases/settings.ts) and which
// matches the NVIDIA DCGM exporter and node_exporter. The thresholds are
// pointers so that an explicit 0 is a value and not "use the default".
type PhaseSettings struct {
	// Enabled turns the phase segmentation on for the cluster.
	Enabled bool `json:"enabled,omitempty"`
	// GPUPowerMetric is the per-GPU power gauge, in any unit.
	GPUPowerMetric string `json:"gpuPowerMetric,omitempty"`
	// GPUUtilizationMetric is the per-GPU utilization gauge, in percent.
	GPUUtilizationMetric string `json:"gpuUtilizationMetric,omitempty"`
	// StorageWriteMetrics are counters of bytes written; their rates are
	// added. A checkpoint is reported only where they show a write burst.
	StorageWriteMetrics []string `json:"storageWriteMetrics,omitempty"`
	// IdleGPUUtilizationPercent is the idle baseline: a GPU is idle in a
	// time bucket when none of its utilization samples exceeds this value.
	IdleGPUUtilizationPercent *float64 `json:"idleGpuUtilizationPercent,omitempty"`
	// StallMinutes is how long every GPU of the job must stay idle, after
	// the job computed, for the stretch to be reported as stalled.
	StallMinutes *float64 `json:"stallMinutes,omitempty"`
	// CheckpointMinWriteMiBPerSecond is the smallest write rate of one node
	// that counts as a write burst.
	CheckpointMinWriteMiBPerSecond *float64 `json:"checkpointMinWriteMibPerSecond,omitempty"`

	// decodeError is set when the stored block could not be read (a value of
	// the wrong type); the other fields are then empty.
	decodeError string
	// decodeWanted is set when a block that could not be read asks for the
	// feature: its enabled key is anything but false.
	decodeWanted bool
}

// UnmarshalJSON reads the phases block. It never returns an error: the block
// belongs to an optional feature that is off by default, and a value of the
// wrong type in it must not make the settings of the whole plugin
// unreadable. A block that cannot be read is remembered as invalid, and
// ClusterProfile.Defaults drops it for that cluster alone.
func (p *PhaseSettings) UnmarshalJSON(data []byte) error {
	type plain PhaseSettings
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		*p = PhaseSettings{decodeError: describePhasesDecodeError(err), decodeWanted: phasesBlockWanted(data)}
		return nil
	}
	*p = PhaseSettings(decoded)
	return nil
}

func describePhasesDecodeError(err error) string {
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) && typeErr.Field != "" {
		return fmt.Sprintf("phases %s has the wrong type (%s)", typeErr.Field, typeErr.Value)
	}
	return "phases must be an object"
}

// phasesBlockWanted reports whether a block asks for the feature, without
// relying on the types of its values: it has an enabled key that is neither
// false nor null.
func phasesBlockWanted(data []byte) bool {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return false
	}
	raw, ok := keys["enabled"]
	if !ok {
		return false
	}
	value := string(bytes.TrimSpace(raw))
	return value != "false" && value != "null"
}

// problem is the reason why the block cannot be used; nil for a valid block.
func (p *PhaseSettings) problem() error {
	if p == nil {
		return nil
	}
	if p.decodeError != "" {
		return errors.New(p.decodeError)
	}
	return p.Validate()
}

const (
	// maxPhaseStorageWriteMetrics bounds the list that goes into one query.
	maxPhaseStorageWriteMetrics = 4
	// maxPhaseMetricNameLength keeps a query that names every metric short.
	maxPhaseMetricNameLength = 200
	// maxPhaseIdleGPUUtilizationPercent: the working level of a job must be
	// at least twice the idle baseline, and utilization ends at 100.
	maxPhaseIdleGPUUtilizationPercent = 50
	minPhaseStallMinutes              = 1
	maxPhaseStallMinutes              = 24 * 60
	maxPhaseCheckpointMinWriteMiB     = 1024 * 1024
)

// The frontend puts these names into PromQL without quoting, so only the
// classic Prometheus metric name characters are accepted.
var phaseMetricNamePattern = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)

func (p *PhaseSettings) isZero() bool {
	return p == nil ||
		(!p.Enabled &&
			p.GPUPowerMetric == "" &&
			p.GPUUtilizationMetric == "" &&
			len(p.StorageWriteMetrics) == 0 &&
			p.IdleGPUUtilizationPercent == nil &&
			p.StallMinutes == nil &&
			p.CheckpointMinWriteMiBPerSecond == nil)
}

func validPhaseMetricName(name string) bool {
	return len(name) <= maxPhaseMetricNameLength && phaseMetricNamePattern.MatchString(name)
}

// Validate checks the fields that are set; unset fields select the default.
func (p *PhaseSettings) Validate() error {
	if p == nil {
		return nil
	}
	if err := p.validateMetricNames(); err != nil {
		return err
	}
	ranges := []struct {
		key      string
		value    *float64
		min, max float64
	}{
		{"idleGpuUtilizationPercent", p.IdleGPUUtilizationPercent, 0, maxPhaseIdleGPUUtilizationPercent},
		{"stallMinutes", p.StallMinutes, minPhaseStallMinutes, maxPhaseStallMinutes},
		{"checkpointMinWriteMibPerSecond", p.CheckpointMinWriteMiBPerSecond, 0, maxPhaseCheckpointMinWriteMiB},
	}
	for _, r := range ranges {
		if r.value == nil {
			continue
		}
		if v := *r.value; math.IsNaN(v) || v < r.min || v > r.max {
			return fmt.Errorf("phases %s must be between %s and %s", r.key, formatLimit(r.min), formatLimit(r.max))
		}
	}
	return nil
}

// formatLimit prints a limit as a plain number (1048576, not 1.048576e+06).
func formatLimit(limit float64) string {
	return strconv.FormatFloat(limit, 'f', -1, 64)
}

func (p *PhaseSettings) validateMetricNames() error {
	metrics := []struct{ key, value string }{
		{"gpuPowerMetric", p.GPUPowerMetric},
		{"gpuUtilizationMetric", p.GPUUtilizationMetric},
	}
	for _, metric := range metrics {
		if metric.value != "" && !validPhaseMetricName(metric.value) {
			return fmt.Errorf("phases %s must be a Prometheus metric name", metric.key)
		}
	}
	if len(p.StorageWriteMetrics) > maxPhaseStorageWriteMetrics {
		return fmt.Errorf("phases storageWriteMetrics must name at most %d metrics", maxPhaseStorageWriteMetrics)
	}
	for index, name := range p.StorageWriteMetrics {
		if !validPhaseMetricName(name) {
			return fmt.Errorf("phases storageWriteMetrics must be Prometheus metric names")
		}
		if slices.Contains(p.StorageWriteMetrics[:index], name) {
			return fmt.Errorf("phases storageWriteMetrics must not repeat a metric")
		}
	}
	return nil
}
