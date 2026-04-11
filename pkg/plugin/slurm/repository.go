package slurm

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

var validClusterName = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// jobSelectColumns is the shared column list for job queries.
const jobSelectColumns = `j.id_job, j.job_name, COALESCE(a.user, ''), COALESCE(a.acct, ''), j.partition, j.state,
		       j.nodelist, j.nodes_alloc, j.time_submit, j.time_start, j.time_end,
		       j.exit_code, j.work_dir, j.tres_alloc`

// Repository provides access to Slurm job data stored in slurmdbd's MySQL database.
type Repository struct {
	db          *sql.DB
	clusterName string

	gpuTRESMu   sync.Mutex
	gpuTRESIDs  map[int]struct{} // nil means not yet loaded
}

// NewRepository creates a new Repository with the given DSN and cluster name.
func NewRepository(dsn, clusterName string) (*Repository, error) {
	if !validClusterName.MatchString(clusterName) {
		return nil, fmt.Errorf("invalid cluster name: %q (must be alphanumeric, underscores, or hyphens)", clusterName)
	}

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(5 * time.Minute)

	return &Repository{db: db, clusterName: clusterName}, nil
}

// Close closes the database connection.
func (r *Repository) Close() error {
	return r.db.Close()
}

// Ping checks the database connection.
func (r *Repository) Ping(ctx context.Context) error {
	return r.db.PingContext(ctx)
}

func (r *Repository) jobTable() string {
	return fmt.Sprintf("`%s_job_table`", r.clusterName)
}

func (r *Repository) assocTable() string {
	return fmt.Sprintf("`%s_assoc_table`", r.clusterName)
}

