package slurm

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// Query-shape regexes used to keep sqlmock expectations tied to a specific
// statement instead of matching anything (".*"), so a test only passes when
// the code actually issues the query it claims to.
//
// Each pattern anchors on the exact backtick-quoted table name immediately
// followed by its query alias (e.g. "`testcluster_job_table` j"), which
// repository.go always emits verbatim via jobTable()/assocTable(). This
// rules out accidental matches against a differently-named or suffixed
// table (e.g. a hypothetical "..._job_table_archive"), since that string
// would not close its backtick and alias at the same position. Each
// pattern also requires the WHERE-clause fragment repository.go always
// attaches to that particular query, so the count query, the row-select
// query, the node-filter row-select query, GetJob's single-row query, and
// the tres_table lookup can never be confused with one another or with a
// differently-filtered variant of the same statement.
const (
	reJobTableAlias         = "`testcluster_job_table` j"
	reCountQuery            = "(?s)SELECT COUNT\\(\\*\\).*" + reJobTableAlias + ".*WHERE 1=1"
	reSelectQuery           = "(?s)SELECT.*" + reJobTableAlias + ".*WHERE 1=1.*ORDER BY j\\.time_start DESC LIMIT \\? OFFSET \\?$"
	reNodeFilterSelectQuery = "(?s)SELECT.*" + reJobTableAlias + ".*WHERE 1=1.*ORDER BY j\\.time_start DESC LIMIT \\?$"
	reNodeStatsQuery        = "(?s)SELECT j\\.state, j\\.nodelist, j\\.time_end, COALESCE\\(j\\.failed_node, ''\\).*" + reJobTableAlias + ".*WHERE j\\.time_end >= \\? AND j\\.time_end <= \\? AND j\\.time_end > 0 AND j\\.state IN \\(\\?, \\?, \\?\\).*ORDER BY j\\.time_end DESC LIMIT \\?$"
	reTresQuery             = "(?s)SELECT id, name FROM tres_table WHERE type = 'gres'"
	reGetJobQuery           = "(?s)SELECT.*" + reJobTableAlias + ".*WHERE j\\.id_job = \\?$"
)

// metadataFieldExpr returns the COALESCE expression repository.go generates
// for a given ListMetadataValues field, so tests can assert the query
// targets the expected column rather than any arbitrary SQL.
func metadataFieldExpr(field string) string {
	switch field {
	case "name":
		return `COALESCE\(j\.job_name, ''\)`
	case "user":
		return `COALESCE\(a\.user, ''\)`
	case "account":
		return `COALESCE\(a\.acct, ''\)`
	case "partition":
		return `COALESCE\(j\.partition, ''\)`
	default:
		return ""
	}
}

