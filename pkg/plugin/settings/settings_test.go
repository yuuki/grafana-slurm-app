package settings

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// fakeLogger records Warn calls so tests can assert on logging behavior
// without depending on the real hclog-backed DefaultLogger's output format.
type fakeLogger struct {
	warnMsgs []string
}

func (f *fakeLogger) Debug(msg string, args ...interface{}) {}
func (f *fakeLogger) Info(msg string, args ...interface{})  {}
func (f *fakeLogger) Warn(msg string, args ...interface{}) {
	f.warnMsgs = append(f.warnMsgs, msg)
}
func (f *fakeLogger) Error(msg string, args ...interface{})      {}
func (f *fakeLogger) With(args ...interface{}) log.Logger        { return f }
func (f *fakeLogger) Level() log.Level                           { return log.Debug }
func (f *fakeLogger) FromContext(ctx context.Context) log.Logger { return f }

func TestParseProfilesAndDefaults(t *testing.T) {
	settingsJSON := map[string]any{
		"metricsifterServiceUrl": "http://metricsifter:8000",
		"connections": []map[string]any{
			{
				"id":                "shared-slurmdbd",
				"dbHost":            "shared-db:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "sharedPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "shared-slurmdbd",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-a100",
				"defaultTemplateId":    "distributed-training",
				"accessRule": map[string]any{
					"allowedRoles": []string{"Viewer", "Editor", "Admin"},
				},
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{
		JSONData: raw,
		DecryptedSecureJSONData: map[string]string{
			"sharedPassword": "secret",
		},
	})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if len(cfg.Connections) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(cfg.Connections))
	}
	if cfg.MetricSifterServiceURL != "http://metricsifter:8000" {
		t.Fatalf("expected metricsifter service url to be parsed, got %q", cfg.MetricSifterServiceURL)
	}
	if cfg.Connections[0].Password != "secret" {
		t.Fatalf("expected password to resolve from secure json")
	}
	if len(cfg.Clusters) != 1 {
		t.Fatalf("expected 1 cluster, got %d", len(cfg.Clusters))
	}
	cluster := cfg.Clusters[0]
	if cluster.InstanceLabel != "instance" {
		t.Fatalf("expected default instance label, got %q", cluster.InstanceLabel)
	}
	if len(cluster.AggregationNodeLabels) != 2 || cluster.AggregationNodeLabels[0] != "host.name" || cluster.AggregationNodeLabels[1] != "instance" {
		t.Fatalf("expected default aggregation node labels [host.name instance], got %#v", cluster.AggregationNodeLabels)
	}
	if cluster.NodeMatcherMode != "host:port" {
		t.Fatalf("expected default node matcher mode host:port, got %q", cluster.NodeMatcherMode)
	}
}

