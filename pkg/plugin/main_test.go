package plugin

import (
	"testing"

	"go.uber.org/goleak"
)

// TestMain fails the package's tests if any goroutine outlives them, such as
// a database/sql connection opener left behind by an unclosed *sql.DB or an
// HTTP keep-alive connection to a test server that was never closed.
func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}
