package slurm

import "testing"

func TestEscapeLike(t *testing.T) {
	got := escapeLike(`gpu\_%test`)
	want := `gpu\\\_\%test`

	if got != want {
		t.Fatalf("escapeLike() = %q, want %q", got, want)
	}
}