// ListJobs retrieves jobs from slurmdbd matching the given options.
func (r *Repository) ListJobs(ctx context.Context, opts ListJobsOptions) ([]Job, int, error) {
	if opts.Limit <= 0 || opts.Limit > 1000 {
		opts.Limit = 100
	}

	// When node names filter is active, SQL LIKE is only a rough pre-filter
	// because compressed notation (e.g. "node[001-003]") may not match individual
	// node names. We fetch all SQL-matched rows, post-filter in Go using
	// ExpandNodeList, then apply pagination.
	if len(opts.NodeNames) > 0 {
		return r.listJobsWithNodeFilter(ctx, opts)
	}

	whereClause, args := buildListJobsWhereClause(opts)
	selectQuery := fmt.Sprintf(`
		SELECT %s
		FROM %s j
		LEFT JOIN %s a ON j.id_assoc = a.id_assoc
		WHERE 1=1%s`, jobSelectColumns, r.jobTable(), r.assocTable(), whereClause)
	countQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s j
		LEFT JOIN %s a ON j.id_assoc = a.id_assoc
		WHERE 1=1%s`, r.jobTable(), r.assocTable(), whereClause)

	var total int
	if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("counting jobs: %w", err)
	}

	selectArgs := append(append([]interface{}{}, args...), opts.Limit, opts.Offset)
	selectQuery += " ORDER BY j.time_start DESC LIMIT ? OFFSET ?"

	rows, err := r.db.QueryContext(ctx, selectQuery, selectArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("querying jobs: %w", err)
	}
	defer rows.Close()

	r.ensureGPUTRESIDs(ctx)
	jobs, err := r.scanJobs(rows)
	if err != nil {
		return nil, 0, err
	}
	return jobs, total, nil
}

// SQL LIKE can't reliably match individual node names against compressed
// notation (e.g. "node[001-003]"), so we fetch a bounded set of candidate
// rows and post-filter in Go after expanding. 10000 balances memory use
// against covering most realistic result sets.
const nodeFilterMaxRows = 10000

func (r *Repository) listJobsWithNodeFilter(ctx context.Context, opts ListJobsOptions) ([]Job, int, error) {
	whereClause, args := buildListJobsWhereClause(opts)
	selectQuery := fmt.Sprintf(`
		SELECT %s
		FROM %s j
		LEFT JOIN %s a ON j.id_assoc = a.id_assoc
		WHERE 1=1%s
		ORDER BY j.time_start DESC
		LIMIT ?`, jobSelectColumns, r.jobTable(), r.assocTable(), whereClause)

	selectArgs := append(append([]interface{}{}, args...), nodeFilterMaxRows)
	rows, err := r.db.QueryContext(ctx, selectQuery, selectArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("querying jobs: %w", err)
	}
	defer rows.Close()

	r.ensureGPUTRESIDs(ctx)
	allJobs, err := r.scanJobs(rows)
	if err != nil {
		return nil, 0, err
	}

	filtered := make([]Job, 0, len(allJobs))
	filterSet := make(map[string]struct{}, len(opts.NodeNames))
	for _, n := range opts.NodeNames {
		filterSet[n] = struct{}{}
	}
	for _, job := range allJobs {
		if matchNodeFilter(job.Nodes, filterSet, opts.NodeMatchMode) {
			filtered = append(filtered, job)
		}
	}

	total := len(filtered)
	start := opts.Offset
	if start > total {
		start = total
	}
	end := start + opts.Limit
	if end > total {
		end = total
	}

	return filtered[start:end], total, nil
}

// matchNodeFilter checks whether jobNodes intersects filterSet.
// filterSet is built once by the caller to avoid per-job map allocation.
func matchNodeFilter(jobNodes []string, filterSet map[string]struct{}, mode string) bool {
	if len(filterSet) == 0 {
		return true
	}
	if mode == NodeMatchAND {
		for n := range filterSet {
			found := false
			for _, jn := range jobNodes {
				if jn == n {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
		return true
	}
	// OR mode (default)
	for _, jn := range jobNodes {
		if _, ok := filterSet[jn]; ok {
			return true
		}
	}
	return false
}

func (r *Repository) ListMetadataValues(ctx context.Context, opts ListMetadataValuesOptions) ([]string, error) {
	if opts.Limit <= 0 || opts.Limit > 100 {
		opts.Limit = 50
	}

	candidateExpr, err := metadataValueExpression(opts.Field)
	if err != nil {
		return nil, err
	}

	query := fmt.Sprintf(`
		SELECT %s AS value, COUNT(*) AS usage_count
		FROM %s j
		LEFT JOIN %s a ON j.id_assoc = a.id_assoc
		WHERE 1=1`, candidateExpr, r.jobTable(), r.assocTable())

	query, args := appendJobFilterClauses(query, nil, opts.JobFilter, opts.Field)

	if opts.Query != "" {
		escapedQuery := escapeLike(opts.Query)
		query += fmt.Sprintf(" AND LOWER(%s) LIKE ? ESCAPE '\\\\'", candidateExpr)
		args = append(args, "%"+strings.ToLower(escapedQuery)+"%")
	}

	query += fmt.Sprintf(" AND %s <> ''", candidateExpr)
	query += fmt.Sprintf(" GROUP BY %s", candidateExpr)

	if opts.Query != "" {
		escapedQuery := escapeLike(opts.Query)
		query += " ORDER BY CASE WHEN LOWER(value) LIKE ? ESCAPE '\\\\' THEN 0 ELSE 1 END, usage_count DESC, value ASC"
		args = append(args, strings.ToLower(escapedQuery)+"%")
	} else {
		query += " ORDER BY usage_count DESC, value ASC"
	}

	query += " LIMIT ?"
	args = append(args, opts.Limit)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("querying metadata values: %w", err)
	}
	defer rows.Close()

	values := make([]string, 0, opts.Limit)
	for rows.Next() {
		var value string
		var usageCount int
		if err := rows.Scan(&value, &usageCount); err != nil {
			return nil, fmt.Errorf("scanning metadata row: %w", err)
		}
		values = append(values, value)
	}

	return values, rows.Err()
}

// GetJob retrieves a single job by its ID.
func (r *Repository) GetJob(ctx context.Context, jobID uint32) (*Job, error) {
	query := fmt.Sprintf(`
		SELECT %s
		FROM %s j
		LEFT JOIN %s a ON j.id_assoc = a.id_assoc
		WHERE j.id_job = ?`, jobSelectColumns, r.jobTable(), r.assocTable())

	row := r.db.QueryRowContext(ctx, query, jobID)

	var (
		stateInt int
		nodeList string
		job      Job
	)
	err := row.Scan(
		&job.JobID, &job.Name, &job.User, &job.Account, &job.Partition, &stateInt,
		&nodeList, &job.NodeCount, &job.SubmitTime, &job.StartTime, &job.EndTime,
		&job.ExitCode, &job.WorkDir, &job.TRES,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("scanning job: %w", err)
	}

	job.State = JobState[stateInt]
	job.NodeList = nodeList
	nodes, err := ExpandNodeList(nodeList)
	if err != nil {
		return nil, fmt.Errorf("expanding node list %q: %w", nodeList, err)
	}
	job.Nodes = nodes
	r.ensureGPUTRESIDs(ctx)
	job.GPUsTotal = parseTRESGPUs(job.TRES, r.gpuTRESIDs)

	return &job, nil
}

func (r *Repository) scanJobs(rows *sql.Rows) ([]Job, error) {
	var jobs []Job
	for rows.Next() {
		var (
			stateInt int
			nodeList string
			job      Job
		)
		err := rows.Scan(
			&job.JobID, &job.Name, &job.User, &job.Account, &job.Partition, &stateInt,
			&nodeList, &job.NodeCount, &job.SubmitTime, &job.StartTime, &job.EndTime,
			&job.ExitCode, &job.WorkDir, &job.TRES,
		)
		if err != nil {
			return nil, fmt.Errorf("scanning job row: %w", err)
		}

		job.State = JobState[stateInt]
		job.NodeList = nodeList
		nodes, err := ExpandNodeList(nodeList)
		if err != nil {
			job.Nodes = []string{nodeList}
		} else {
			job.Nodes = nodes
		}
		job.GPUsTotal = parseTRESGPUs(job.TRES, r.gpuTRESIDs)

		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "%", "\\%")
	value = strings.ReplaceAll(value, "_", "\\_")
	return value
}

func buildListJobsWhereClause(opts ListJobsOptions) (string, []interface{}) {
	query, args := appendJobFilterClauses("", nil, opts.JobFilter, "")

	if opts.From > 0 {
		query += " AND j.time_start >= ?"
		args = append(args, opts.From)
	}
	if opts.To > 0 {
		query += " AND j.time_start <= ?"
		args = append(args, opts.To)
	}

	return query, args
}

// appendJobFilterClauses appends WHERE conditions for common job filter fields.
// excludeField skips the condition for a metadata field being searched
// (one of "user", "account", "partition", "name", or "" for no exclusion).
func appendJobFilterClauses(query string, args []interface{}, f JobFilter, excludeField string) (string, []interface{}) {
	if excludeField != "user" && f.User != "" {
		query += " AND a.user = ?"
		args = append(args, f.User)
	}
	if excludeField != "account" && f.Account != "" {
		query += " AND a.acct = ?"
		args = append(args, f.Account)
	}
	if excludeField != "partition" && f.Partition != "" {
		query += " AND j.`partition` = ?"
		args = append(args, f.Partition)
	}
	if f.State != "" {
		stateInt := StateFromString(strings.ToUpper(f.State))
		if stateInt >= 0 {
			query += " AND j.state = ?"
			args = append(args, stateInt)
		}
	}
	if excludeField != "name" && f.Name != "" {
		query += " AND j.job_name LIKE ?"
		args = append(args, "%"+f.Name+"%")
	}
	if f.NodesMin > 0 {
		query += " AND j.nodes_alloc >= ?"
		args = append(args, f.NodesMin)
	}
	if f.NodesMax > 0 {
		query += " AND j.nodes_alloc <= ?"
		args = append(args, f.NodesMax)
	}
	if f.ElapsedMin > 0 || f.ElapsedMax > 0 {
		query += " AND j.time_start > 0"
	}
	if f.ElapsedMin > 0 {
		query += " AND (CASE WHEN j.time_end = 0 THEN UNIX_TIMESTAMP() ELSE j.time_end END) - j.time_start >= ?"
		args = append(args, f.ElapsedMin)
	}
	if f.ElapsedMax > 0 {
		query += " AND (CASE WHEN j.time_end = 0 THEN UNIX_TIMESTAMP() ELSE j.time_end END) - j.time_start <= ?"
		args = append(args, f.ElapsedMax)
	}

	// SQL LIKE pre-filter for node names (rough filter; exact matching done in Go)
	if len(f.NodeNames) > 0 {
		var conds []string
		for _, name := range f.NodeNames {
			conds = append(conds, "j.nodelist LIKE ?")
			args = append(args, "%"+escapeLike(name)+"%")
		}
		if f.NodeMatchMode == NodeMatchAND {
			query += " AND (" + strings.Join(conds, " AND ") + ")"
		} else {
			query += " AND (" + strings.Join(conds, " OR ") + ")"
		}
	}

	return query, args
}

func metadataValueExpression(field string) (string, error) {
	switch field {
	case "name":
		return "COALESCE(j.job_name, '')", nil
	case "user":
		return "COALESCE(a.user, '')", nil
	case "account":
		return "COALESCE(a.acct, '')", nil
	case "partition":
		return "COALESCE(j.partition, '')", nil
	default:
		return "", fmt.Errorf("invalid metadata field: %q", field)
	}
}

// ensureGPUTRESIDs lazily queries tres_table to resolve GPU TRES IDs.
// This allows parseTRESGPUs to handle numeric-only formats like "1001=8".
func (r *Repository) ensureGPUTRESIDs(ctx context.Context) {
	r.gpuTRESMu.Lock()
	defer r.gpuTRESMu.Unlock()
	if r.gpuTRESIDs != nil {
		return
	}
	r.gpuTRESIDs = make(map[int]struct{})
	// Silently fall back to text-only TRES matching on query failure;
	// this keeps parseTRESGPUs backward-compatible with descriptive formats.
	rows, err := r.db.QueryContext(ctx, "SELECT id FROM tres_table WHERE type = 'gres' AND name = 'gpu'")
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err == nil {
			r.gpuTRESIDs[id] = struct{}{}
		}
	}
}

// parseTRESGPUs extracts GPU count from TRES allocation string.
// Handles both descriptive format ("1001=gres/gpu:8") and numeric-only format ("1001=8").
func parseTRESGPUs(tres string, gpuTRESIDs map[int]struct{}) int {
	for _, part := range strings.Split(tres, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		val := kv[1]

		// Text-based matching: "gres/gpu:8" or "gpu:8"
		if strings.Contains(part, "gres/gpu") || strings.Contains(part, "gpu:") {
			if colonIdx := strings.LastIndexByte(val, ':'); colonIdx >= 0 {
				val = val[colonIdx+1:]
			}
			return scanInt(val)
		}

		// ID-based matching for numeric-only format: "1001=8"
		if id, err := strconv.Atoi(kv[0]); err == nil {
			if _, isGPU := gpuTRESIDs[id]; isGPU {
				return scanInt(val)
			}
		}
	}
	return 0
}

func scanInt(s string) int {
	var n int
	fmt.Sscanf(s, "%d", &n)
	return n
}