func TestListNodeStatsJobs(t *testing.T) {
	const (
		from  = int64(100)
		to    = int64(200)
		limit = int64(10)
	)
	nodeStatsColumns := []string{"state", "nodelist", "time_end", "failed_node"}

	t.Run("returns projected jobs in query order", func(t *testing.T) {
		repo, mock := newMockRepository(t)
		mock.ExpectQuery(reNodeStatsQuery).
			WithArgs(from, to, 3, 5, 7, limit+1).
			WillReturnRows(sqlmock.NewRows(nodeStatsColumns).
				AddRow(7, "node003", 190, "node003").
				AddRow(5, "node[001-002]", 180, "").
				AddRow(3, "node004", 170, ""))

		jobs, truncated, err := repo.ListNodeStatsJobs(context.Background(), from, to, limit)
		if err != nil {
			t.Fatalf("ListNodeStatsJobs() error = %v", err)
		}
		if truncated {
			t.Fatal("truncated = true, want false")
		}
		if len(jobs) != 3 {
			t.Fatalf("len(jobs) = %d, want 3", len(jobs))
		}
		wantStates := []string{"NODE_FAIL", "FAILED", "COMPLETED"}
		for i, want := range wantStates {
			if jobs[i].State != want {
				t.Errorf("jobs[%d].State = %q, want %q", i, jobs[i].State, want)
			}
		}
		if jobs[0].NodeList != "node003" || jobs[0].EndTime != 190 || jobs[0].FailedNode != "node003" {
			t.Errorf("jobs[0] = %#v, want all projected fields populated", jobs[0])
		}
	})

	t.Run("reports truncation and returns only the requested limit", func(t *testing.T) {
		repo, mock := newMockRepository(t)
		const smallLimit = int64(2)
		mock.ExpectQuery(reNodeStatsQuery).
			WithArgs(from, to, 3, 5, 7, smallLimit+1).
			WillReturnRows(sqlmock.NewRows(nodeStatsColumns).
				AddRow(5, "node001", 190, "").
				AddRow(5, "node002", 180, "").
				AddRow(5, "node003", 170, ""))

		jobs, truncated, err := repo.ListNodeStatsJobs(context.Background(), from, to, smallLimit)
		if err != nil {
			t.Fatalf("ListNodeStatsJobs() error = %v", err)
		}
		if !truncated {
			t.Fatal("truncated = false, want true")
		}
		if len(jobs) != int(smallLimit) {
			t.Fatalf("len(jobs) = %d, want %d", len(jobs), smallLimit)
		}
	})

	t.Run("normalizes null failed node to empty string", func(t *testing.T) {
		repo, mock := newMockRepository(t)
		mock.ExpectQuery(reNodeStatsQuery).
			WithArgs(from, to, 3, 5, 7, limit+1).
			WillReturnRows(sqlmock.NewRows(nodeStatsColumns).AddRow(5, "node001", 190, nil))

		jobs, truncated, err := repo.ListNodeStatsJobs(context.Background(), from, to, limit)
		if err != nil {
			t.Fatalf("ListNodeStatsJobs() error = %v", err)
		}
		if truncated || len(jobs) != 1 {
			t.Fatalf("jobs=%#v truncated=%v, want one non-truncated row", jobs, truncated)
		}
		if jobs[0].FailedNode != "" {
			t.Errorf("FailedNode = %q, want empty string", jobs[0].FailedNode)
		}
	})

	t.Run("propagates query errors", func(t *testing.T) {
		repo, mock := newMockRepository(t)
		wantErr := errors.New("database unavailable")
		mock.ExpectQuery(reNodeStatsQuery).
			WithArgs(from, to, 3, 5, 7, limit+1).
			WillReturnError(wantErr)

		_, _, err := repo.ListNodeStatsJobs(context.Background(), from, to, limit)
		if !errors.Is(err, wantErr) {
			t.Fatalf("ListNodeStatsJobs() error = %v, want wrapped %v", err, wantErr)
		}
	})
}

// newMockRepository creates a Repository backed by a go-sqlmock database so
// query-building and scanning logic can be exercised without a real MySQL
// instance. It registers a cleanup that fails the test if any expectation
// set on mock was never triggered, so a test that forgets to invoke a code
// path it claims to cover (e.g. Close/Ping never actually being called)
// cannot pass silently.
func newMockRepository(t *testing.T) (*Repository, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	t.Cleanup(func() {
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Errorf("unmet sqlmock expectations: %v", err)
		}
		_ = db.Close()
	})
	return &Repository{db: db, clusterName: "testcluster"}, mock
}

// newMockRepositoryWithPingMonitoring is like newMockRepository but enables
// ping expectation tracking, needed for tests that call Repository.Ping.
func newMockRepositoryWithPingMonitoring(t *testing.T) (*Repository, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	t.Cleanup(func() {
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Errorf("unmet sqlmock expectations: %v", err)
		}
		_ = db.Close()
	})
	return &Repository{db: db, clusterName: "testcluster"}, mock
}

func jobRowColumns() []string {
	return []string{
		"id_job", "job_name", "user", "acct", "partition", "state",
		"nodelist", "nodes_alloc", "time_submit", "time_start", "time_end",
		"exit_code", "work_dir", "tres_alloc", "failed_node",
	}
}

func TestNewRepository_InvalidClusterName(t *testing.T) {
	_, err := NewRepository("user:pass@tcp(127.0.0.1:3306)/dbname", "bad name!")
	if err == nil {
		t.Fatal("expected error for invalid cluster name, got nil")
	}
}

func TestNewRepository_Valid(t *testing.T) {
	repo, err := NewRepository("user:pass@tcp(127.0.0.1:3306)/dbname", "valid_cluster-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo == nil {
		t.Fatal("expected non-nil repository")
	}
	defer repo.Close()

	if got := repo.jobTable(); got != "`valid_cluster-1_job_table`" {
		t.Errorf("jobTable() = %q, want backtick-quoted name", got)
	}
	if got := repo.assocTable(); got != "`valid_cluster-1_assoc_table`" {
		t.Errorf("assocTable() = %q, want backtick-quoted name", got)
	}
}

