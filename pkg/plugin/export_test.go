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
		InstanceLabel:        "host.name",
		MetricsFilterLabel:   "k8s.cluster.name",
		MetricsFilterValue:   "slurm-a100",
		NodeMatcherMode:      settings.NodeMatcherHostPort,
	}

	payload := buildDashboardPayload(job, cluster, nil, "")
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
	targets, ok := panels[0]["targets"].([]map[string]any)
	if !ok || len(targets) == 0 {
		t.Fatalf("expected panel targets")
	}
	if targets[0]["expr"] != `DCGM_FI_DEV_GPU_UTIL{"host.name"=~"(gpu-node001|gpu-node002):[0-9]+","k8s.cluster.name"="slurm-a100"}` {
		t.Fatalf("unexpected expr: %v", targets[0]["expr"])
	}
	if targets[0]["legendFormat"] != `{{host.name}} / GPU {{gpu}}` {
		t.Fatalf("unexpected legend format: %v", targets[0]["legendFormat"])
	}

	if _, hasFolderUid := payload["folderUid"]; hasFolderUid {
		t.Fatalf("expected no folderUid when empty string provided")
	}
}

func TestBuildDashboardPayloadUsesBareDottedLabelsForVictoriaMetrics(t *testing.T) {
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
		MetricsDatasourceUID: "victoriametrics",
		MetricsType:          settings.MetricsTypeVictoriaMetrics,
		InstanceLabel:        "host.name",
		MetricsFilterLabel:   "k8s.cluster.name",
		MetricsFilterValue:   "slurm-a100",
		NodeMatcherMode:      settings.NodeMatcherHostPort,
	}

	payload := buildDashboardPayload(job, cluster, nil, "")
	dashboard := payload["dashboard"].(map[string]any)
	panels := dashboard["panels"].([]map[string]any)
	targets := panels[0]["targets"].([]map[string]any)

	if targets[0]["expr"] != `DCGM_FI_DEV_GPU_UTIL{host.name=~"(gpu-node001|gpu-node002):[0-9]+",k8s.cluster.name="slurm-a100"}` {
		t.Fatalf("unexpected expr: %v", targets[0]["expr"])
	}
}

func TestBuildDashboardPayloadWithCustomPanels(t *testing.T) {
	job := JobRecord{
		ClusterID:  "a100",
		JobID:      42,
		Name:       "train_llm",
		Nodes:      []string{"gpu-node001"},
		StartTime:  1700000000,
		EndTime:    1700003600,
		TemplateID: "overview",
	}
	cluster := settings.ClusterProfile{
		ID:                   "a100",
		MetricsDatasourceUID: "prometheus",
		InstanceLabel:        "instance",
		NodeMatcherMode:      settings.NodeMatcherHostPort,
	}

	panels := []exportPanelDef{
		{Title: "GPU Util", Expr: `DCGM_FI_DEV_GPU_UTIL{instance="node1"}`, LegendFormat: "{{instance}}", Unit: "percent"},
		{Title: "CPU Usage", Expr: `node_cpu_seconds_total{instance="node1"}`, LegendFormat: "{{instance}}", Unit: "percent"},
		{Title: "Memory", Expr: `node_memory_MemTotal_bytes{instance="node1"}`, LegendFormat: "{{instance}}", Unit: "bytes"},
	}

	payload := buildDashboardPayload(job, cluster, panels, "")
	dashboard := payload["dashboard"].(map[string]any)
	resultPanels := dashboard["panels"].([]map[string]any)

	if len(resultPanels) != 3 {
		t.Fatalf("expected 3 panels, got %d", len(resultPanels))
	}

	if resultPanels[0]["title"] != "GPU Util" {
		t.Fatalf("unexpected first panel title: %v", resultPanels[0]["title"])
	}
	targets := resultPanels[0]["targets"].([]map[string]any)
	if targets[0]["expr"] != `DCGM_FI_DEV_GPU_UTIL{instance="node1"}` {
		t.Fatalf("unexpected expr: %v", targets[0]["expr"])
	}

	// Verify 2-column grid layout
	gridPos0 := resultPanels[0]["gridPos"].(map[string]any)
	gridPos1 := resultPanels[1]["gridPos"].(map[string]any)
	gridPos2 := resultPanels[2]["gridPos"].(map[string]any)
	if gridPos0["x"] != 0 || gridPos0["y"] != 0 {
		t.Fatalf("unexpected panel 0 position: x=%v y=%v", gridPos0["x"], gridPos0["y"])
	}
	if gridPos1["x"] != 12 || gridPos1["y"] != 0 {
		t.Fatalf("unexpected panel 1 position: x=%v y=%v", gridPos1["x"], gridPos1["y"])
	}
	if gridPos2["x"] != 0 || gridPos2["y"] != 8 {
		t.Fatalf("unexpected panel 2 position: x=%v y=%v", gridPos2["x"], gridPos2["y"])
	}
}

func TestBuildDashboardPayloadWithFolderUID(t *testing.T) {
	job := JobRecord{
		ClusterID:  "a100",
		JobID:      42,
		Name:       "train",
		Nodes:      []string{"node1"},
		StartTime:  1700000000,
		EndTime:    1700003600,
		TemplateID: "overview",
	}
	cluster := settings.ClusterProfile{
		ID:                   "a100",
		MetricsDatasourceUID: "prometheus",
		InstanceLabel:        "instance",
		NodeMatcherMode:      settings.NodeMatcherHostPort,
	}

	payload := buildDashboardPayload(job, cluster, nil, "folder-abc")
	folderUID, ok := payload["folderUid"].(string)
	if !ok || folderUID != "folder-abc" {
		t.Fatalf("expected folderUid 'folder-abc', got %v", payload["folderUid"])
	}
}
