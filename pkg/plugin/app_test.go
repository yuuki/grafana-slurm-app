package plugin

import (
	"context"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"go.uber.org/goleak"
)

// TestAppDisposeClosesRepositories checks that disposing an app instance (as
// Grafana does whenever the plugin settings change) closes the slurmdbd
// connection pools it opened, rather than leaking one per settings update.
func TestAppDisposeClosesRepositories(t *testing.T) {
	ignore := goleak.IgnoreCurrent()

	instance, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData: []byte(`{
			"connections": [{"id": "db", "dbHost": "127.0.0.1:1", "dbUser": "slurm"}],
			"clusters": [{"id": "a100", "connectionId": "db", "slurmClusterName": "gpu_cluster"}]
		}`),
	})
	if err != nil {
		t.Fatalf("NewApp() error = %v", err)
	}
	app := instance.(*App)
	// sql.Open does not dial, so no database is needed to open the pool.
	if _, err := app.repoManager.RepositoryForCluster(app.settings.Clusters[0]); err != nil {
		t.Fatalf("RepositoryForCluster() error = %v", err)
	}
	if goleak.Find(ignore) == nil {
		t.Fatal("an open repository should own a database/sql goroutine; the check below would prove nothing")
	}

	app.Dispose()

	if err := goleak.Find(ignore); err != nil {
		t.Fatalf("goroutines left after Dispose: %v", err)
	}
}
