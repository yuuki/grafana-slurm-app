package templates

import (
	"testing"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

func TestSelectTemplatePrefersExplicitOverride(t *testing.T) {
	job := slurm.Job{
		Name:      "train_llm_70b",
		Partition: "gpu-a100",
		GPUsTotal: 64,
		TRES:      "1001=gres/gpu:64",
	}

	cluster := settings.ClusterProfile{
		DefaultTemplateID: "overview",
	}

	got := SelectTemplateID(job, cluster, "inference")
	if got != "inference" {
		t.Fatalf("expected explicit override to win, got %q", got)
	}
}

func TestSelectTemplateFallsBackToMatchRulesThenClusterDefault(t *testing.T) {
	cluster := settings.ClusterProfile{
		DefaultTemplateID: "overview",
	}

	trainingJob := slurm.Job{
		Name:      "pretrain_llm",
		Partition: "gpu-a100",
		GPUsTotal: 16,
		TRES:      "1001=gres/gpu:16",
	}
	if got := SelectTemplateID(trainingJob, cluster, ""); got != "distributed-training" {
		t.Fatalf("expected distributed-training template, got %q", got)
	}

	plainJob := slurm.Job{
		Name:      "etl_cpu",
		Partition: "cpu",
		GPUsTotal: 0,
		TRES:      "1=64",
	}
	if got := SelectTemplateID(plainJob, cluster, ""); got != "overview" {
		t.Fatalf("expected cluster default template, got %q", got)
	}
}
