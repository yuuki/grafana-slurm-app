package slurm

import (
	"errors"
	"fmt"
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
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
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
