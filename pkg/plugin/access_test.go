package plugin

import "testing"

func TestAccessRuleAllowsConfiguredRoles(t *testing.T) {
	rule := AccessRule{
		AllowedRoles: []string{"Editor", "Admin"},
	}

	if !rule.AllowsRole("Editor") {
		t.Fatalf("expected editor to be allowed")
	}
	if rule.AllowsRole("Viewer") {
		t.Fatalf("expected viewer to be denied")
	}
}

func TestAccessRuleDefaultsToAllow(t *testing.T) {
	var rule AccessRule
	if !rule.AllowsRole("Viewer") {
		t.Fatalf("expected empty rule to allow access")
	}
}
