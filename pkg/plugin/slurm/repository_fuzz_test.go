package slurm

import (
	"strings"
	"testing"
)

// FuzzParseTRESGPUs feeds arbitrary tres_alloc strings, as stored by
// slurmdbd, to parseTRESGPUs, both with and without the GPU TRES IDs that
// ensureGPUTRESIDs resolves from tres_table.
func FuzzParseTRESGPUs(f *testing.F) {
	for _, seed := range []string{
		"",
		"1=128,2=1048576,4=1,1001=gres/gpu:8",
		"1=128,2=1048576,4=1,1001=gpu:4",
		"1=128,2=1048576,4=1,1001=8",
		"1=128,1001=gres/gpu:a100:64",
		"1=128,gres/gpu:a100=4,gres/gpu:h100=4",
		"1=128,gres/gpu=8,gres/gpu:a100=4,gres/gpu:h100=4",
		"1=128,1001=8,1002=4",
		"1=128,1002=4,1003=4",
		"1=128,license/gpu:a100=2",
		"1=128,gres/gpu:a100=notanumber",
		"gres/gpu",
		"=,==,1001=",
	} {
		f.Add(seed)
	}

	ids := &gpuTRESIDSet{
		aggregate: map[int]struct{}{1001: {}},
		typed:     map[int]struct{}{1002: {}, 1003: {}},
	}

	f.Fuzz(func(t *testing.T, tres string) {
		withoutIDs := parseTRESGPUs(tres, nil)
		withIDs := parseTRESGPUs(tres, ids)

		// Without the ID lookup only descriptive entries can count, and
		// those always spell out "gpu".
		if withoutIDs != 0 && !strings.Contains(tres, "gpu") {
			t.Fatalf("parseTRESGPUs(%q, nil) = %d without any GPU entry", tres, withoutIDs)
		}

		// Entries are independent: CPU and memory TRES around the string
		// change nothing.
		padded := "1=128,2=1048576," + tres + ",4=1"
		if got := parseTRESGPUs(padded, nil); got != withoutIDs {
			t.Fatalf("parseTRESGPUs(%q, nil) = %d, but %d for %q", padded, got, withoutIDs, tres)
		}
		if got := parseTRESGPUs(padded, ids); got != withIDs {
			t.Fatalf("parseTRESGPUs(%q, ids) = %d, but %d for %q", padded, got, withIDs, tres)
		}

		// An aggregate entry is authoritative; the last one wins.
		if got := parseTRESGPUs(tres+",gres/gpu=7", nil); got != 7 {
			t.Fatalf("parseTRESGPUs(%q, nil) = %d, want the trailing aggregate 7", tres+",gres/gpu=7", got)
		}
		if got := parseTRESGPUs(tres+",1001=7", ids); got != 7 {
			t.Fatalf("parseTRESGPUs(%q, ids) = %d, want the trailing aggregate 7", tres+",1001=7", got)
		}
	})
}
