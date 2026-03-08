package slurm

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

var validClusterName = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// Repository provides access to Slurm job data stored in slurmdbd's MySQL database.
type Repository struct {
	db          *sql.DB
	clusterName string
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
	return fmt.Sprintf("%s_job_table", r.clusterName)
}

// ListJobs retrieves jobs from slurmdbd matching the given options.
func (r *Repository) ListJobs(ctx context.Context, opts ListJobsOptions) ([]Job, error) {
	if opts.Limit <= 0 || opts.Limit > 1000 {
		opts.Limit = 100
	}

	query := fmt.Sprintf(`
		SELECT j.id_job, j.job_name, COALESCE(a.user, ''), COALESCE(a.acct, ''), j.partition, j.state,
		       j.nodelist, j.nodes_alloc, j.time_start, j.time_end,
		       j.exit_code, j.work_dir, j.tres_alloc
		FROM %s j
		LEFT JOIN %s_assoc_table a ON j.id_assoc = a.id_assoc
		WHERE 1=1`, r.jobTable(), r.clusterName)

	var args []interface{}

	if opts.User != "" {
		query += " AND a.user = ?"
		args = append(args, opts.User)
	}
	if opts.Account != "" {
		query += " AND a.acct = ?"
		args = append(args, opts.Account)
	}
	if opts.Partition != "" {
		query += " AND j.`partition` = ?"
		args = append(args, opts.Partition)
	}
	if opts.State != "" {
		stateInt := StateFromString(strings.ToUpper(opts.State))
		if stateInt >= 0 {
			query += " AND j.state = ?"
			args = append(args, stateInt)
		}
	}
	if opts.From > 0 {
		query += " AND j.time_start >= ?"
		args = append(args, opts.From)
	}
	if opts.To > 0 {
		query += " AND j.time_start <= ?"
		args = append(args, opts.To)
	}
	if opts.Name != "" {
		query += " AND j.job_name LIKE ?"
		args = append(args, "%"+opts.Name+"%")
	}

	query += " ORDER BY j.time_start DESC LIMIT ? OFFSET ?"
	args = append(args, opts.Limit, opts.Offset)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("querying jobs: %w", err)
	}
	defer rows.Close()

	return r.scanJobs(rows)
}

// GetJob retrieves a single job by its ID.
func (r *Repository) GetJob(ctx context.Context, jobID uint32) (*Job, error) {
	query := fmt.Sprintf(`
		SELECT j.id_job, j.job_name, COALESCE(a.user, ''), COALESCE(a.acct, ''), j.partition, j.state,
		       j.nodelist, j.nodes_alloc, j.time_start, j.time_end,
		       j.exit_code, j.work_dir, j.tres_alloc
		FROM %s j
		LEFT JOIN %s_assoc_table a ON j.id_assoc = a.id_assoc
		WHERE j.id_job = ?`, r.jobTable(), r.clusterName)

	row := r.db.QueryRowContext(ctx, query, jobID)

	var (
		stateInt int
		nodeList string
		job      Job
	)
	err := row.Scan(
		&job.JobID, &job.Name, &job.User, &job.Account, &job.Partition, &stateInt,
		&nodeList, &job.NodeCount, &job.StartTime, &job.EndTime,
		&job.ExitCode, &job.WorkDir, &job.TRES,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("scanning job: %w", err)
	}

	job.State = JobState[stateInt]
	nodes, err := ExpandNodeList(nodeList)
	if err != nil {
		return nil, fmt.Errorf("expanding node list %q: %w", nodeList, err)
	}
	job.Nodes = nodes
	job.GPUsTotal = parseTRESGPUs(job.TRES)

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
			&nodeList, &job.NodeCount, &job.StartTime, &job.EndTime,
			&job.ExitCode, &job.WorkDir, &job.TRES,
		)
		if err != nil {
			return nil, fmt.Errorf("scanning job row: %w", err)
		}

		job.State = JobState[stateInt]
		nodes, err := ExpandNodeList(nodeList)
		if err != nil {
			job.Nodes = []string{nodeList}
		} else {
			job.Nodes = nodes
		}
		job.GPUsTotal = parseTRESGPUs(job.TRES)

		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

// parseTRESGPUs extracts GPU count from TRES allocation string.
// Example: "1=128,2=2048G,1001=gpu:32" → 32
func parseTRESGPUs(tres string) int {
	for _, part := range strings.Split(tres, ",") {
		if strings.Contains(part, "gres/gpu") || strings.Contains(part, "gpu:") {
			kv := strings.SplitN(part, "=", 2)
			if len(kv) == 2 {
				// Handle "gpu:32" format
				val := kv[1]
				if colonIdx := strings.LastIndexByte(val, ':'); colonIdx >= 0 {
					val = val[colonIdx+1:]
				}
				var n int
				fmt.Sscanf(val, "%d", &n)
				return n
			}
		}
	}
	return 0
}
