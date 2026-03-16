package slurm

import (
	"testing"
)

func TestExpandNodeList(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []string
		wantErr  bool
	}{
		{
			name:     "single node",
			input:    "gpu-node-001",
			expected: []string{"gpu-node-001"},
		},
		{
			name:     "simple range",
			input:    "node[001-003]",
			expected: []string{"node001", "node002", "node003"},
		},
		{
			name:     "range with individual",
			input:    "node[001-003,010]",
			expected: []string{"node001", "node002", "node003", "node010"},
		},
		{
			name:     "multiple groups comma separated",
			input:    "node[1-2],other[5-6]",
			expected: []string{"node1", "node2", "other5", "other6"},
		},
		{
			name:     "no padding",
			input:    "gpu[1-3]",
			expected: []string{"gpu1", "gpu2", "gpu3"},
		},
		{
			name:     "single index in brackets",
			input:    "node[5]",
			expected: []string{"node5"},
		},
		{
			name:     "empty string",
			input:    "",
			expected: nil,
		},
		{
			name:     "with suffix",
			input:    "rack[1-2]-node[01-02]",
			expected: []string{"rack1-node01", "rack1-node02", "rack2-node01", "rack2-node02"},
		},
		{
			name:    "unmatched bracket",
			input:   "node[1-3",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ExpandNodeList(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("ExpandNodeList(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				if len(got) != len(tt.expected) {
					t.Errorf("ExpandNodeList(%q) = %v, want %v", tt.input, got, tt.expected)
					return
				}
				for i, v := range got {
					if v != tt.expected[i] {
						t.Errorf("ExpandNodeList(%q)[%d] = %q, want %q", tt.input, i, v, tt.expected[i])
					}
				}
			}
		})
	}
}
