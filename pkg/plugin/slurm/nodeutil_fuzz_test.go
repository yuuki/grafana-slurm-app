package slurm

import (
	"slices"
	"strings"
	"testing"
	"time"
)

// expandDeadline bounds a single ExpandNodeList call in the fuzz target. A
// well-behaved expansion of the largest allowed list takes milliseconds; the
// generous margin keeps a loaded machine from turning into a false alarm
// while still catching expansion work that grows without bound.
const expandDeadline = 10 * time.Second

// FuzzExpandNodeList feeds arbitrary node lists to ExpandNodeList. The
// nodelist column of slurmdbd is only well formed by convention, and every
// job row goes through this function on the request path.
func FuzzExpandNodeList(f *testing.F) {
	for _, seed := range []string{
		"",
		"gpu-node-001",
		"node[001-003]",
		"node[001-003,010]",
		"node[1-2],other[5-6]",
		"rack[1-2]-node[01-02]",
		"n[1-2][3-4]",
		"r[1,3]-n[a,b]",
		"n[08-10]",
		"node[]",
		"node[3-1],other",
		"a,,b",
		"node[1-3",
		"]x[",
		"a]b[c",
		"node[1-[2-3]]",
		"n[a-2]",
		"node[1-999999999]",
		"node[1-999999999]-suffix[1-2]",
		"r[1-9999,x]-n[1]",
		"a[[1]]",
		"a[1-9999][1-9999][2-1]",
	} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, nodeList string) {
		nodes, err := expandWithDeadline(t, nodeList)
		if err != nil {
			if nodes != nil {
				t.Fatalf("ExpandNodeList(%q) = %q with error %v, want nil nodes", nodeList, nodes, err)
			}
			return
		}
		if len(nodes) > maxExpandedNodes {
			t.Fatalf("ExpandNodeList(%q) returned %d nodes, over the limit of %d", nodeList, len(nodes), maxExpandedNodes)
		}
		// Expansion consumes every bracket and every separating comma, so
		// none of them can be part of a node name.
		for _, node := range nodes {
			if strings.ContainsAny(node, "[],") {
				t.Fatalf("ExpandNodeList(%q) returned node name %q containing hostlist syntax", nodeList, node)
			}
		}
		if nodeList == "" {
			if nodes != nil {
				t.Fatalf("ExpandNodeList(\"\") = %q, want nil", nodes)
			}
			return
		}
		if !strings.ContainsAny(nodeList, "[]") {
			// Without brackets a node list is plain comma-separated names.
			if want := strings.Split(nodeList, ","); !slices.Equal(nodes, want) {
				t.Fatalf("ExpandNodeList(%q) = %q, want %q", nodeList, nodes, want)
			}
			return
		}
		// Top-level parts expand independently and in order, and every node
		// of a part starts with the text in front of the part's first bracket.
		var joined []string
		for _, part := range splitTopLevel(nodeList, ',') {
			if part == "" {
				joined = append(joined, "")
				continue
			}
			partNodes, err := ExpandNodeList(part)
			if err != nil {
				t.Fatalf("ExpandNodeList(%q) succeeded but its part %q failed: %v", nodeList, part, err)
			}
			prefix, _, _ := strings.Cut(part, "[")
			for _, node := range partNodes {
				if !strings.HasPrefix(node, prefix) {
					t.Fatalf("ExpandNodeList(%q): node %q of part %q lacks prefix %q", nodeList, node, part, prefix)
				}
			}
			joined = append(joined, partNodes...)
		}
		if !slices.Equal(nodes, joined) {
			t.Fatalf("ExpandNodeList(%q) = %q, but its parts expand to %q", nodeList, nodes, joined)
		}
	})
}

// expandWithDeadline runs ExpandNodeList and fails the test when it does not
// return within expandDeadline (the expansion goroutine is then abandoned,
// which is fine for a test that is about to fail).
func expandWithDeadline(t *testing.T, nodeList string) ([]string, error) {
	t.Helper()
	type result struct {
		nodes []string
		err   error
	}
	done := make(chan result, 1)
	go func() {
		nodes, err := ExpandNodeList(nodeList)
		done <- result{nodes, err}
	}()
	select {
	case r := <-done:
		return r.nodes, r.err
	case <-time.After(expandDeadline):
		t.Fatalf("ExpandNodeList(%q) did not return within %s", nodeList, expandDeadline)
		return nil, nil
	}
}
