package slurm

import (
	"strings"
	"testing"
)

func TestParseTRESGPUs(t *testing.T) {
	gpuIDs := map[int]struct{}{1001: {}}

	tests := []struct {
		name      string
		tres      string
		gpuTRESIDs map[int]struct{}
		want      int
	}{
		{name: "descriptive format gres/gpu", tres: "1=128,2=1048576,4=1,1001=gres/gpu:8", gpuTRESIDs: gpuIDs, want: 8},
		{name: "descriptive format gpu:N", tres: "1=128,2=1048576,4=1,1001=gpu:4", gpuTRESIDs: gpuIDs, want: 4},
		{name: "numeric-only format", tres: "1=128,2=1048576,4=1,1001=8", gpuTRESIDs: gpuIDs, want: 8},
		{name: "numeric-only format single GPU", tres: "1=32,2=524288,1001=1", gpuTRESIDs: gpuIDs, want: 1},
		{name: "no GPU TRES", tres: "1=128,2=1048576,4=1", gpuTRESIDs: gpuIDs, want: 0},
		{name: "empty string", tres: "", gpuTRESIDs: gpuIDs, want: 0},
		{name: "gres/gpu with nested colon", tres: "1=128,1001=gres/gpu:a100:64", gpuTRESIDs: gpuIDs, want: 64},
		{name: "unknown numeric ID is not GPU", tres: "1=128,2=1048576,1002=16", gpuTRESIDs: gpuIDs, want: 0},
		{name: "nil IDs ignores numeric-only format", tres: "1=128,1001=8", gpuTRESIDs: nil, want: 0},
		{name: "nil IDs still matches text format", tres: "1=128,1001=gres/gpu:8", gpuTRESIDs: nil, want: 8},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseTRESGPUs(tt.tres, tt.gpuTRESIDs)
			if got != tt.want {
				t.Errorf("parseTRESGPUs(%q) = %d, want %d", tt.tres, got, tt.want)
			}
		})
	}
}

func TestEscapeLike(t *testing.T) {
	got := escapeLike(`gpu\_%test`)
	want := `gpu\\\_\%test`

	if got != want {
		t.Fatalf("escapeLike() = %q, want %q", got, want)
	}
}

func TestBuildListJobsWhereClause_NodesRange(t *testing.T) {
	query, args := buildListJobsWhereClause(ListJobsOptions{
		JobFilter: JobFilter{NodesMin: 2, NodesMax: 8},
	})
	if !strings.Contains(query, "j.nodes_alloc >= ?") {
		t.Fatalf("expected nodes_alloc >= condition, got %q", query)
	}
	if !strings.Contains(query, "j.nodes_alloc <= ?") {
		t.Fatalf("expected nodes_alloc <= condition, got %q", query)
	}
	if len(args) != 2 || args[0] != 2 || args[1] != 8 {
		t.Fatalf("expected args [2, 8], got %v", args)
	}
}

func TestBuildListJobsWhereClause_NodesMinOnly(t *testing.T) {
	query, args := buildListJobsWhereClause(ListJobsOptions{
		JobFilter: JobFilter{NodesMin: 4},
	})
	if !strings.Contains(query, "j.nodes_alloc >= ?") {
		t.Fatalf("expected nodes_alloc >= condition, got %q", query)
	}
	if strings.Contains(query, "j.nodes_alloc <= ?") {
		t.Fatalf("unexpected nodes_alloc <= condition, got %q", query)
	}
	if len(args) != 1 || args[0] != 4 {
		t.Fatalf("expected args [4], got %v", args)
	}
}

func TestBuildListJobsWhereClause_ElapsedRange(t *testing.T) {
	query, args := buildListJobsWhereClause(ListJobsOptions{
		JobFilter: JobFilter{ElapsedMin: 3600, ElapsedMax: 86400},
	})
	if !strings.Contains(query, "j.time_start > 0") {
		t.Fatalf("expected time_start > 0 guard for PENDING jobs, got %q", query)
	}
	if !strings.Contains(query, "CASE WHEN j.time_end = 0 THEN UNIX_TIMESTAMP() ELSE j.time_end END") {
		t.Fatalf("expected CASE WHEN expression, got %q", query)
	}
	if strings.Count(query, "time_start >= ?") != 1 {
		t.Fatalf("expected elapsed min condition, got %q", query)
	}
	if strings.Count(query, "time_start <= ?") != 1 {
		t.Fatalf("expected elapsed max condition, got %q", query)
	}
	if len(args) != 2 || args[0] != int64(3600) || args[1] != int64(86400) {
		t.Fatalf("expected args [3600, 86400], got %v", args)
	}
}

func TestBuildListJobsWhereClause_CombinedFilters(t *testing.T) {
	query, args := buildListJobsWhereClause(ListJobsOptions{
		JobFilter: JobFilter{User: "alice", NodesMin: 2, NodesMax: 8},
	})
	if !strings.Contains(query, "a.user = ?") {
		t.Fatalf("expected user condition, got %q", query)
	}
	if !strings.Contains(query, "j.nodes_alloc >= ?") {
		t.Fatalf("expected nodes_alloc >= condition, got %q", query)
	}
	if len(args) != 3 {
		t.Fatalf("expected 3 args, got %d", len(args))
	}
}

func TestAppendJobFilterClauses_ExcludesMetadataField(t *testing.T) {
	query, args := appendJobFilterClauses("", nil, JobFilter{
		User:      "alice",
		Partition: "gpu-a100",
		NodesMin:  4,
	}, "user")
	if strings.Contains(query, "a.user = ?") {
		t.Fatalf("user condition should be excluded when excludeField=user, got %q", query)
	}
	if !strings.Contains(query, "j.`partition` = ?") {
		t.Fatalf("expected partition condition, got %q", query)
	}
	if !strings.Contains(query, "j.nodes_alloc >= ?") {
		t.Fatalf("expected nodes_alloc condition, got %q", query)
	}
	if len(args) != 2 {
		t.Fatalf("expected 2 args, got %d", len(args))
	}
}
