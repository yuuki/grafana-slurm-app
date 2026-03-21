package plugin

import (
	"fmt"
	"time"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
)

type exportPanelDef struct {
	Title        string `json:"title"`
	Expr         string `json:"expr"`
	LegendFormat string `json:"legendFormat"`
	Unit         string `json:"unit,omitempty"`
}

type exportDashboardRequest struct {
	ClusterID string           `json:"clusterId"`
	JobID     uint32           `json:"jobId"`
	Template  string           `json:"template,omitempty"`
	FolderUID string           `json:"folderUid,omitempty"`
	Panels    []exportPanelDef `json:"panels,omitempty"`
}

func buildDashboardPayload(job JobRecord, cluster settings.ClusterProfile, panelDefs []exportPanelDef, folderUID string) map[string]any {
	panels := buildPanelsFromDefs(panelDefs, cluster.MetricsDatasourceUID)

	payload := map[string]any{
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
	if folderUID != "" {
		payload["folderUid"] = folderUID
	}
	return payload
}

func buildPanelsFromDefs(defs []exportPanelDef, datasourceUID string) []map[string]any {
	panels := make([]map[string]any, 0, len(defs))
	for i, d := range defs {
		x := (i % 2) * 12
		y := (i / 2) * 8
		panels = append(panels, newTimeseriesPanel(i+1, x, y, 12, 8, d.Title, datasourceUID, d.Expr, d.LegendFormat, d.Unit))
	}
	return panels
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