func TestParseRejectsUnknownConnectionReference(t *testing.T) {
	settingsJSON := map[string]any{
		"connections": []map[string]any{},
		"clusters": []map[string]any{
			{
				"id":               "broken",
				"displayName":      "Broken",
				"connectionId":     "missing",
				"slurmClusterName": "gpu_cluster",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	if _, err := Parse(backend.AppInstanceSettings{JSONData: raw}); err == nil {
		t.Fatalf("expected Parse to fail for unknown connection reference")
	}
}

func TestParseRejectsNonHTTPMetricSifterURL(t *testing.T) {
	settingsJSON := map[string]any{
		"metricsifterServiceUrl": "ftp://metricsifter.internal",
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	if _, err := Parse(backend.AppInstanceSettings{JSONData: raw}); err == nil {
		t.Fatalf("expected Parse to fail for non-http metricsifter URL")
	}
}

func TestMetricSifterFilterGranularityDefault(t *testing.T) {
	settingsJSON := map[string]any{
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{JSONData: raw})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if cfg.MetricSifterFilterGranularity != "disaggregated" {
		t.Fatalf("expected default metricsifterFilterGranularity to be disaggregated, got %q", cfg.MetricSifterFilterGranularity)
	}
}

func TestMetricSifterFilterGranularityAggregated(t *testing.T) {
	settingsJSON := map[string]any{
		"metricsifterFilterGranularity": "aggregated",
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{JSONData: raw})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if cfg.MetricSifterFilterGranularity != "aggregated" {
		t.Fatalf("expected metricsifterFilterGranularity to be aggregated, got %q", cfg.MetricSifterFilterGranularity)
	}
}

func TestMetricSifterFilterGranularityInvalid(t *testing.T) {
	settingsJSON := map[string]any{
		"metricsifterFilterGranularity": "invalid-value",
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	if _, err := Parse(backend.AppInstanceSettings{JSONData: raw}); err == nil {
		t.Fatalf("expected Parse to fail for invalid metricsifterFilterGranularity")
	}
}

func TestParseMetricSifterDefaultParams(t *testing.T) {
	defaults := DefaultMetricSifterParams()
	settingsJSON := map[string]any{
		"metricsifterServiceUrl": "http://metricsifter:8000",
		"metricsifterDefaultParams": map[string]any{
			"searchMethod":           "bottomup",
			"costModel":              "rbf",
			"penalty":                12.5,
			"penaltyAdjust":          3.5,
			"bandwidth":              4.25,
			"segmentSelectionMethod": "max",
			"nJobs":                  -1,
			"withoutSimpleFilter":    true,
		},
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{JSONData: raw})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if cfg.MetricSifterDefaultParams == nil {
		t.Fatalf("expected metricsifter default params to be parsed")
	}
	if cfg.MetricSifterDefaultParams.PenaltyAdjust != 3.5 {
		t.Fatalf("expected penalty adjust 3.5, got %v", cfg.MetricSifterDefaultParams.PenaltyAdjust)
	}
	if cfg.MetricSifterDefaultParams.WithoutSimpleFilter != true {
		t.Fatalf("expected withoutSimpleFilter true")
	}
	if defaults.SearchMethod != "pelt" {
		t.Fatalf("expected default search method pelt, got %q", defaults.SearchMethod)
	}
}

func TestParseRejectsClusterMissingConnectionID(t *testing.T) {
	settingsJSON := map[string]any{
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	if _, err := Parse(backend.AppInstanceSettings{JSONData: raw}); err == nil {
		t.Fatalf("expected Parse to fail for cluster missing connectionId")
	}
}

func TestParseLegacySingleClusterMigratesConnectionID(t *testing.T) {
	settingsJSON := map[string]any{
		"dbHost":            "legacy-db:3306",
		"dbName":            "slurm_acct_db",
		"dbUser":            "slurm",
		"clusterName":       "legacy_cluster",
		"promDatasourceUid": "prom-legacy",
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{
		JSONData: raw,
		DecryptedSecureJSONData: map[string]string{
			"dbPassword": "secret",
		},
	})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if len(cfg.Clusters) != 1 {
		t.Fatalf("expected 1 cluster from legacy migration, got %d", len(cfg.Clusters))
	}
	if cfg.Clusters[0].ConnectionID != "default" {
		t.Fatalf("expected legacy cluster to reference connection %q, got %q", "default", cfg.Clusters[0].ConnectionID)
	}
}

func TestParseNewStyleSettingsPassesValidation(t *testing.T) {
	settingsJSON := map[string]any{
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{JSONData: raw})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if cfg.Clusters[0].ConnectionID != "default" {
		t.Fatalf("expected cluster connectionId default, got %q", cfg.Clusters[0].ConnectionID)
	}
}

func TestParseRejectsSecondClusterMissingConnectionID(t *testing.T) {
	settingsJSON := map[string]any{
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster_a100",
				"metricsDatasourceUid": "prom-a100",
			},
			{
				"id":                   "h100",
				"displayName":          "H100 Cluster",
				"slurmClusterName":     "gpu_cluster_h100",
				"metricsDatasourceUid": "prom-h100",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	_, err = Parse(backend.AppInstanceSettings{JSONData: raw})
	if err == nil {
		t.Fatalf("expected Parse to fail because the second cluster is missing connectionId")
	}
	if !strings.Contains(err.Error(), "h100") {
		t.Fatalf("expected error to reference the offending cluster id h100, got: %v", err)
	}
}

func TestHasLegacySettings(t *testing.T) {
	cases := []struct {
		name string
		s    Settings
		want bool
	}{
		{name: "all empty", s: Settings{}, want: false},
		{name: "dbHost set", s: Settings{DBHost: "legacy-db:3306"}, want: true},
		{name: "dbUser set", s: Settings{DBUser: "slurm"}, want: true},
		{name: "clusterName set", s: Settings{ClusterName: "legacy_cluster"}, want: true},
		{name: "promDatasourceUid set", s: Settings{PromDatasourceUID: "prom-legacy"}, want: true},
		// DBName and InstanceLabel are always defaulted by Settings.Defaults()
		// before hasLegacySettings is consulted, so they must not be treated
		// as legacy signals on their own.
		{name: "only dbName/instanceLabel set", s: Settings{DBName: "slurm_acct_db", InstanceLabel: "instance"}, want: false},
		// DBPassword is populated from DecryptedSecureJSONData["dbPassword"]
		// even for new-style connections that use securePasswordRef:
		// "dbPassword" (the AppConfig UI default), so it must not be a
		// legacy signal on its own.
		{name: "only dbPassword set", s: Settings{DBPassword: "secret"}, want: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.s.hasLegacySettings(); got != tc.want {
				t.Fatalf("hasLegacySettings() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestApplyLegacyDefaultsWarnsOnMixedLegacyAndNewSettings(t *testing.T) {
	original := log.DefaultLogger
	fake := &fakeLogger{}
	log.DefaultLogger = fake
	defer func() { log.DefaultLogger = original }()

	settingsJSON := map[string]any{
		// clusterName is a legacy-only field; DBHost is intentionally left
		// unset to prove the warning is not narrowly gated on DBHost alone.
		"clusterName": "legacy_cluster",
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	if _, err := Parse(backend.AppInstanceSettings{JSONData: raw}); err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if len(fake.warnMsgs) != 1 {
		t.Fatalf("expected exactly 1 warning to be logged, got %d: %v", len(fake.warnMsgs), fake.warnMsgs)
	}
}

func TestApplyLegacyDefaultsNoWarnWhenNoLegacySettings(t *testing.T) {
	original := log.DefaultLogger
	fake := &fakeLogger{}
	log.DefaultLogger = fake
	defer func() { log.DefaultLogger = original }()

	settingsJSON := map[string]any{
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	if _, err := Parse(backend.AppInstanceSettings{JSONData: raw}); err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if len(fake.warnMsgs) != 0 {
		t.Fatalf("expected no warnings to be logged, got %d: %v", len(fake.warnMsgs), fake.warnMsgs)
	}
}

// TestApplyLegacyDefaultsNoWarnWhenNewStyleUsesDbPasswordSecureRef guards
// against a false-positive warning: new-style connections can (and by
// AppConfig.tsx's default do) use securePasswordRef: "dbPassword", which
// causes Parse() to populate s.DBPassword from
// DecryptedSecureJSONData["dbPassword"] even though no legacy single-cluster
// fields were ever set.
func TestApplyLegacyDefaultsNoWarnWhenNewStyleUsesDbPasswordSecureRef(t *testing.T) {
	original := log.DefaultLogger
	fake := &fakeLogger{}
	log.DefaultLogger = fake
	defer func() { log.DefaultLogger = original }()

	settingsJSON := map[string]any{
		"connections": []map[string]any{
			{
				"id":                "default",
				"dbHost":            "mysql:3306",
				"dbName":            "slurm_acct_db",
				"dbUser":            "slurm",
				"securePasswordRef": "dbPassword",
			},
		},
		"clusters": []map[string]any{
			{
				"id":                   "a100",
				"displayName":          "A100 Cluster",
				"connectionId":         "default",
				"slurmClusterName":     "gpu_cluster",
				"metricsDatasourceUid": "prom-main",
			},
		},
	}

	raw, err := json.Marshal(settingsJSON)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}

	cfg, err := Parse(backend.AppInstanceSettings{
		JSONData: raw,
		DecryptedSecureJSONData: map[string]string{
			"dbPassword": "secret",
		},
	})
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if cfg.DBPassword != "secret" {
		t.Fatalf("expected top-level DBPassword to be populated from secure json, got %q", cfg.DBPassword)
	}

	if len(fake.warnMsgs) != 0 {
		t.Fatalf("expected no warnings to be logged, got %d: %v", len(fake.warnMsgs), fake.warnMsgs)
	}
}
