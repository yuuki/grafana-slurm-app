package slurm

import (
	"strings"
	"testing"
)

func TestEscapeLike(t *testing.T) {
	got := escapeLike(`gpu\_%test`)
	want := `gpu\\\_\%test`

	if got != want {
		t.Fatalf("escapeLike() = %q, want %q", got, want)
	}
}

func TestBuildListJobsWhereClause_NodesRange(t *testing.T) {
	query, args := buildListJobsWhereClause(ListJobsOptions{
		NodesMin: 2,
		NodesMax: 8,
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
		NodesMin: 4,
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
		ElapsedMin: 3600,
		ElapsedMax: 86400,
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
		User:     "alice",
		NodesMin: 2,
		NodesMax: 8,
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
