package plugin

import (
	"sort"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

const (
	nodeFailBonus   = 2.0
	failedNodeBonus = 5.0
	minNodeJobs     = 5
)

type NodeHealthStats struct {
	Name             string  `json:"name"`
	TotalJobs        int     `json:"totalJobs"`
	FailedJobs       int     `json:"failedJobs"`
	NodeFailJobs     int     `json:"nodeFailJobs"`
	FailedNodeHits   int     `json:"failedNodeHits"`
	FailureRate      float64 `json:"failureRate"`
	ExpectedFailures float64 `json:"expectedFailures"`
	Score            float64 `json:"score"`
	LastFailureAt    int64   `json:"lastFailureAt,omitempty"`
	LowSample        bool    `json:"lowSample"`
}

type NodeHealthBaseline struct {
	TotalJobs   int     `json:"totalJobs"`
	FailedJobs  int     `json:"failedJobs"`
	FailureRate float64 `json:"failureRate"`
}

type weightedNodeHealth struct {
	stats                NodeHealthStats
	weightedJobs         float64
	weightedFailures     float64
	weightedNodeFailures float64
}

// ComputeNodeHealth aggregates per-node stats and scores. Nodes are returned
// sorted by score descending, with node name ascending as the tiebreaker.
func ComputeNodeHealth(jobs []slurm.NodeStatsJob) ([]NodeHealthStats, NodeHealthBaseline) {
	byNode := make(map[string]*weightedNodeHealth)
	baseline := NodeHealthBaseline{}

	for _, job := range jobs {
		failed, included := nodeHealthState(job.State)
		if !included || job.NodeList == "" {
			continue
		}

		nodes, err := slurm.ExpandNodeList(job.NodeList)
		if err != nil {
			nodes = []string{job.NodeList}
		}
		nodes = uniqueNonEmpty(nodes)
		if len(nodes) == 0 {
			continue
		}

		baseline.TotalJobs++
		if failed {
			baseline.FailedJobs++
		}
		weight := 1.0 / float64(len(nodes))
		for _, name := range nodes {
			node := byNode[name]
			if node == nil {
				node = &weightedNodeHealth{stats: NodeHealthStats{Name: name}}
				byNode[name] = node
			}
			node.stats.TotalJobs++
			node.weightedJobs += weight
			if !failed {
				continue
			}
			node.stats.FailedJobs++
			node.weightedFailures += weight
			if job.EndTime > node.stats.LastFailureAt {
				node.stats.LastFailureAt = job.EndTime
			}
			if job.State == "NODE_FAIL" {
				node.stats.NodeFailJobs++
				node.weightedNodeFailures += weight
			}
			if job.FailedNode == name {
				node.stats.FailedNodeHits++
			}
		}
	}

	if baseline.TotalJobs > 0 {
		baseline.FailureRate = float64(baseline.FailedJobs) / float64(baseline.TotalJobs)
	}

	nodes := make([]NodeHealthStats, 0, len(byNode))
	for _, aggregate := range byNode {
		stats := aggregate.stats
		stats.FailureRate = float64(stats.FailedJobs) / float64(stats.TotalJobs)
		stats.ExpectedFailures = aggregate.weightedJobs * baseline.FailureRate
		stats.Score = aggregate.weightedFailures - stats.ExpectedFailures +
			nodeFailBonus*aggregate.weightedNodeFailures +
			failedNodeBonus*float64(stats.FailedNodeHits)
		stats.LowSample = stats.TotalJobs < minNodeJobs
		nodes = append(nodes, stats)
	}

	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Score == nodes[j].Score {
			return nodes[i].Name < nodes[j].Name
		}
		return nodes[i].Score > nodes[j].Score
	})
	return nodes, baseline
}

func nodeHealthState(state string) (failed, included bool) {
	switch state {
	case "COMPLETED":
		return false, true
	case "FAILED", "NODE_FAIL":
		return true, true
	default:
		return false, false
	}
}

func uniqueNonEmpty(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
