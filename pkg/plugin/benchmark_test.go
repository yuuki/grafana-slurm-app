package plugin

import (
	"fmt"
	"testing"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

// BenchmarkComputeNodeHealth scores a full node-health window: the
// repository returns at most nodeHealthJobLimit jobs per request.
func BenchmarkComputeNodeHealth(b *testing.B) {
	states := []string{"COMPLETED", "COMPLETED", "COMPLETED", "FAILED", "NODE_FAIL"}
	jobs := make([]slurm.NodeStatsJob, nodeHealthJobLimit)
	for i := range jobs {
		first := i % 120
		jobs[i] = slurm.NodeStatsJob{
			State:      states[i%len(states)],
			NodeList:   fmt.Sprintf("gpu-node[%03d-%03d]", first, first+7),
			EndTime:    int64(1700000000 + i),
			FailedNode: fmt.Sprintf("gpu-node%03d", first),
		}
	}
	b.ReportAllocs()
	for b.Loop() {
		ComputeNodeHealth(jobs)
	}
}
