package plugin

import (
	"testing"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
)

func TestBuildDashboardPayloadUsesJobAndClusterContext(t *testing.T) {
	job := JobRecord{
		ClusterID:  "a100",
		JobID:      42,
		Name:       "train_llm",
		User:       "researcher1",
		Partition:  "gpu-a100",
		Nodes:      []string{"gpu-node001", "gpu-node002"},
		StartTime:  1700000000,
		EndTime:    1700003600,
		TemplateID: "distributed-training",
	}
	cluster := settings.ClusterProfile{
		ID:                   "a100",
		DisplayName:          "A100",
		MetricsDatasourceUID: "prometheus",
		InstanceLabel:        "instance",
		NodeExporterPort:     "9100",
		DCGMExporterPort:     "9400",
		NodeMatcherMode:      settings.NodeMatcherHostPort,
	}

	payload := buildDashboardPayload(job, cluster)
	dashboard, ok := payload["dashboard"].(map[string]any)
	if !ok {
		t.Fatalf("expected dashboard payload")
	}

	if dashboard["title"] != "Slurm Job a100/42 train_llm" {
		t.Fatalf("unexpected title: %v", dashboard["title"])
	}

	timeRange, ok := dashboard["time"].(map[string]any)
	if !ok {
		t.Fatalf("expected time range")
	}
	if timeRange["from"] != "2023-11-14T22:13:20Z" {
		t.Fatalf("unexpected from time: %v", timeRange["from"])
	}
	if timeRange["to"] != "2023-11-14T23:13:20Z" {
		t.Fatalf("unexpected to time: %v", timeRange["to"])
	}

	panels, ok := dashboard["panels"].([]map[string]any)
	if !ok {
		t.Fatalf("expected panels")
	}
	if len(panels) < 6 {
		t.Fatalf("expected at least 6 panels, got %d", len(panels))
	}
}
