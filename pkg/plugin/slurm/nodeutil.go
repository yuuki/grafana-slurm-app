package slurm

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const maxExpandedNodes = 10000

// errNodeLimitExceeded is returned once the cumulative number of expanded
// nodes crosses maxExpandedNodes. It is checked with errors.Is so the
// message reaching the caller stays identical regardless of which nested
// call detected the overflow.
var errNodeLimitExceeded = fmt.Errorf("node list expansion exceeded limit of %d nodes", maxExpandedNodes)

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
	count := 0

	// Split by comma at the top level (not inside brackets)
	parts := splitTopLevel(nodeList, ',')

	for _, part := range parts {
		expanded, err := expandSinglePattern(part, &count)
		if err != nil {
			if errors.Is(err, errNodeLimitExceeded) {
				return nil, err
			}
			return nil, fmt.Errorf("expanding %q: %w", part, err)
		}
		result = append(result, expanded...)
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

// expandSinglePattern expands a single (non-comma-at-top-level) node pattern.
// count tracks the cumulative number of *final* nodes produced so far across
// the whole ExpandNodeList call (sibling parts and recursive nested
// expansions). Only leaf brackets (those with no further nested "[...]" in
// their suffix) increment count directly, since only they produce final node
// names one-for-one with their indices; incrementing at intermediate levels
// too would double count the same nodes once more when the recursion for
// nested patterns produces the final names.
//
// Intermediate (non-leaf) brackets instead bound the number of indices they
// generate against the remaining budget (maxExpandedNodes - *count) before
// looping, since each index they produce recurses into at least one final
// node. This still fails fast on a pathological range such as
// "node[1-999999999]" or "node[1-999999999]-suffix[1-2]" without first
// materializing a huge slice, while leaving nodes counted exactly once.
func expandSinglePattern(pattern string, count *int) ([]string, error) {
	bracketStart := strings.IndexByte(pattern, '[')
	if bracketStart == -1 {
		if err := incrementNodeCount(count); err != nil {
			return nil, err
		}
		return []string{pattern}, nil
	}

	bracketEnd := strings.IndexByte(pattern, ']')
	if bracketEnd == -1 {
		return nil, fmt.Errorf("unmatched bracket in %q", pattern)
	}

	prefix := pattern[:bracketStart]
	suffix := pattern[bracketEnd+1:]
	rangeSpec := pattern[bracketStart+1 : bracketEnd]

	// isLeaf is true when this bracket's indices become final node names
	// directly (no further nested pattern in the suffix to recurse into).
	isLeaf := suffix == "" || !strings.Contains(suffix, "[")

	var indices []string
	for _, part := range strings.Split(rangeSpec, ",") {
		dashIdx := strings.IndexByte(part, '-')
		if dashIdx == -1 {
			if isLeaf {
				if err := incrementNodeCount(count); err != nil {
					return nil, err
				}
			} else if *count+len(indices)+1 > maxExpandedNodes {
				return nil, errNodeLimitExceeded
			}
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
		if isLeaf {
			for i := startNum; i <= endNum; i++ {
				if err := incrementNodeCount(count); err != nil {
					return nil, err
				}
				indices = append(indices, fmt.Sprintf("%0*d", width, i))
			}
		} else {
			if size := endNum - startNum + 1; size > 0 {
				if *count+len(indices)+size > maxExpandedNodes {
					return nil, errNodeLimitExceeded
				}
			}
			for i := startNum; i <= endNum; i++ {
				indices = append(indices, fmt.Sprintf("%0*d", width, i))
			}
		}
	}

	if isLeaf {
		nodes := make([]string, len(indices))
		for i, idx := range indices {
			nodes[i] = prefix + idx + suffix
		}
		return nodes, nil
	}

	// Handle nested patterns (e.g., prefix[1-2]-suffix[3-4]). Final node
	// counting happens inside this recursive call, at whichever level turns
	// out to be the leaf.
	var result []string
	for _, idx := range indices {
		expanded, err := expandSinglePattern(prefix+idx+suffix, count)
		if err != nil {
			return nil, err
		}
		result = append(result, expanded...)
	}
	return result, nil
}

// incrementNodeCount bumps the shared final-node counter and reports an
// error the moment it crosses maxExpandedNodes, so callers can stop
// expanding immediately instead of first building an oversized slice.
func incrementNodeCount(count *int) error {
	*count++
	if *count > maxExpandedNodes {
		return errNodeLimitExceeded
	}
	return nil
}
