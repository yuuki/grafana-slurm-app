package settings

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// fuzzSecret is the decrypted password handed to Parse. JSON leaves it
// unescaped, so a leak into the serialized settings is a plain substring.
const fuzzSecret = "fuzzSecretSentinel7f3a"

// FuzzParse feeds arbitrary jsonData to Parse, the only way the plugin's
// app settings (including the legacy single-cluster shape) are read.
func FuzzParse(f *testing.F) {
	for _, seed := range []string{
		``,
		`{}`,
		`null`,
		`{"dbHost":"legacy-db:3306","dbName":"slurm_acct_db","dbUser":"slurm","clusterName":"legacy_cluster","promDatasourceUid":"prom-legacy"}`,
		`{"dbHost":"legacy-db","clusterName":""}`,
		`{"metricsifterServiceUrl":"http://metricsifter:8000","connections":[{"id":"shared","dbHost":"shared-db:3306","dbUser":"slurm","securePasswordRef":"dbPassword"}],"clusters":[{"id":"a100","displayName":"A100","connectionId":"shared","slurmClusterName":"gpu_cluster","metricsDatasourceUid":"prom","aggregationNodeLabels":["host.name","","instance","instance"],"accessRule":{"allowedRoles":["Viewer"]}}]}`,
		`{"dbHost":"legacy-db","clusterName":"c","connections":[{"id":"x"}],"clusters":[{"id":"c","slurmClusterName":"c","connectionId":"x"}]}`,
		`{"metricsifterDefaultParams":{"searchMethod":"binseg","penalty":3.5,"nJobs":-1},"metricsifterFilterGranularity":"aggregated"}`,
		`{"metricsifterDefaultParams":{"penalty":true}}`,
		`{"metricsifterServiceUrl":"ftp://x"}`,
		`{"clusters":[{"id":"a","slurmClusterName":"a","connectionId":"missing"}]}`,
	} {
		f.Add([]byte(seed))
	}

	previous := log.DefaultLogger
	log.DefaultLogger = log.NewNullLogger() // mixed legacy settings warn on every call
	f.Cleanup(func() { log.DefaultLogger = previous })

	f.Fuzz(func(t *testing.T, jsonData []byte) {
		if bytes.Contains(jsonData, []byte(fuzzSecret)) {
			return
		}
		s, err := Parse(backend.AppInstanceSettings{
			JSONData: jsonData,
			DecryptedSecureJSONData: map[string]string{
				"dbPassword": fuzzSecret,
				"shared":     fuzzSecret,
			},
		})
		if err != nil {
			if s != nil {
				t.Fatalf("Parse(%q) = %+v with error %v, want nil settings", jsonData, s, err)
			}
			return
		}

		if err := s.Validate(); err != nil {
			t.Fatalf("Parse(%q) returned settings that fail Validate: %v", jsonData, err)
		}
		if err := s.EffectiveMetricSifterParams().Validate(); err != nil {
			t.Fatalf("Parse(%q): effective MetricSifter params are invalid: %v", jsonData, err)
		}
		checkDefaultsApplied(t, jsonData, s)
		checkLegacyMigration(t, jsonData, s)

		// Passwords are resolved from secure JSON and must never be
		// serialized back out with the settings.
		out, err := json.Marshal(s)
		if err != nil {
			t.Fatalf("Parse(%q): marshal settings: %v", jsonData, err)
		}
		if bytes.Contains(out, []byte(fuzzSecret)) {
			t.Fatalf("Parse(%q): serialized settings leak the password: %s", jsonData, out)
		}
	})
}

// checkDefaultsApplied asserts that every field the frontend and the
// repositories rely on has been filled in by Defaults.
func checkDefaultsApplied(t *testing.T, jsonData []byte, s *Settings) {
	t.Helper()
	if s.MetricSifterFilterGranularity != "disaggregated" && s.MetricSifterFilterGranularity != "aggregated" {
		t.Fatalf("Parse(%q): metricsifterFilterGranularity = %q", jsonData, s.MetricSifterFilterGranularity)
	}
	connectionIDs := map[string]bool{}
	for _, connection := range s.Connections {
		if connection.DBName == "" {
			t.Fatalf("Parse(%q): connection %q has no dbName", jsonData, connection.ID)
		}
		connectionIDs[connection.ID] = true
	}
	for _, cluster := range s.Clusters {
		if !connectionIDs[cluster.ConnectionID] {
			t.Fatalf("Parse(%q): cluster %q references unknown connection %q", jsonData, cluster.ID, cluster.ConnectionID)
		}
		if cluster.MetricsType == "" || cluster.InstanceLabel == "" || cluster.NodeMatcherMode == "" || cluster.DefaultTemplateID == "" {
			t.Fatalf("Parse(%q): cluster %q is missing defaults: %+v", jsonData, cluster.ID, cluster)
		}
		seen := map[string]bool{}
		for _, label := range cluster.AggregationNodeLabels {
			if label == "" || seen[label] {
				t.Fatalf("Parse(%q): cluster %q aggregation labels not deduplicated: %q", jsonData, cluster.ID, cluster.AggregationNodeLabels)
			}
			seen[label] = true
		}
	}
}

// checkLegacyMigration asserts that the legacy single-cluster fields turn
// into exactly one "default" connection and one cluster, and only when no
// multi-cluster profiles are configured.
func checkLegacyMigration(t *testing.T, jsonData []byte, s *Settings) {
	t.Helper()
	var raw Settings
	if len(jsonData) > 0 {
		if err := json.Unmarshal(jsonData, &raw); err != nil {
			t.Fatalf("Parse(%q) succeeded but the payload does not decode: %v", jsonData, err)
		}
	}
	if len(raw.Connections) > 0 || len(raw.Clusters) > 0 || raw.DBHost == "" {
		if len(s.Connections) != len(raw.Connections) || len(s.Clusters) != len(raw.Clusters) {
			t.Fatalf("Parse(%q): %d connections and %d clusters, want %d and %d without migration",
				jsonData, len(s.Connections), len(s.Clusters), len(raw.Connections), len(raw.Clusters))
		}
		return
	}
	if len(s.Connections) != 1 || len(s.Clusters) != 1 {
		t.Fatalf("Parse(%q): legacy settings migrated to %d connections and %d clusters, want 1 and 1",
			jsonData, len(s.Connections), len(s.Clusters))
	}
	connection, cluster := s.Connections[0], s.Clusters[0]
	if connection.ID != "default" || connection.DBHost != raw.DBHost || connection.DBUser != raw.DBUser || connection.Password != fuzzSecret {
		t.Fatalf("Parse(%q): legacy connection = %+v", jsonData, connection)
	}
	if cluster.ID != raw.ClusterName || cluster.SlurmClusterName != raw.ClusterName ||
		cluster.ConnectionID != "default" || cluster.MetricsDatasourceUID != raw.PromDatasourceUID {
		t.Fatalf("Parse(%q): legacy cluster = %+v", jsonData, cluster)
	}
}
