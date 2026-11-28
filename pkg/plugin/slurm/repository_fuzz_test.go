package slurm

import (
	"strings"
	"testing"
)

// outOfRangeCount is a decimal number that does not fit in an int64.
const outOfRangeCount = "99999999999999999999"

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
		"1=128,gres/gpu=99999999999999999999",
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

		// A count that does not fit in an int is unreadable, like any other
		// count that is not a number: it is never the largest int.
		for _, entry := range []string{
			"gres/gpu=%s", "1001=gres/gpu:%s", "1001=%s",
			"gres/gpu:a100=%s", "1001=gres/gpu:a100:%s", "1002=%s",
		} {
			huge := tres + "," + strings.Replace(entry, "%s", outOfRangeCount, 1)
			unreadable := tres + "," + strings.Replace(entry, "%s", "notanumber", 1)
			if got, want := parseTRESGPUs(huge, ids), parseTRESGPUs(unreadable, ids); got != want {
				t.Fatalf("parseTRESGPUs(%q, ids) = %d, but %d for %q", huge, got, want, unreadable)
			}
			if got, want := parseTRESGPUs(huge, nil), parseTRESGPUs(unreadable, nil); got != want {
				t.Fatalf("parseTRESGPUs(%q, nil) = %d, but %d for %q", huge, got, want, unreadable)
			}
		}
	})
}

// FuzzParseTRESCPUs feeds arbitrary tres_alloc strings to parseTRESCPUs.
func FuzzParseTRESCPUs(f *testing.F) {
	for _, seed := range []string{
		"",
		"1=128,2=1048576,4=1,5=128,1001=gres/gpu:8",
		"cpu=32,mem=128G,node=1,gres/gpu=4",
		"2=1048576,4=1,1001=8",
		"1=-8",
		"1=99999999999999999999999",
		"1=8,cpu=16",
		"11=4,1001=1",
		"=,==,1=",
	} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, tres string) {
		got := parseTRESCPUs(tres)
		if got < 0 {
			t.Fatalf("parseTRESCPUs(%q) = %d, want a non-negative count", tres, got)
		}

		// Only an entry keyed "1" or "cpu" can count.
		if got != 0 && !strings.Contains(tres, "1=") && !strings.Contains(tres, "cpu=") {
			t.Fatalf("parseTRESCPUs(%q) = %d without any cpu entry", tres, got)
		}

		// Entries are independent: memory, node and GPU TRES around the
		// string change nothing.
		padded := "2=1048576," + tres + ",4=1,1001=8,gres/gpu=8"
		if padded := parseTRESCPUs(padded); padded != got {
			t.Fatalf("parseTRESCPUs(padded %q) = %d, but %d for %q", tres, padded, got, tres)
		}

		// The last cpu entry wins, under either key.
		if got := parseTRESCPUs(tres + ",1=7"); got != 7 {
			t.Fatalf("parseTRESCPUs(%q) = %d, want the trailing 7", tres+",1=7", got)
		}
		if got := parseTRESCPUs(tres + ",cpu=9"); got != 9 {
			t.Fatalf("parseTRESCPUs(%q) = %d, want the trailing 9", tres+",cpu=9", got)
		}
	})
}
