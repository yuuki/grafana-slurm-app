package slurm

// Job represents a Slurm job from the slurmdbd database.
type Job struct {
	JobID     uint32   `json:"jobId"`
	Name      string   `json:"name"`
	User      string   `json:"user"`
	Account   string   `json:"account"`
	Partition string   `json:"partition"`
	State     string   `json:"state"`
	Nodes     []string `json:"nodes"`
	NodeCount int      `json:"nodeCount"`
	GPUsTotal int      `json:"gpusTotal"`
	StartTime int64    `json:"startTime"`
	EndTime   int64    `json:"endTime"`
	ExitCode  int      `json:"exitCode"`
	WorkDir   string   `json:"workDir"`
	TRES      string   `json:"tres"`
}

// ListJobsOptions represents filter options for listing jobs.
type ListJobsOptions struct {
	User      string
	Account   string
	Partition string
	State     string
	From      int64
	To        int64
	Name      string
	Limit     int
	Offset    int
}

type ListMetadataValuesOptions struct {
	Field     string
	Query     string
	User      string
	Account   string
	Partition string
	State     string
	Name      string
	Limit     int
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