func TestRepository_Close(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectClose()
	if err := repo.Close(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// mock.ExpectationsWereMet() (asserted in cleanup) fails unless Close()
	// above actually reached the driver, catching the case where Repository
	// silently no-ops instead of closing the underlying *sql.DB.
}

func TestRepository_Ping_Success(t *testing.T) {
	repo, mock := newMockRepositoryWithPingMonitoring(t)
	mock.ExpectPing()
	if err := repo.Ping(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRepository_Ping_Error(t *testing.T) {
	repo, mock := newMockRepositoryWithPingMonitoring(t)
	mock.ExpectPing().WillReturnError(errors.New("connection refused"))
	if err := repo.Ping(context.Background()); err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestListJobs_Success(t *testing.T) {
	repo, mock := newMockRepository(t)

	mock.ExpectQuery(reCountQuery).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery(reSelectQuery).
		WithArgs(int64(10), int64(0)).
		WillReturnRows(sqlmock.NewRows(jobRowColumns()).
			AddRow(1, "job1", "alice", "acctA", "gpu", 1, "node001", 1, 100, 200, 0, 0, "/work", "1001=gres/gpu:8", ""))
	mock.ExpectQuery(reTresQuery).WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))

	jobs, total, err := repo.ListJobs(context.Background(), ListJobsOptions{Limit: 10})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 1 {
		t.Errorf("total = %d, want 1", total)
	}
	if len(jobs) != 1 {
		t.Fatalf("len(jobs) = %d, want 1", len(jobs))
	}
	if jobs[0].State != "RUNNING" {
		t.Errorf("State = %q, want RUNNING", jobs[0].State)
	}
	if jobs[0].GPUsTotal != 8 {
		t.Errorf("GPUsTotal = %d, want 8", jobs[0].GPUsTotal)
	}
}

// TestListJobs_LimitDefaulting verifies that Limit values outside (0, 1000]
// are clamped to the default of 100, and that the clamped value (not the
// caller-supplied one) is the value actually bound into the SQL LIMIT
// argument.
func TestListJobs_LimitDefaulting(t *testing.T) {
	repo, mock := newMockRepository(t)

	const wantDefaultLimit = int64(100)

	mock.ExpectQuery(reCountQuery).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery(reSelectQuery).
		WithArgs(wantDefaultLimit, int64(0)).
		WillReturnRows(sqlmock.NewRows(jobRowColumns()))
	mock.ExpectQuery(reTresQuery).WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))

	_, _, err := repo.ListJobs(context.Background(), ListJobsOptions{Limit: 0})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// gpuTRESIDs is now cached, so the second call skips the tres_table query.
	mock.ExpectQuery(reCountQuery).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery(reSelectQuery).
		WithArgs(wantDefaultLimit, int64(0)).
		WillReturnRows(sqlmock.NewRows(jobRowColumns()))

	_, _, err = repo.ListJobs(context.Background(), ListJobsOptions{Limit: 5000})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestListJobs_CountQueryError(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reCountQuery).WillReturnError(errors.New("db down"))

	_, _, err := repo.ListJobs(context.Background(), ListJobsOptions{Limit: 10})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestListJobs_SelectQueryError(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reCountQuery).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery(reSelectQuery).
		WithArgs(int64(10), int64(0)).
		WillReturnError(errors.New("query failed"))

	_, _, err := repo.ListJobs(context.Background(), ListJobsOptions{Limit: 10})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestListJobs_ScanRowError(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reCountQuery).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	// Missing columns triggers a scan error inside scanJobs.
	mock.ExpectQuery(reSelectQuery).
		WithArgs(int64(10), int64(0)).
		WillReturnRows(sqlmock.NewRows([]string{"id_job"}).AddRow(1))

	_, _, err := repo.ListJobs(context.Background(), ListJobsOptions{Limit: 10})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestListJobs_ScanJobs_NodeListExpandFailure(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reCountQuery).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery(reSelectQuery).
		WithArgs(int64(10), int64(0)).
		WillReturnRows(sqlmock.NewRows(jobRowColumns()).
			AddRow(1, "job1", "alice", "acctA", "gpu", 1, "node[001-", 1, 100, 200, 0, 0, "/work", "", ""))
	mock.ExpectQuery(reTresQuery).WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))

	jobs, _, err := repo.ListJobs(context.Background(), ListJobsOptions{Limit: 10})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("len(jobs) = %d, want 1", len(jobs))
	}
	// Falls back to raw nodelist value on expansion failure.
	if len(jobs[0].Nodes) != 1 || jobs[0].Nodes[0] != "node[001-" {
		t.Errorf("Nodes = %v, want fallback to raw nodelist", jobs[0].Nodes)
	}
}

