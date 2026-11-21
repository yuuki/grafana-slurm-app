package slurm

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseTRESGPUs(t *testing.T) {
	// gpuIDs mirrors tres_table having one aggregate "gpu" TRES (id 1001)
	// and two per-type "gpu:<type>" TRES (ids 1002, 1003), as Slurm creates
	// when AccountingStorageTRES lists typed GRES (e.g. gres/gpu:a100,gres/gpu:h100).
	gpuIDs := &gpuTRESIDSet{
		aggregate: map[int]struct{}{1001: {}},
		typed:     map[int]struct{}{1002: {}, 1003: {}},
	}

	tests := []struct {
		name       string
		tres       string
		gpuTRESIDs *gpuTRESIDSet
		want       int
	}{
		{name: "descriptive format gres/gpu", tres: "1=128,2=1048576,4=1,1001=gres/gpu:8", gpuTRESIDs: gpuIDs, want: 8},
		{name: "descriptive format gpu:N", tres: "1=128,2=1048576,4=1,1001=gpu:4", gpuTRESIDs: gpuIDs, want: 4},
		{name: "numeric-only format", tres: "1=128,2=1048576,4=1,1001=8", gpuTRESIDs: gpuIDs, want: 8},
		{name: "numeric-only format single GPU", tres: "1=32,2=524288,1001=1", gpuTRESIDs: gpuIDs, want: 1},
		{name: "no GPU TRES", tres: "1=128,2=1048576,4=1", gpuTRESIDs: gpuIDs, want: 0},
		{name: "empty string", tres: "", gpuTRESIDs: gpuIDs, want: 0},
		{name: "gres/gpu with nested colon", tres: "1=128,1001=gres/gpu:a100:64", gpuTRESIDs: gpuIDs, want: 64},
		{name: "unknown numeric ID is not GPU", tres: "1=128,2=1048576,1099=16", gpuTRESIDs: gpuIDs, want: 0},
		{name: "nil IDs ignores numeric-only format", tres: "1=128,1001=8", gpuTRESIDs: nil, want: 0},
		{name: "nil IDs still matches text format", tres: "1=128,1001=gres/gpu:8", gpuTRESIDs: nil, want: 8},
		{name: "heterogeneous GPU types summed without total", tres: "1=128,gres/gpu:a100=4,gres/gpu:h100=4", gpuTRESIDs: gpuIDs, want: 8},
		{name: "total entry takes precedence over per-type entries", tres: "1=128,gres/gpu=8,gres/gpu:a100=4,gres/gpu:h100=4", gpuTRESIDs: gpuIDs, want: 8},
		{name: "no GPU entries at all returns zero", tres: "1=128,2=1048576,4=1,5=128", gpuTRESIDs: gpuIDs, want: 0},
		{name: "numeric aggregate takes precedence over numeric typed", tres: "1=128,1001=8,1002=4", gpuTRESIDs: gpuIDs, want: 8},
		{name: "numeric typed IDs summed without aggregate", tres: "1=128,1002=4,1003=4", gpuTRESIDs: gpuIDs, want: 8},
		{name: "non-GPU TRES with gpu: substring is not counted", tres: "1=128,license/gpu:a100=2", gpuTRESIDs: gpuIDs, want: 0},
		{name: "duplicate GPU type entries are summed", tres: "gres/gpu:a100=4,gres/gpu:a100=4", gpuTRESIDs: gpuIDs, want: 8},
		{name: "malformed GPU value yields zero for that entry", tres: "1=128,gres/gpu:a100=notanumber", gpuTRESIDs: gpuIDs, want: 0},
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

func TestSuspendedSeconds(t *testing.T) {
	const start = 1700000000
	tests := []struct {
		name          string
		timeSuspended int64
		state         string
		startTime     int64
		want          int64
	}{
		{"never suspended", 0, "COMPLETED", start, 0},
		{"suspended and resumed: the total", 600, "COMPLETED", start, 600},
		{"suspended and resumed, still running", 600, "RUNNING", start, 600},
		{"a long total is still a duration", start - 1, "COMPLETED", start, start - 1},
		{"suspended now", start + 1800, "SUSPENDED", start, SuspendedUnknown},
		{"suspended now, column not written yet", 0, "SUSPENDED", start, SuspendedUnknown},
		{"suspended now, small column value", 600, "SUSPENDED", start, SuspendedUnknown},
		{"ended while suspended: not a duration", start + 1800, "CANCELLED", start, SuspendedUnknown},
		{"the smallest value that is not a duration", start, "COMPLETED", start, SuspendedUnknown},
		{"a job that never started has no suspension to misread", 5, "PENDING", 0, 5},
		{"a negative value is no suspension", -5, "COMPLETED", start, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := suspendedSeconds(tt.timeSuspended, tt.state, tt.startTime); got != tt.want {
				t.Errorf("suspendedSeconds(%d, %q, %d) = %d, want %d", tt.timeSuspended, tt.state, tt.startTime, got, tt.want)
			}
		})
	}
}

func TestTimeLimitSeconds(t *testing.T) {
	tests := []struct {
		name    string
		minutes int64
		want    int64
	}{
		{"not set", 0, 0},
		{"one minute", 1, 60},
		{"two days", 2880, 172800},
		{"the largest limit", 0xfffffffd, 0xfffffffd * 60},
		{"NO_VAL", 0xfffffffe, 0},
		{"INFINITE", 0xffffffff, 0},
		{"negative", -1, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := timeLimitSeconds(tt.minutes); got != tt.want {
				t.Errorf("timeLimitSeconds(%d) = %d, want %d", tt.minutes, got, tt.want)
			}
		})
	}
}

