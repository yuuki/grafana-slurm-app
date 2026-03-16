package plugin

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
)

var promMetaChars = regexp.MustCompile(`[{}()\[\]|*+?.\\^$]`)

type exportDashboardRequest struct {
	ClusterID string `json:"clusterId"`
	JobID     uint32 `json:"jobId"`
	Template  string `json:"template,omitempty"`
}

func buildDashboardPayload(job JobRecord, cluster settings.ClusterProfile) map[string]any {
	instanceLabelMatcher := formatPromLabelName(cluster.InstanceLabel, cluster.MetricsType)
	matcher := buildInstanceMatcher(job.Nodes, cluster.InstanceLabel, cluster.NodeMatcherMode, cluster.MetricsType)

	if fm := buildFilterMatcher(cluster.MetricsFilterLabel, cluster.MetricsFilterValue, cluster.MetricsType); fm != "" {
		matcher += "," + fm
	}

	panels := []map[string]any{
		newTimeseriesPanel(1, 0, 0, 12, 8, "GPU Utilization", cluster.MetricsDatasourceUID, `DCGM_FI_DEV_GPU_UTIL{`+matcher+`}`, `{{`+cluster.InstanceLabel+`}} / GPU {{gpu}}`, "percent"),
		newTimeseriesPanel(2, 12, 0, 12, 8, "GPU Memory Used", cluster.MetricsDatasourceUID, `DCGM_FI_DEV_FB_USED{`+matcher+`}`, `{{`+cluster.InstanceLabel+`}} / GPU {{gpu}}`, "decmbytes"),
		newTimeseriesPanel(3, 0, 8, 12, 8, "CPU Utilization", cluster.MetricsDatasourceUID, `100 - (avg by(`+instanceLabelMatcher+`)(rate(node_cpu_seconds_total{mode="idle",`+matcher+`}[5m])) * 100)`, `{{`+cluster.InstanceLabel+`}}`, "percent"),
		newTimeseriesPanel(4, 12, 8, 12, 8, "Memory Usage", cluster.MetricsDatasourceUID, `node_memory_MemTotal_bytes{`+matcher+`} - node_memory_MemAvailable_bytes{`+matcher+`}`, `{{`+cluster.InstanceLabel+`}}`, "bytes"),
		newTimeseriesPanel(5, 0, 16, 12, 8, "Network Receive", cluster.MetricsDatasourceUID, `rate(node_network_receive_bytes_total{device!="lo",`+matcher+`}[5m])`, `{{`+cluster.InstanceLabel+`}} {{device}}`, "Bps"),
		newTimeseriesPanel(6, 12, 16, 12, 8, "Network Transmit", cluster.MetricsDatasourceUID, `rate(node_network_transmit_bytes_total{device!="lo",`+matcher+`}[5m])`, `{{`+cluster.InstanceLabel+`}} {{device}}`, "Bps"),
		newTimeseriesPanel(7, 0, 24, 12, 8, "Disk Read", cluster.MetricsDatasourceUID, `rate(node_disk_read_bytes_total{`+matcher+`}[5m])`, `{{`+cluster.InstanceLabel+`}} {{device}}`, "Bps"),
		newTimeseriesPanel(8, 12, 24, 12, 8, "Disk Write", cluster.MetricsDatasourceUID, `rate(node_disk_written_bytes_total{`+matcher+`}[5m])`, `{{`+cluster.InstanceLabel+`}} {{device}}`, "Bps"),
	}

	return map[string]any{
		"dashboard": map[string]any{
			"id":            nil,
			"uid":           nil,
			"title":         fmt.Sprintf("Slurm Job %s/%d %s", job.ClusterID, job.JobID, job.Name),
			"schemaVersion": 39,
			"version":       0,
			"tags":          []string{"slurm", "job", job.ClusterID, job.TemplateID},
			"time": map[string]any{
				"from": time.Unix(job.StartTime, 0).UTC().Format(time.RFC3339),
				"to":   dashboardEndTime(job),
			},
			"panels": panels,
		},
		"overwrite": false,
	}
}

func newTimeseriesPanel(id, x, y, w, h int, title, datasourceUID, expr, legendFormat, unit string) map[string]any {
	return map[string]any{
		"id":    id,
		"title": title,
		"type":  "timeseries",
		"gridPos": map[string]any{
			"x": x,
			"y": y,
			"w": w,
			"h": h,
		},
		"datasource": map[string]any{
			"type": "prometheus",
			"uid":  datasourceUID,
		},
		"targets": []map[string]any{
			{
				"refId":        "A",
				"expr":         expr,
				"legendFormat": legendFormat,
			},
		},
		"fieldConfig": map[string]any{
			"defaults": map[string]any{
				"unit": unit,
			},
			"overrides": []any{},
		},
		"options": map[string]any{
			"legend": map[string]any{
				"displayMode": "list",
				"placement":   "bottom",
			},
			"tooltip": map[string]any{
				"mode": "multi",
			},
		},
	}
}

func dashboardEndTime(job JobRecord) string {
	if job.EndTime > 0 {
		return time.Unix(job.EndTime, 0).UTC().Format(time.RFC3339)
	}
	return "now"
}

func escapePromRegex(s string) string {
	return promMetaChars.ReplaceAllStringFunc(s, func(c string) string {
		return `\` + c
	})
}

func escapePromLabelValue(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}

func formatPromLabelName(label string, metricsType settings.MetricsType) string {
	if metricsType == settings.MetricsTypeVictoriaMetrics {
		return label
	}
	if regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`).MatchString(label) {
		return label
	}
	return `"` + strings.ReplaceAll(strings.ReplaceAll(label, `\`, `\\`), `"`, `\"`) + `"`
}

func buildFilterMatcher(label, value string, metricsType settings.MetricsType) string {
	if label == "" || value == "" {
		return ""
	}
	return fmt.Sprintf(`%s="%s"`, formatPromLabelName(label, metricsType), escapePromLabelValue(value))
}

func buildInstanceMatcher(nodes []string, instanceLabel string, mode settings.NodeMatcherMode, metricsType settings.MetricsType) string {
	label := formatPromLabelName(instanceLabel, metricsType)
	joined := "__no_nodes__"
	if len(nodes) > 0 {
		escaped := make([]string, len(nodes))
		for i, n := range nodes {
			escaped[i] = escapePromRegex(n)
		}
		joined = strings.Join(escaped, "|")
	}
	if mode == settings.NodeMatcherHostname {
		return fmt.Sprintf(`%s=~"(%s)"`, label, joined)
	}
	return fmt.Sprintf(`%s=~"(%s):[0-9]+"`, label, joined)
}

