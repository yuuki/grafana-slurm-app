package slurm

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestExpandNodeList(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []string
		wantErr  bool
	}{
		{
			name:     "single node",
			input:    "gpu-node-001",
			expected: []string{"gpu-node-001"},
		},
		{
			name:     "simple range",
			input:    "node[001-003]",
			expected: []string{"node001", "node002", "node003"},
		},
		{
			name:     "range with individual",
			input:    "node[001-003,010]",
			expected: []string{"node001", "node002", "node003", "node010"},
		},
		{
			name:     "multiple groups comma separated",
			input:    "node[1-2],other[5-6]",
			expected: []string{"node1", "node2", "other5", "other6"},
		},
		{
			name:     "no padding",
			input:    "gpu[1-3]",
			expected: []string{"gpu1", "gpu2", "gpu3"},
		},
		{
			name:     "single index in brackets",
			input:    "node[5]",
			expected: []string{"node5"},
		},
		{
			name:     "empty string",
			input:    "",
			expected: nil,
		},
		{
			name:     "with suffix",
			input:    "rack[1-2]-node[01-02]",
			expected: []string{"rack1-node01", "rack1-node02", "rack2-node01", "rack2-node02"},
		},
		{
			name:    "unmatched bracket",
			input:   "node[1-3",
			wantErr: true,
		},
		{
			name:    "closing bracket before opening",
			input:   "]x[",
			wantErr: true,
		},
		{
			name:    "closing bracket between text before opening",
			input:   "a]b[",
			wantErr: true,
		},
		{
			name:    "closing bracket before opening with trailing text",
			input:   "a]b[c",
			wantErr: true,
		},
		{
			name:    "lone closing bracket",
			input:   "]",
			wantErr: true,
		},
		{
			name:    "reversed brackets around range",
			input:   "node]01[",
			wantErr: true,
		},
		{
			name:     "multiple valid groups still expand",
			input:    "node[01-02],gpu[1-2]",
			expected: []string{"node01", "node02", "gpu1", "gpu2"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("ExpandNodeList(%q) panicked: %v", tt.input, r)
				}
			}()
			got, err := ExpandNodeList(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("ExpandNodeList(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				if len(got) != len(tt.expected) {
					t.Errorf("ExpandNodeList(%q) = %v, want %v", tt.input, got, tt.expected)
					return
				}
				for i, v := range got {
					if v != tt.expected[i] {
						t.Errorf("ExpandNodeList(%q)[%d] = %q, want %q", tt.input, i, v, tt.expected[i])
					}
				}
			}
		})
	}
}

// TestExpandNodeList_HugeRangeFailsFast ensures a pathological range such as
// "node[1-999999999]" is rejected without materializing a huge slice first
// (regression test for the memory-exhaustion issue in expandSinglePattern).
func TestExpandNodeList_HugeRangeFailsFast(t *testing.T) {
	got, err := ExpandNodeList("node[1-999999999]")
	if err == nil {
		t.Fatalf("ExpandNodeList(huge range) error = nil, want error")
	}
	if got != nil {
		t.Fatalf("ExpandNodeList(huge range) = %v, want nil", got)
	}
	wantMsg := fmt.Sprintf("node list expansion exceeded limit of %d nodes", maxExpandedNodes)
	if err.Error() != wantMsg {
		t.Errorf("ExpandNodeList(huge range) error = %q, want %q", err.Error(), wantMsg)
	}
}

