package templates

import (
	"regexp"
	"strings"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/settings"
	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

type Definition struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Capabilities []string `json:"capabilities"`
}

var (
	trainingNamePattern  = regexp.MustCompile(`(?i)(train|pretrain|finetune|sft|rlhf)`)
	inferenceNamePattern = regexp.MustCompile(`(?i)(infer|serve|benchmark|eval)`)
)

func Builtins() []Definition {
	return []Definition{
		{
			ID:           "overview",
			Title:        "Overview",
			Capabilities: []string{"overview", "gpu", "cpu", "memory", "network", "disk"},
		},
		{
			ID:           "distributed-training",
			Title:        "Distributed Training",
			Capabilities: []string{"overview", "gpu", "cpu", "memory", "network", "disk"},
		},
		{
			ID:           "inference",
			Title:        "Inference",
			Capabilities: []string{"overview", "gpu", "cpu", "memory", "network", "disk"},
		},
	}
}

func IsKnownTemplateID(id string) bool {
	for _, template := range Builtins() {
		if template.ID == id {
			return true
		}
	}
	return false
}

func SelectTemplateID(job slurm.Job, cluster settings.ClusterProfile, override string) string {
	if override != "" && IsKnownTemplateID(override) {
		return override
	}
	if matchesInference(job) {
		return "inference"
	}
	if matchesDistributedTraining(job) {
		return "distributed-training"
	}
	if cluster.DefaultTemplateID != "" {
		return cluster.DefaultTemplateID
	}
	return "overview"
}

func matchesDistributedTraining(job slurm.Job) bool {
	return job.GPUsTotal >= 8 ||
		(strings.Contains(strings.ToLower(job.Partition), "gpu") && trainingNamePattern.MatchString(job.Name))
}

func matchesInference(job slurm.Job) bool {
	return inferenceNamePattern.MatchString(job.Name)
}
