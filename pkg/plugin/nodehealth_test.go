package plugin

import (
	"math"
	"testing"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

func TestComputeNodeHealth(t *testing.T) {
	tests := []struct {
		name     string
		jobs     []slurm.NodeStatsJob
		assertFn func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline)
	}{
		{
			name: "failed single node ranks ahead of completed nodes",
			jobs: []slurm.NodeStatsJob{
				{State: "FAILED", NodeList: "bad", EndTime: 30},
				{State: "COMPLETED", NodeList: "good", EndTime: 20},
				{State: "COMPLETED", NodeList: "good", EndTime: 10},
			},
			assertFn: func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline) {
				if len(nodes) != 2 || nodes[0].Name != "bad" || nodes[0].Score <= 0 {
					t.Fatalf("nodes = %#v, want bad node ranked first with positive score", nodes)
				}
				assertClose(t, baseline.FailureRate, 1.0/3.0)
			},
		},
		{
			name: "fractional blame is split across four nodes",
			jobs: []slurm.NodeStatsJob{
				{State: "FAILED", NodeList: "node[1-4]", EndTime: 10},
				{State: "COMPLETED", NodeList: "other", EndTime: 9},
			},
			assertFn: func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline) {
				got := nodeByName(t, nodes, "node1")
				assertClose(t, got.ExpectedFailures, 0.125)
				assertClose(t, got.Score, 0.125)
			},
		},
		{
			name: "node fail bonus outranks plain failure",
			jobs: []slurm.NodeStatsJob{
				{State: "NODE_FAIL", NodeList: "node-fail", EndTime: 10},
				{State: "FAILED", NodeList: "failed", EndTime: 10},
			},
			assertFn: func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline) {
				if nodes[0].Name != "node-fail" || nodes[0].NodeFailJobs != 1 {
					t.Fatalf("nodes = %#v, want NODE_FAIL node first", nodes)
				}
				assertClose(t, nodes[0].Score-nodeByName(t, nodes, "failed").Score, 2)
			},
		},
		{
			name: "failed node bonus is undivided and exact",
			jobs: []slurm.NodeStatsJob{
				{State: "FAILED", NodeList: "gpu-node[002-003]", FailedNode: "gpu-node003", EndTime: 10},
			},
			assertFn: func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline) {
				hit := nodeByName(t, nodes, "gpu-node003")
				other := nodeByName(t, nodes, "gpu-node002")
				if hit.FailedNodeHits != 1 || other.FailedNodeHits != 0 {
					t.Fatalf("failedNodeHits: hit=%d other=%d", hit.FailedNodeHits, other.FailedNodeHits)
				}
				assertClose(t, hit.Score-other.Score, 5)
			},
		},
		{
			name: "uniform failures match the baseline",
			jobs: []slurm.NodeStatsJob{
				{State: "FAILED", NodeList: "node-a"},
				{State: "COMPLETED", NodeList: "node-a"},
				{State: "FAILED", NodeList: "node-b"},
				{State: "COMPLETED", NodeList: "node-b"},
			},
			assertFn: func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline) {
				for _, node := range nodes {
					if math.Abs(node.Score) >= 1e-9 {
						t.Errorf("%s score = %v, want approximately zero", node.Name, node.Score)
					}
				}
			},
		},
		{
			name: "low sample last failure empty nodelist and invalid notation",
			jobs: []slurm.NodeStatsJob{
				{State: "COMPLETED", NodeList: "healthy", EndTime: 50},
				{State: "FAILED", NodeList: "bad[[", EndTime: 40},
				{State: "FAILED", NodeList: "bad[[", EndTime: 60},
				{State: "FAILED", NodeList: "", EndTime: 100},
			},
			assertFn: func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline) {
				if len(nodes) != 2 {
					t.Fatalf("len(nodes) = %d, want 2: %#v", len(nodes), nodes)
				}
				bad := nodeByName(t, nodes, "bad[[")
				healthy := nodeByName(t, nodes, "healthy")
				if !bad.LowSample || bad.LastFailureAt != 60 {
					t.Errorf("bad node = %#v, want low sample with last failure 60", bad)
				}
				if healthy.LastFailureAt != 0 {
					t.Errorf("healthy lastFailureAt = %d, want 0", healthy.LastFailureAt)
				}
				if baseline.TotalJobs != 3 || baseline.FailedJobs != 2 {
					t.Errorf("baseline = %#v, want empty nodelist excluded", baseline)
				}
			},
		},
		{
			name: "minimum sample boundary and display counts",
			jobs: []slurm.NodeStatsJob{
				{State: "FAILED", NodeList: "five", EndTime: 10},
				{State: "COMPLETED", NodeList: "five"},
				{State: "COMPLETED", NodeList: "five"},
				{State: "COMPLETED", NodeList: "five"},
				{State: "COMPLETED", NodeList: "five"},
				{State: "FAILED", NodeList: "four", EndTime: 10},
				{State: "COMPLETED", NodeList: "four"},
				{State: "COMPLETED", NodeList: "four"},
				{State: "COMPLETED", NodeList: "four"},
			},
			assertFn: func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline) {
				five := nodeByName(t, nodes, "five")
				four := nodeByName(t, nodes, "four")
				if five.LowSample || !four.LowSample {
					t.Fatalf("lowSample: five=%v four=%v", five.LowSample, four.LowSample)
				}
				if five.TotalJobs != 5 || five.FailedJobs != 1 || five.FailureRate != 0.2 {
					t.Errorf("five = %#v, want 5 total, 1 failed, rate 0.2", five)
				}
				if baseline.TotalJobs != 9 || baseline.FailedJobs != 2 {
					t.Errorf("baseline = %#v, want 9 total and 2 failed", baseline)
				}
			},
		},
		{
			name: "excluded states and duplicate nodes do not affect totals",
			jobs: []slurm.NodeStatsJob{
				{State: "FAILED", NodeList: "node-a,node-a", EndTime: 10},
				{State: "COMPLETED", NodeList: "node-a", EndTime: 20},
				{State: "CANCELLED", NodeList: "ignored", EndTime: 30},
			},
			assertFn: func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline) {
				if len(nodes) != 1 {
					t.Fatalf("nodes = %#v, want only node-a", nodes)
				}
				node := nodes[0]
				if node.TotalJobs != 2 || node.FailedJobs != 1 || node.LastFailureAt != 10 {
					t.Errorf("node = %#v, want duplicate allocation counted once and latest failed time only", node)
				}
				if baseline.TotalJobs != 2 || baseline.FailedJobs != 1 {
					t.Errorf("baseline = %#v, want excluded state omitted", baseline)
				}
			},
		},
		{
			name: "ties are sorted by name",
			jobs: []slurm.NodeStatsJob{
				{State: "COMPLETED", NodeList: "z-node"},
				{State: "COMPLETED", NodeList: "a-node"},
			},
			assertFn: func(t *testing.T, nodes []NodeHealthStats, baseline NodeHealthBaseline) {
				if len(nodes) != 2 || nodes[0].Name != "a-node" || nodes[1].Name != "z-node" {
					t.Fatalf("nodes = %#v, want name ascending for equal scores", nodes)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			nodes, baseline := ComputeNodeHealth(tt.jobs)
			tt.assertFn(t, nodes, baseline)
		})
	}
}

func nodeByName(t *testing.T, nodes []NodeHealthStats, name string) NodeHealthStats {
	t.Helper()
	for _, node := range nodes {
		if node.Name == name {
			return node
		}
	}
	t.Fatalf("node %q not found in %#v", name, nodes)
	return NodeHealthStats{}
}

func assertClose(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) >= 1e-9 {
		t.Errorf("got %v, want %v", got, want)
	}
}
