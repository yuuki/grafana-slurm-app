package slurm

// Job represents a Slurm job from the slurmdbd database.
type Job struct {
	JobID      uint32   `json:"jobId"`
	Name       string   `json:"name"`
	User       string   `json:"user"`
	Account    string   `json:"account"`
	Partition  string   `json:"partition"`
	State      string   `json:"state"`
	Nodes      []string `json:"nodes"`
	NodeList   string   `json:"nodeList"`
	NodeCount  int      `json:"nodeCount"`
	GPUsTotal  int      `json:"gpusTotal"`
	SubmitTime int64    `json:"submitTime"`
	StartTime  int64    `json:"startTime"`
	EndTime    int64    `json:"endTime"`
	ExitCode   int      `json:"exitCode"`
	WorkDir    string   `json:"workDir"`
	TRES       string   `json:"tres"`
	FailedNode string   `json:"failedNode,omitempty"`
}

// NodeStatsJob is the minimal projection needed for node failure stats.
type NodeStatsJob struct {
	State      string
	NodeList   string
	EndTime    int64
	FailedNode string
}

const (
	NodeMatchOR  = "OR"
	NodeMatchAND = "AND"
)

// JobFilter contains common filter fields shared by job listing and
// metadata value queries.
type JobFilter struct {
	User          string
	Account       string
	Partition     string
	State         string
	Name          string
	NodesMin      int
	NodesMax      int
	ElapsedMin    int64
	ElapsedMax    int64
	NodeNames     []string
	NodeMatchMode string // NodeMatchOR (default) or NodeMatchAND
}

// JobKey is a job's position in the order ListJobs returns jobs in:
// time_start descending, then id_job descending. time_start alone is not
// unique (job arrays, jobs started in the same scheduling cycle), so id_job
// breaks the ties.
type JobKey struct {
	StartTime int64
	JobID     uint32
}

// ListJobsOptions represents filter options for listing jobs.
type ListJobsOptions struct {
	JobFilter
	From  int64
	To    int64
	Limit int
	// After, when set, starts the page right after this job (keyset
	// pagination), so jobs that start or leave the time window between two
	// pages neither repeat nor skip rows.
	After *JobKey
	// Offset is the number of matching jobs before the page. Without After,
	// the query skips that many rows (legacy offset cursors). With After, the
	// keyset condition has already excluded them, and Offset only counts them
	// into the total of a node-name search, which sees only the jobs after
	// the cursor.
	Offset int
}

// JobPage is one page of ListJobs results.
type JobPage struct {
	Jobs []Job
	// Total is the number of jobs matching the filter. For a node-name
	// search it is the Offset jobs before the page plus the matches among
	// the candidate rows scanned (up to nodeFilterMaxRows past the cursor).
	Total int
	// HasMore reports whether more matching jobs follow the last one in Jobs.
	HasMore bool
}

type ListMetadataValuesOptions struct {
	JobFilter
	Field string
	Query string
	Limit int
}

// JobState maps slurmdbd integer states to human-readable strings.
var JobState = map[int]string{
	0: "PENDING",
	1: "RUNNING",
	2: "SUSPENDED",
	3: "COMPLETED",
	4: "CANCELLED",
	5: "FAILED",
	6: "TIMEOUT",
	7: "NODE_FAIL",
	8: "PREEMPTED",
}

// StateFromString returns the integer state for a given state string,
// or -1 if not found.
func StateFromString(s string) int {
	for k, v := range JobState {
		if v == s {
			return k
		}
	}
	return -1
}
