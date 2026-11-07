package slurm

import "testing"

// Every job row read from slurmdbd goes through ExpandNodeList and
// parseTRESGPUs, and a node-filtered search scans up to nodeFilterMaxRows
// rows per request.

func BenchmarkExpandNodeList(b *testing.B) {
	for _, bm := range []struct{ name, nodeList string }{
		{"single", "gpu-node-001"},
		{"range64", "gpu-node[001-064]"},
		{"mixed", "gpu-node[001-016,020,031-040],cpu[1-8]"},
		{"nested", "rack[01-16]-node[01-32]"},
	} {
		b.Run(bm.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if _, err := ExpandNodeList(bm.nodeList); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkParseTRESGPUs(b *testing.B) {
	ids := &gpuTRESIDSet{
		aggregate: map[int]struct{}{1001: {}},
		typed:     map[int]struct{}{1002: {}, 1003: {}},
	}
	for _, bm := range []struct{ name, tres string }{
		{"descriptive", "1=128,2=1048576,4=1,1001=gres/gpu:8"},
		{"numeric", "1=128,2=1048576,4=1,5=128,1002=4,1003=4"},
	} {
		b.Run(bm.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				parseTRESGPUs(bm.tres, ids)
			}
		})
	}
}