// TestExpandNodeList_RangeAtIntLimits covers ranges that end at the largest
// int. Their length used to overflow, which let an intermediate bracket
// bypass the budget and loop forever ("a[0-9223372036854775807]b[1]"), and
// the loop counter wrapped around instead of stopping at the end.
func TestExpandNodeList_RangeAtIntLimits(t *testing.T) {
	maxInt := strconv.Itoa(math.MaxInt)
	limitErr := fmt.Sprintf("node list expansion exceeded limit of %d nodes", maxExpandedNodes)
	for _, tc := range []struct {
		in      string
		want    []string
		wantErr string
	}{
		{in: "a[0-" + maxInt + "]b[1]", wantErr: limitErr},
		{in: "x,a[1-" + maxInt + "]b[1]", wantErr: limitErr},
		{in: "a[0-" + maxInt + "]", wantErr: limitErr},
		{in: "a[" + maxInt + "-" + maxInt + "]", want: []string{"a" + maxInt}},
		{in: "a[" + maxInt + "-" + maxInt + "]b[1-2]", want: []string{"a" + maxInt + "b1", "a" + maxInt + "b2"}},
		{in: "a[" + strconv.Itoa(math.MaxInt-1) + "-" + maxInt + "]", want: []string{"a" + strconv.Itoa(math.MaxInt-1), "a" + maxInt}},
	} {
		t.Run(tc.in, func(t *testing.T) {
			got, err := expandWithDeadline(t, tc.in)
			if tc.wantErr != "" {
				if err == nil || err.Error() != tc.wantErr || got != nil {
					t.Fatalf("ExpandNodeList(%q) = %q, %v; want nil, %q", tc.in, got, err, tc.wantErr)
				}
				return
			}
			if err != nil || !slices.Equal(got, tc.want) {
				t.Fatalf("ExpandNodeList(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
			}
		})
	}
}

func TestRangeLen(t *testing.T) {
	for _, tc := range []struct{ start, end, want int }{
		{5, 4, 0},
		{0, 0, 1},
		{0, maxExpandedNodes - 1, maxExpandedNodes},
		{0, maxExpandedNodes, maxExpandedNodes + 1},
		{-5, 5, 11},
		{0, math.MaxInt, maxExpandedNodes + 1},
		{math.MinInt, math.MaxInt, maxExpandedNodes + 1},
		{math.MaxInt, math.MaxInt, 1},
	} {
		if got := rangeLen(tc.start, tc.end); got != tc.want {
			t.Errorf("rangeLen(%d, %d) = %d, want %d", tc.start, tc.end, got, tc.want)
		}
	}
}

// TestExpandNodeList_LimitBoundary verifies the exact boundary around
// maxExpandedNodes: a range yielding precisely the limit succeeds, while one
// node over or under behaves as expected.
func TestExpandNodeList_LimitBoundary(t *testing.T) {
	t.Run("exactly at limit succeeds", func(t *testing.T) {
		input := fmt.Sprintf("node[1-%d]", maxExpandedNodes)
		got, err := ExpandNodeList(input)
		if err != nil {
			t.Fatalf("ExpandNodeList(%q) unexpected error: %v", input, err)
		}
		if len(got) != maxExpandedNodes {
			t.Fatalf("ExpandNodeList(%q) returned %d nodes, want %d", input, len(got), maxExpandedNodes)
		}
		if got[0] != "node1" || got[len(got)-1] != fmt.Sprintf("node%d", maxExpandedNodes) {
			t.Errorf("ExpandNodeList(%q) endpoints = [%q, ... %q], want [node1, ... node%d]", input, got[0], got[len(got)-1], maxExpandedNodes)
		}
	})

	t.Run("one over limit fails", func(t *testing.T) {
		input := fmt.Sprintf("node[1-%d]", maxExpandedNodes+1)
		got, err := ExpandNodeList(input)
		if err == nil {
			t.Fatalf("ExpandNodeList(%q) error = nil, want error", input)
		}
		if got != nil {
			t.Fatalf("ExpandNodeList(%q) = %v, want nil", input, got)
		}
	})

	t.Run("one under limit succeeds", func(t *testing.T) {
		input := fmt.Sprintf("node[1-%d]", maxExpandedNodes-1)
		got, err := ExpandNodeList(input)
		if err != nil {
			t.Fatalf("ExpandNodeList(%q) unexpected error: %v", input, err)
		}
		if len(got) != maxExpandedNodes-1 {
			t.Fatalf("ExpandNodeList(%q) returned %d nodes, want %d", input, len(got), maxExpandedNodes-1)
		}
	})

	t.Run("limit exceeded across comma-separated parts", func(t *testing.T) {
		// Two ranges that individually stay under the limit but together
		// exceed it must still be rejected.
		half := maxExpandedNodes/2 + 1
		input := fmt.Sprintf("a[1-%d],b[1-%d]", half, half)
		got, err := ExpandNodeList(input)
		if err == nil {
			t.Fatalf("ExpandNodeList(%q) error = nil, want error", input)
		}
		if got != nil {
			t.Fatalf("ExpandNodeList(%q) = %v, want nil", input, got)
		}
	})
}

// TestExpandNodeList_LimitErrorIsSentinel confirms the internal sentinel
// error survives unwrapped to the caller for the overflow case, matching
// pre-existing behavior (no "expanding %q: " wrapper for this specific error).
func TestExpandNodeList_LimitErrorIsSentinel(t *testing.T) {
	input := fmt.Sprintf("node[1-%d]", maxExpandedNodes+1)
	_, err := ExpandNodeList(input)
	if err == nil {
		t.Fatalf("ExpandNodeList(%q) error = nil, want error", input)
	}
	if !errors.Is(err, errNodeLimitExceeded) {
		t.Errorf("ExpandNodeList(%q) error = %v, want errNodeLimitExceeded", input, err)
	}
	if strings.Contains(err.Error(), "expanding") {
		t.Errorf("ExpandNodeList(%q) error = %q, should not be wrapped with 'expanding' prefix", input, err.Error())
	}
}

// TestExpandNodeList_NestedLimitBoundary is a regression test for
// double-counting in nested patterns (e.g. "rack[1-N]-node[01-01]"): the
// outer bracket's indices must not be counted separately from the final
// nodes produced by the recursive (leaf) expansion, or an under-the-limit
// input would be incorrectly rejected.
func TestExpandNodeList_NestedLimitBoundary(t *testing.T) {
	t.Run("under limit succeeds without double counting", func(t *testing.T) {
		input := fmt.Sprintf("rack[1-%d]-node[01-01]", maxExpandedNodes-1)
		got, err := ExpandNodeList(input)
		if err != nil {
			t.Fatalf("ExpandNodeList(%q) unexpected error: %v", input, err)
		}
		if len(got) != maxExpandedNodes-1 {
			t.Fatalf("ExpandNodeList(%q) returned %d nodes, want %d", input, len(got), maxExpandedNodes-1)
		}
		if got[0] != "rack1-node01" || got[len(got)-1] != fmt.Sprintf("rack%d-node01", maxExpandedNodes-1) {
			t.Errorf("ExpandNodeList(%q) endpoints = [%q, ... %q]", input, got[0], got[len(got)-1])
		}
	})

	t.Run("exactly at limit succeeds", func(t *testing.T) {
		input := fmt.Sprintf("rack[1-%d]-node[01-01]", maxExpandedNodes)
		got, err := ExpandNodeList(input)
		if err != nil {
			t.Fatalf("ExpandNodeList(%q) unexpected error: %v", input, err)
		}
		if len(got) != maxExpandedNodes {
			t.Fatalf("ExpandNodeList(%q) returned %d nodes, want %d", input, len(got), maxExpandedNodes)
		}
	})

	t.Run("one over limit fails", func(t *testing.T) {
		input := fmt.Sprintf("rack[1-%d]-node[01-01]", maxExpandedNodes+1)
		got, err := ExpandNodeList(input)
		if err == nil {
			t.Fatalf("ExpandNodeList(%q) error = nil, want error", input)
		}
		if got != nil {
			t.Fatalf("ExpandNodeList(%q) = %v, want nil", input, got)
		}
	})

	t.Run("huge nested outer range fails fast", func(t *testing.T) {
		input := "node[1-999999999]-suffix[1-2]"
		got, err := ExpandNodeList(input)
		if err == nil {
			t.Fatalf("ExpandNodeList(%q) error = nil, want error", input)
		}
		if got != nil {
			t.Fatalf("ExpandNodeList(%q) = %v, want nil", input, got)
		}
	})
}

// TestExpandNodeList_EdgeCases pins down less common inputs: empty and
// reversed ranges, literal indices next to ranges in nested brackets, and the
// exact error text for malformed ranges.
func TestExpandNodeList_EdgeCases(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []string
		wantErr  string
	}{
		{
			name:     "empty brackets yield the bare prefix",
			input:    "node[]",
			expected: []string{"node"},
		},
		{
			name:     "reversed range yields no nodes",
			input:    "node[3-1],other",
			expected: []string{"other"},
		},
		{
			name:     "adjacent brackets are expanded as nested patterns",
			input:    "n[1-2][3-4]",
			expected: []string{"n13", "n14", "n23", "n24"},
		},
		{
			name:     "literal indices in nested brackets",
			input:    "r[1,3]-n[a,b]",
			expected: []string{"r1-na", "r1-nb", "r3-na", "r3-nb"},
		},
		{
			name:     "zero padding follows the range start width",
			input:    "n[08-10]",
			expected: []string{"n08", "n09", "n10"},
		},
		{
			name:    "invalid range start",
			input:   "n[a-2]",
			wantErr: `expanding "n[a-2]": invalid range start "a": strconv.Atoi: parsing "a": invalid syntax`,
		},
		{
			name:    "invalid range end",
			input:   "n[1-b]",
			wantErr: `expanding "n[1-b]": invalid range end "b": strconv.Atoi: parsing "b": invalid syntax`,
		},
		{
			name:    "bracket inside a range is not supported",
			input:   "node[1-[2-3]]",
			wantErr: `expanding "node[1-[2-3]]": invalid range end "[2-3": strconv.Atoi: parsing "[2-3": invalid syntax`,
		},
		{
			name:    "unmatched bracket message",
			input:   "ok,node[1-3",
			wantErr: `expanding "node[1-3": unmatched bracket in "node[1-3"`,
		},
		{
			name:    "nested bracket in a literal index is not supported",
			input:   "a[[1]]",
			wantErr: `expanding "a[[1]]": nested bracket in index "[1"`,
		},
		{
			name:    "nested bracket in a later literal index is not supported",
			input:   "a[1,[2]]b",
			wantErr: `expanding "a[1,[2]]b": nested bracket in index "[2"`,
		},
		{
			name:     "reversed range in a nested bracket yields no nodes",
			input:    "r[1-3]-n[2-1],other",
			expected: []string{"other"},
		},
		{
			name:    "malformed nested suffix is reported for the expanded part",
			input:   "r[1-2]-n[x-y]",
			wantErr: `expanding "r[1-2]-n[x-y]": invalid range start "x": strconv.Atoi: parsing "x": invalid syntax`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ExpandNodeList(tt.input)
			if tt.wantErr != "" {
				if err == nil || err.Error() != tt.wantErr {
					t.Fatalf("ExpandNodeList(%q) error = %v, want %q", tt.input, err, tt.wantErr)
				}
				if got != nil {
					t.Fatalf("ExpandNodeList(%q) = %v, want nil", tt.input, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ExpandNodeList(%q) unexpected error: %v", tt.input, err)
			}
			if strings.Join(got, ",") != strings.Join(tt.expected, ",") || len(got) != len(tt.expected) {
				t.Errorf("ExpandNodeList(%q) = %v, want %v", tt.input, got, tt.expected)
			}
		})
	}
}

// TestExpandNodeList_IntermediateLiteralLimit covers the budget check for a
// literal (non-range) index inside an intermediate bracket, which is checked
// together with the indices already collected from the same bracket.
func TestExpandNodeList_IntermediateLiteralLimit(t *testing.T) {
	t.Run("at limit succeeds", func(t *testing.T) {
		input := fmt.Sprintf("r[1-%d,x]-n[1]", maxExpandedNodes-1)
		got, err := ExpandNodeList(input)
		if err != nil {
			t.Fatalf("ExpandNodeList(%q) unexpected error: %v", input, err)
		}
		if len(got) != maxExpandedNodes || got[len(got)-1] != "rx-n1" {
			t.Fatalf("ExpandNodeList(%q) returned %d nodes ending in %q, want %d ending in %q", input, len(got), got[len(got)-1], maxExpandedNodes, "rx-n1")
		}
	})

	t.Run("one over limit fails", func(t *testing.T) {
		input := fmt.Sprintf("r[1-%d,x]-n[1]", maxExpandedNodes)
		got, err := ExpandNodeList(input)
		if !errors.Is(err, errNodeLimitExceeded) {
			t.Fatalf("ExpandNodeList(%q) error = %v, want errNodeLimitExceeded", input, err)
		}
		if got != nil {
			t.Fatalf("ExpandNodeList(%q) = %v, want nil", input, got)
		}
	})

	t.Run("limit error wins over a later malformed range", func(t *testing.T) {
		input := fmt.Sprintf("n[1-%d,x-y]", maxExpandedNodes+1)
		_, err := ExpandNodeList(input)
		if !errors.Is(err, errNodeLimitExceeded) {
			t.Fatalf("ExpandNodeList(%q) error = %v, want errNodeLimitExceeded", input, err)
		}
	})
}

// TestExpandNodeList_EmptyNestedExpansionIsBounded is a regression test for
// unbounded work: the intermediate-bracket budget assumes every index yields
// at least one node, which a reversed range in the innermost bracket broke,
// so this 30-byte list used to take on the order of 10^12 steps.
func TestExpandNodeList_EmptyNestedExpansionIsBounded(t *testing.T) {
	input := "a[1-9999][1-9999][1-9999][2-1]"
	got, err := expandWithDeadline(t, input)
	if err != nil {
		t.Fatalf("ExpandNodeList(%q) unexpected error: %v", input, err)
	}
	if got != nil {
		t.Fatalf("ExpandNodeList(%q) = %v, want nil", input, got)
	}
}