// nodeFilterLikeArg mirrors the "%<escapeLike(name)>%" LIKE pattern
// appendJobFilterClauses builds for a single NodeNames entry, so node-filter
// tests can assert the exact argument bound into the query instead of
// accepting any value.
func nodeFilterLikeArg(name string) string {
	return "%" + escapeLike(name) + "%"
}

func TestListJobs_NodeFilter(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reNodeFilterSelectQuery).
		WithArgs(nodeFilterLikeArg("node001"), int64(nodeFilterMaxRows)).
		WillReturnRows(sqlmock.NewRows(jobRowColumns()).
			AddRow(1, "job1", "alice", "acctA", "gpu", 1, "node001", 1, 100, 200, 0, 0, "/work", "", "").
			AddRow(2, "job2", "bob", "acctB", "gpu", 1, "node002", 1, 100, 200, 0, 0, "/work", "", "").
			AddRow(3, "job3", "carol", "acctC", "gpu", 1, "node001", 1, 100, 200, 0, 0, "/work", "", ""))
	mock.ExpectQuery(reTresQuery).WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))

	jobs, total, err := repo.ListJobs(context.Background(), ListJobsOptions{
		Limit:     10,
		JobFilter: JobFilter{NodeNames: []string{"node001"}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 2 {
		t.Errorf("total = %d, want 2", total)
	}
	if len(jobs) != 2 {
		t.Fatalf("len(jobs) = %d, want 2", len(jobs))
	}
}

func TestListJobs_NodeFilter_OffsetBeyondTotal(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reNodeFilterSelectQuery).
		WithArgs(nodeFilterLikeArg("node001"), int64(nodeFilterMaxRows)).
		WillReturnRows(sqlmock.NewRows(jobRowColumns()).
			AddRow(1, "job1", "alice", "acctA", "gpu", 1, "node001", 1, 100, 200, 0, 0, "/work", "", ""))
	mock.ExpectQuery(reTresQuery).WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))

	jobs, total, err := repo.ListJobs(context.Background(), ListJobsOptions{
		Limit:     10,
		Offset:    50,
		JobFilter: JobFilter{NodeNames: []string{"node001"}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 1 {
		t.Errorf("total = %d, want 1", total)
	}
	if len(jobs) != 0 {
		t.Fatalf("len(jobs) = %d, want 0", len(jobs))
	}
}

func TestListJobs_NodeFilter_QueryError(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reNodeFilterSelectQuery).
		WithArgs(nodeFilterLikeArg("node001"), int64(nodeFilterMaxRows)).
		WillReturnError(errors.New("boom"))

	_, _, err := repo.ListJobs(context.Background(), ListJobsOptions{
		Limit:     10,
		JobFilter: JobFilter{NodeNames: []string{"node001"}},
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

// TestListJobs_NodeFilter_EscapesLikeSpecialChars pins down the exact LIKE
// argument for a node name containing SQL LIKE metacharacters, independent
// of escapeLike itself. Every other node-filter test uses a plain
// alphanumeric name ("node001"), so nodeFilterLikeArg (which just calls
// escapeLike) would still "pass" even if escapeLike's escaping were broken.
// Here the expected argument is instead a literal spelled out by hand from
// escapeLike's documented behavior (backslash-escape backslashes, then '%',
// then '_', in that order):
//
//	input:  node_01%
//	step 1: no backslashes to escape        -> node_01%
//	step 2: '%'  becomes '\%'                -> node_01\%
//	step 3: '_'  becomes '\_'                -> node\_01\%
//	wrapped in "%...%" for the LIKE pattern  -> %node\_01\%%
func TestListJobs_NodeFilter_EscapesLikeSpecialChars(t *testing.T) {
	repo, mock := newMockRepository(t)
	const wantLikeArg = `%node\_01\%%`
	mock.ExpectQuery(reNodeFilterSelectQuery).
		WithArgs(wantLikeArg, int64(nodeFilterMaxRows)).
		WillReturnRows(sqlmock.NewRows(jobRowColumns()).
			AddRow(1, "job1", "alice", "acctA", "gpu", 1, "node_01%", 1, 100, 200, 0, 0, "/work", "", ""))
	mock.ExpectQuery(reTresQuery).WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))

	_, _, err := repo.ListJobs(context.Background(), ListJobsOptions{
		Limit:     10,
		JobFilter: JobFilter{NodeNames: []string{"node_01%"}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGetJob_Found(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reGetJobQuery).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows(jobRowColumns()).
			AddRow(42, "job42", "alice", "acctA", "gpu", 3, "node[001-002]", 2, 100, 200, 300, 0, "/work", "1001=gres/gpu:4", "node002"))
	mock.ExpectQuery(reTresQuery).WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))

	job, err := repo.GetJob(context.Background(), 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job == nil {
		t.Fatal("expected job, got nil")
	}
	if job.State != "COMPLETED" {
		t.Errorf("State = %q, want COMPLETED", job.State)
	}
	if len(job.Nodes) != 2 {
		t.Errorf("Nodes = %v, want 2 nodes", job.Nodes)
	}
	if job.GPUsTotal != 4 {
		t.Errorf("GPUsTotal = %d, want 4", job.GPUsTotal)
	}
	if job.FailedNode != "node002" {
		t.Errorf("FailedNode = %q, want node002", job.FailedNode)
	}
}

func TestGetJob_NotFound(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reGetJobQuery).
		WithArgs(int64(999)).
		WillReturnError(sql.ErrNoRows)

	job, err := repo.GetJob(context.Background(), 999)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job != nil {
		t.Fatalf("expected nil job, got %+v", job)
	}
}

func TestGetJob_ScanError(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reGetJobQuery).
		WithArgs(int64(1)).
		WillReturnError(errors.New("connection lost"))

	_, err := repo.GetJob(context.Background(), 1)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestGetJob_ExpandNodeListError(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reGetJobQuery).
		WithArgs(int64(1)).
		WillReturnRows(sqlmock.NewRows(jobRowColumns()).
			AddRow(1, "job1", "alice", "acctA", "gpu", 1, "node[001-", 1, 100, 200, 0, 0, "/work", "", ""))

	_, err := repo.GetJob(context.Background(), 1)
	if err == nil {
		t.Fatal("expected error for malformed nodelist, got nil")
	}
}

func TestListMetadataValues_Success(t *testing.T) {
	repo, mock := newMockRepository(t)
	re := "(?s)" + metadataFieldExpr("user") + ".*" + reJobTableAlias + ".*WHERE 1=1.*LIKE \\? ESCAPE.*GROUP BY.*ORDER BY CASE.*LIMIT \\?$"
	mock.ExpectQuery(re).
		WithArgs("%al%", "al%", int64(50)).
		WillReturnRows(sqlmock.NewRows([]string{"value", "usage_count"}).
			AddRow("alice", 5).
			AddRow("albert", 2))

	values, err := repo.ListMetadataValues(context.Background(), ListMetadataValuesOptions{
		Field: "user",
		Query: "al",
		Limit: 0,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(values) != 2 {
		t.Fatalf("len(values) = %d, want 2", len(values))
	}
}

func TestListMetadataValues_InvalidField(t *testing.T) {
	repo, _ := newMockRepository(t)
	_, err := repo.ListMetadataValues(context.Background(), ListMetadataValuesOptions{Field: "bogus"})
	if err == nil {
		t.Fatal("expected error for invalid field, got nil")
	}
}

func TestListMetadataValues_QueryError(t *testing.T) {
	repo, mock := newMockRepository(t)
	re := "(?s)" + metadataFieldExpr("account") + ".*" + reJobTableAlias + ".*WHERE 1=1.*GROUP BY.*ORDER BY usage_count DESC, value ASC.*LIMIT \\?$"
	mock.ExpectQuery(re).
		WithArgs(int64(50)).
		WillReturnError(errors.New("db error"))

	_, err := repo.ListMetadataValues(context.Background(), ListMetadataValuesOptions{Field: "account"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestListMetadataValues_ScanError(t *testing.T) {
	repo, mock := newMockRepository(t)
	re := "(?s)" + metadataFieldExpr("partition") + ".*" + reJobTableAlias + ".*WHERE 1=1.*GROUP BY.*ORDER BY usage_count DESC, value ASC.*LIMIT \\?$"
	// Missing usage_count column triggers scan error.
	mock.ExpectQuery(re).
		WithArgs(int64(50)).
		WillReturnRows(sqlmock.NewRows([]string{"value"}).AddRow("alice"))

	_, err := repo.ListMetadataValues(context.Background(), ListMetadataValuesOptions{Field: "partition"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestEnsureGPUTRESIDs_Success(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reTresQuery).WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).
		AddRow(1001, "gpu").
		AddRow(1002, "gpu:a100"))

	repo.ensureGPUTRESIDs(context.Background())
	if repo.gpuTRESIDs == nil {
		t.Fatal("expected gpuTRESIDs to be populated")
	}
	if _, ok := repo.gpuTRESIDs.aggregate[1001]; !ok {
		t.Errorf("expected id 1001 in aggregate set")
	}
	if _, ok := repo.gpuTRESIDs.typed[1002]; !ok {
		t.Errorf("expected id 1002 in typed set")
	}
}

func TestEnsureGPUTRESIDs_QueryError(t *testing.T) {
	repo, mock := newMockRepository(t)
	mock.ExpectQuery(reTresQuery).WillReturnError(errors.New("no such table"))

	repo.ensureGPUTRESIDs(context.Background())
	if repo.gpuTRESIDs == nil {
		t.Fatal("expected gpuTRESIDs to fall back to empty set on error")
	}
	if len(repo.gpuTRESIDs.aggregate) != 0 || len(repo.gpuTRESIDs.typed) != 0 {
		t.Errorf("expected empty sets on query error")
	}
}

func TestEnsureGPUTRESIDs_AlreadyLoaded(t *testing.T) {
	repo, mock := newMockRepository(t)
	preset := &gpuTRESIDSet{aggregate: map[int]struct{}{1: {}}, typed: map[int]struct{}{}}
	repo.gpuTRESIDs = preset

	// Close the underlying DB *before* calling ensureGPUTRESIDs, with no
	// query expectation configured (only the Close itself is expected).
	// This makes "the already-loaded short-circuit was skipped" fail loudly
	// instead of silently: if ensureGPUTRESIDs ignores the non-nil cache and
	// issues r.db.QueryContext anyway, it hits a closed *sql.DB (sql:
	// database is closed), which ensureGPUTRESIDs's error handling
	// swallows by design (see repository.go) and papers over by assigning a
	// brand new, empty *gpuTRESIDSet to r.gpuTRESIDs. That replacement is
	// exactly what the pointer-identity and content assertions below
	// detect: they only pass if the original preset was never touched at
	// all, which requires the early-return path to have actually run.
	mock.ExpectClose()
	if err := repo.db.Close(); err != nil {
		t.Fatalf("failed to close mock db: %v", err)
	}

	repo.ensureGPUTRESIDs(context.Background())

	// Explicitly assert the cached set is left untouched: same pointer, and
	// its contents unchanged (ensureGPUTRESIDs must not reset or repopulate
	// it once already loaded).
	if repo.gpuTRESIDs != preset {
		t.Fatal("expected gpuTRESIDs pointer to remain unchanged when already loaded")
	}
	if len(repo.gpuTRESIDs.aggregate) != 1 {
		t.Fatalf("aggregate set changed: got %v, want {1}", repo.gpuTRESIDs.aggregate)
	}
	if _, ok := repo.gpuTRESIDs.aggregate[1]; !ok {
		t.Fatalf("expected preset aggregate id 1 to remain, got %v", repo.gpuTRESIDs.aggregate)
	}
	if len(repo.gpuTRESIDs.typed) != 0 {
		t.Fatalf("typed set changed: got %v, want empty", repo.gpuTRESIDs.typed)
	}
}

func TestStateFromString(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"PENDING", 0},
		{"RUNNING", 1},
		{"COMPLETED", 3},
		{"UNKNOWN_STATE", -1},
		{"", -1},
	}
	for _, tt := range tests {
		if got := StateFromString(tt.in); got != tt.want {
			t.Errorf("StateFromString(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestMetadataValueExpression(t *testing.T) {
	tests := []struct {
		field   string
		wantErr bool
	}{
		{"name", false},
		{"user", false},
		{"account", false},
		{"partition", false},
		{"bogus", true},
	}
	for _, tt := range tests {
		expr, err := metadataValueExpression(tt.field)
		if tt.wantErr {
			if err == nil {
				t.Errorf("metadataValueExpression(%q) expected error, got nil", tt.field)
			}
			continue
		}
		if err != nil {
			t.Errorf("metadataValueExpression(%q) unexpected error: %v", tt.field, err)
		}
		if expr == "" {
			t.Errorf("metadataValueExpression(%q) returned empty expression", tt.field)
		}
	}
}
