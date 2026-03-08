package slurm

import (
	"fmt"
	"strconv"
	"strings"
)

const maxExpandedNodes = 10000

// ExpandNodeList expands Slurm compressed node notation into individual node names.
// Examples:
//
//	"node[001-003]"        → ["node001", "node002", "node003"]
//	"node[001-003,010]"    → ["node001", "node002", "node003", "node010"]
//	"gpu-node-001"         → ["gpu-node-001"]
//	"node[1-3],other[5-6]" → ["node1", "node2", "node3", "other5", "other6"]
func ExpandNodeList(nodeList string) ([]string, error) {
	if nodeList == "" {
		return nil, nil
	}

	var result []string

	// Split by comma at the top level (not inside brackets)
	parts := splitTopLevel(nodeList, ',')

	for _, part := range parts {
		expanded, err := expandSinglePattern(part)
		if err != nil {
			return nil, fmt.Errorf("expanding %q: %w", part, err)
		}
		result = append(result, expanded...)
		if len(result) > maxExpandedNodes {
			return nil, fmt.Errorf("node list expansion exceeded limit of %d nodes", maxExpandedNodes)
		}
	}

	return result, nil
}

func splitTopLevel(s string, sep byte) []string {
	var parts []string
	depth := 0
	start := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '[':
			depth++
		case ']':
			depth--
		case sep:
			if depth == 0 {
				parts = append(parts, s[start:i])
				start = i + 1
			}
		}
	}
	parts = append(parts, s[start:])
	return parts
}

func expandSinglePattern(pattern string) ([]string, error) {
	bracketStart := strings.IndexByte(pattern, '[')
	if bracketStart == -1 {
		return []string{pattern}, nil
	}

	bracketEnd := strings.IndexByte(pattern, ']')
	if bracketEnd == -1 {
		return nil, fmt.Errorf("unmatched bracket in %q", pattern)
	}

	prefix := pattern[:bracketStart]
	suffix := pattern[bracketEnd+1:]
	rangeSpec := pattern[bracketStart+1 : bracketEnd]

	var indices []string
	for _, part := range strings.Split(rangeSpec, ",") {
		dashIdx := strings.IndexByte(part, '-')
		if dashIdx == -1 {
			indices = append(indices, part)
			continue
		}
		startStr := part[:dashIdx]
		endStr := part[dashIdx+1:]

		startNum, err := strconv.Atoi(startStr)
		if err != nil {
			return nil, fmt.Errorf("invalid range start %q: %w", startStr, err)
		}
		endNum, err := strconv.Atoi(endStr)
		if err != nil {
			return nil, fmt.Errorf("invalid range end %q: %w", endStr, err)
		}

		width := len(startStr)
		for i := startNum; i <= endNum; i++ {
			indices = append(indices, fmt.Sprintf("%0*d", width, i))
		}
	}

	if suffix == "" || !strings.Contains(suffix, "[") {
		nodes := make([]string, len(indices))
		for i, idx := range indices {
			nodes[i] = prefix + idx + suffix
		}
		return nodes, nil
	}

	// Handle nested patterns (e.g., prefix[1-2]-suffix[3-4])
	var result []string
	for _, idx := range indices {
		expanded, err := expandSinglePattern(prefix + idx + suffix)
		if err != nil {
			return nil, err
		}
		result = append(result, expanded...)
	}
	return result, nil
}

// NodesToRegex converts a list of node names into a PromQL-compatible regex pattern.
// Example: ["node001", "node002", "node003"] → "node001|node002|node003"
func NodesToRegex(nodes []string) string {
	return strings.Join(nodes, "|")
}