func TestParseTRESCPUs(t *testing.T) {
	tests := []struct {
		name string
		tres string
		want int
	}{
		{name: "numeric ID as stored by slurmdbd", tres: "1=128,2=1048576,4=1,5=128,1001=8", want: 128},
		{name: "cpu entry not first", tres: "2=1048576,4=1,1=64", want: 64},
		{name: "descriptive key", tres: "cpu=32,mem=128G,node=1,gres/gpu=4", want: 32},
		{name: "no cpu entry", tres: "2=1048576,4=1,1001=8", want: 0},
		{name: "empty string", tres: "", want: 0},
		{name: "other IDs ending in 1 are not cpu", tres: "11=4,21=8,1001=16", want: 0},
		{name: "GPU value under another key is not cpu", tres: "1001=1", want: 0},
		{name: "malformed count", tres: "1=many", want: 0},
		{name: "negative count", tres: "1=-8", want: 0},
		{name: "count beyond int", tres: "1=99999999999999999999999", want: 0},
		{name: "last cpu entry wins", tres: "1=8,cpu=16", want: 16},
		{name: "entry without value", tres: "1,2=4", want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseTRESCPUs(tt.tres); got != tt.want {
				t.Errorf("parseTRESCPUs(%q) = %d, want %d", tt.tres, got, tt.want)
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

func TestBuildListJobsWhereClause_TimeRangeMatchesOverlappingJobs(t *testing.T) {
	query, args := buildListJobsWhereClause(ListJobsOptions{
		From: 1700000000,
		To:   1700003600,
	})
	if !strings.Contains(query, "j.time_start <= ?") {
		t.Fatalf("expected upper start-time overlap condition, got %q", query)
	}
	if !strings.Contains(query, "((j.time_end = 0 AND j.time_start > 0) OR j.time_end >= ?)") {
		t.Fatalf("expected end-time overlap condition, got %q", query)
	}
	if strings.Contains(query, "j.time_start >= ?") {
		t.Fatalf("range filter should not require jobs to start inside the range, got %q", query)
	}
	if len(args) != 2 || args[0] != int64(1700003600) || args[1] != int64(1700000000) {
		t.Fatalf("expected args [1700003600, 1700000000], got %v", args)
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

func TestMatchNodeFilter(t *testing.T) {
	tests := []struct {
		name        string
		jobNodes    []string
		filterNodes []string
		mode        string
		want        bool
	}{
		{name: "OR match single", jobNodes: []string{"node001", "node002"}, filterNodes: []string{"node001"}, mode: "OR", want: true},
		{name: "OR no match", jobNodes: []string{"node001", "node002"}, filterNodes: []string{"node003"}, mode: "OR", want: false},
		{name: "OR match any", jobNodes: []string{"node001", "node002"}, filterNodes: []string{"node003", "node001"}, mode: "OR", want: true},
		{name: "AND match all", jobNodes: []string{"node001", "node002", "node003"}, filterNodes: []string{"node001", "node003"}, mode: "AND", want: true},
		{name: "AND partial mismatch", jobNodes: []string{"node001", "node002"}, filterNodes: []string{"node001", "node003"}, mode: "AND", want: false},
		{name: "empty filter matches all", jobNodes: []string{"node001"}, filterNodes: nil, mode: "OR", want: true},
		{name: "empty job nodes no match", jobNodes: nil, filterNodes: []string{"node001"}, mode: "OR", want: false},
		{name: "default mode is OR", jobNodes: []string{"node001"}, filterNodes: []string{"node001"}, mode: "", want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			filterSet := make(map[string]struct{}, len(tt.filterNodes))
			for _, n := range tt.filterNodes {
				filterSet[n] = struct{}{}
			}
			got := matchNodeFilter(tt.jobNodes, filterSet, tt.mode)
			if got != tt.want {
				t.Errorf("matchNodeFilter(%v, %v, %q) = %v, want %v", tt.jobNodes, tt.filterNodes, tt.mode, got, tt.want)
			}
		})
	}
}

func TestBuildListJobsWhereClause_NodeNames_OR(t *testing.T) {
	query, args := buildListJobsWhereClause(ListJobsOptions{
		JobFilter: JobFilter{NodeNames: []string{"node001", "node002"}},
	})
	if !strings.Contains(query, "j.nodelist LIKE ?") {
		t.Fatalf("expected nodelist LIKE condition, got %q", query)
	}
	if !strings.Contains(query, " OR ") {
		t.Fatalf("expected OR between conditions, got %q", query)
	}
	// 2 LIKE args
	if len(args) != 2 {
		t.Fatalf("expected 2 args, got %d: %v", len(args), args)
	}
}

func TestBuildListJobsWhereClause_NodeNames_AND(t *testing.T) {
	query, args := buildListJobsWhereClause(ListJobsOptions{
		JobFilter: JobFilter{NodeNames: []string{"node001", "node002"}, NodeMatchMode: NodeMatchAND},
	})
	if !strings.Contains(query, " AND j.nodelist LIKE ?") {
		t.Fatalf("expected nodelist LIKE condition, got %q", query)
	}
	// The inner conditions should be joined with AND
	// Pattern: AND (j.nodelist LIKE ? AND j.nodelist LIKE ?)
	if strings.Contains(query, " OR ") {
		t.Fatalf("unexpected OR in AND mode, got %q", query)
	}
	if len(args) != 2 {
		t.Fatalf("expected 2 args, got %d: %v", len(args), args)
	}
}

func TestAppendJobFilterClauses_EscapesNodeNameLikeSpecialChars(t *testing.T) {
	_, args := appendJobFilterClauses("", nil, JobFilter{NodeNames: []string{"node_01%"}}, "")
	const wantLikeArg = `%node\_01\%%`
	if len(args) != 1 {
		t.Fatalf("expected 1 LIKE arg, got %d: %v", len(args), args)
	}
	got, ok := args[0].(string)
	if !ok || got != wantLikeArg {
		t.Fatalf("LIKE arg = %#v, want %q", args[0], wantLikeArg)
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

// TestAppendJobFilterClauses_PinsSQLAndArgs pins the exact SQL fragment and
// argument order (including dynamic arg types) produced for each filter
// combination, so refactors cannot silently reorder or reshape the query.
func TestAppendJobFilterClauses_PinsSQLAndArgs(t *testing.T) {
	const (
		elapsedExpr = " AND (CASE WHEN j.time_end = 0 THEN UNIX_TIMESTAMP() ELSE j.time_end END) - j.time_start"
		allSQL      = " AND a.user = ? AND a.acct = ? AND j.`partition` = ? AND j.state = ? AND j.job_name LIKE ?" +
			" AND j.nodes_alloc >= ? AND j.nodes_alloc <= ? AND j.time_start > 0" +
			elapsedExpr + " >= ?" + elapsedExpr + " <= ?" +
			" AND (j.nodelist LIKE ? OR j.nodelist LIKE ?)"
	)
	all := JobFilter{
		User: "alice", Account: "proj", Partition: "gpu", State: "failed", Name: "train_%",
		NodesMin: 2, NodesMax: 8, ElapsedMin: 60, ElapsedMax: 3600,
		NodeNames: []string{"node001", "node_02"},
	}
	allArgs := []interface{}{"alice", "proj", "gpu", 5, `%train\_\%%`, 2, 8, int64(60), int64(3600), "%node001%", `%node\_02%`}

	tests := []struct {
		name      string
		query     string
		args      []interface{}
		filter    JobFilter
		exclude   string
		wantQuery string
		wantArgs  []interface{}
	}{
		{name: "empty filter", filter: JobFilter{}, wantQuery: "", wantArgs: nil},
		{name: "all fields", filter: all, wantQuery: allSQL, wantArgs: allArgs},
		{
			name: "exclude user", filter: all, exclude: "user",
			wantQuery: strings.Replace(allSQL, " AND a.user = ?", "", 1),
			wantArgs:  allArgs[1:],
		},
		{
			name: "exclude account", filter: all, exclude: "account",
			wantQuery: strings.Replace(allSQL, " AND a.acct = ?", "", 1),
			wantArgs:  append([]interface{}{allArgs[0]}, allArgs[2:]...),
		},
		{
			name: "exclude partition", filter: all, exclude: "partition",
			wantQuery: strings.Replace(allSQL, " AND j.`partition` = ?", "", 1),
			wantArgs:  append(append([]interface{}{}, allArgs[:2]...), allArgs[3:]...),
		},
		{
			name: "exclude name", filter: all, exclude: "name",
			wantQuery: strings.Replace(allSQL, " AND j.job_name LIKE ?", "", 1),
			wantArgs:  append(append([]interface{}{}, allArgs[:4]...), allArgs[5:]...),
		},
		{
			name: "state is never excluded", filter: JobFilter{State: "RUNNING"}, exclude: "state",
			wantQuery: " AND j.state = ?", wantArgs: []interface{}{1},
		},
		{name: "unknown state is ignored", filter: JobFilter{State: "bogus"}, wantQuery: "", wantArgs: nil},
		{name: "state is case-insensitive", filter: JobFilter{State: "node_fail"}, wantQuery: " AND j.state = ?", wantArgs: []interface{}{7}},
		{name: "non-positive ranges are ignored", filter: JobFilter{NodesMin: -1, NodesMax: 0, ElapsedMin: -5}, wantQuery: "", wantArgs: nil},
		{
			name: "elapsed min only", filter: JobFilter{ElapsedMin: 60},
			wantQuery: " AND j.time_start > 0" + elapsedExpr + " >= ?", wantArgs: []interface{}{int64(60)},
		},
		{
			name: "elapsed max only", filter: JobFilter{ElapsedMax: 3600},
			wantQuery: " AND j.time_start > 0" + elapsedExpr + " <= ?", wantArgs: []interface{}{int64(3600)},
		},
		{name: "empty node names", filter: JobFilter{NodeNames: []string{}}, wantQuery: "", wantArgs: nil},
		{
			name: "node names AND", filter: JobFilter{NodeNames: []string{"a", "b"}, NodeMatchMode: NodeMatchAND},
			wantQuery: " AND (j.nodelist LIKE ? AND j.nodelist LIKE ?)", wantArgs: []interface{}{"%a%", "%b%"},
		},
		{
			name: "unknown node match mode falls back to OR", filter: JobFilter{NodeNames: []string{"a"}, NodeMatchMode: "and"},
			wantQuery: " AND (j.nodelist LIKE ?)", wantArgs: []interface{}{"%a%"},
		},
		{
			name: "appends to existing query and args", query: " WHERE 1=1", args: []interface{}{"q"},
			filter: JobFilter{User: "bob", NodesMax: 4}, exclude: "user",
			wantQuery: " WHERE 1=1 AND j.nodes_alloc <= ?", wantArgs: []interface{}{"q", 4},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotQuery, gotArgs := appendJobFilterClauses(tt.query, tt.args, tt.filter, tt.exclude)
			if gotQuery != tt.wantQuery {
				t.Errorf("query = %q\nwant    %q", gotQuery, tt.wantQuery)
			}
			if !reflect.DeepEqual(gotArgs, tt.wantArgs) {
				t.Errorf("args = %#v\nwant   %#v", gotArgs, tt.wantArgs)
			}
		})
	}
}
