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

	if err := checkClosingBrackets(nodeList); err != nil {
		return nil, err
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

// checkClosingBrackets rejects a ']' that has no matching earlier '['
// (e.g. "]x[" or "a]b[c"). Without this check expandSinglePattern would
// slice with a start index past the end index and panic, bypassing the
// callers' error fallback.
func checkClosingBrackets(s string) error {
	depth := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '[':
			depth++
		case ']':
			depth--
			if depth < 0 {
				return fmt.Errorf("unmatched closing bracket in %q", s)
			}
		}
	}
	return nil
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

	indices, err := expandRangeSpec(rangeSpec, isLeaf, count)
	if err != nil {
		return nil, err
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
		if len(expanded) == 0 {
			// Only the shared suffix holds brackets, so every index expands
			// to the same number of nodes. An empty expansion (a reversed
			// range further in) stays empty for all of them; stop here, as
			// checkRemainingBudget assumes each index yields a node and
			// would otherwise let "a[1-9999][1-9999][2-1]" run unbounded.
			return nil, nil
		}
		result = append(result, expanded...)
	}
	return result, nil
}

// expandRangeSpec expands the comma-separated contents of one bracket (e.g.
// "001-003,010") into index strings, in order. Each element is either a
// literal index or an inclusive numeric "start-end" range whose indices are
// zero-padded to the width of start. The node budget is enforced as
// described on expandSinglePattern: leaf brackets count every index, while
// intermediate brackets only check their indices against the remaining
// budget.
func expandRangeSpec(rangeSpec string, isLeaf bool, count *int) ([]string, error) {
	var indices []string
	for _, part := range strings.Split(rangeSpec, ",") {
		var err error
		indices, err = appendRangeElement(indices, part, isLeaf, count)
		if err != nil {
			return nil, err
		}
	}
	return indices, nil
}

// appendRangeElement appends the indices of one range-spec element (a
// literal index or a "start-end" range) to indices.
func appendRangeElement(indices []string, part string, isLeaf bool, count *int) ([]string, error) {
	dashIdx := strings.IndexByte(part, '-')
	if dashIdx == -1 {
		return appendSingleIndex(indices, part, isLeaf, count)
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
		return appendLeafRange(indices, startNum, endNum, width, count)
	}
	return appendIntermediateRange(indices, startNum, endNum, width, *count)
}

// appendSingleIndex appends a literal (non-range) index. A leaf bracket
// counts it as a final node; an intermediate bracket only checks it against
// the remaining budget.
func appendSingleIndex(indices []string, index string, isLeaf bool, count *int) ([]string, error) {
	// Brackets do not nest in hostlist notation. Without this check an inner
	// '[' (e.g. "a[[1]]") ended up verbatim in the node name.
	if strings.IndexByte(index, '[') != -1 {
		return nil, fmt.Errorf("nested bracket in index %q", index)
	}
	var err error
	if isLeaf {
		err = incrementNodeCount(count)
	} else {
		err = checkRemainingBudget(*count, len(indices), 1)
	}
	if err != nil {
		return nil, err
	}
	return append(indices, index), nil
}

// appendLeafRange appends the zero-padded indices startNum..endNum of a leaf
// bracket, counting each one as a final node so an oversized range stops at
// the limit instead of being materialized first.
func appendLeafRange(indices []string, startNum, endNum, width int, count *int) ([]string, error) {
	for i := startNum; i <= endNum; i++ {
		if err := incrementNodeCount(count); err != nil {
			return nil, err
		}
		indices = append(indices, fmt.Sprintf("%0*d", width, i))
	}
	return indices, nil
}

// appendIntermediateRange appends the zero-padded indices startNum..endNum
// of an intermediate (non-leaf) bracket. The whole range is checked against
// the remaining budget up front; nothing is counted here because the final
// nodes are counted by the recursive expansion.
func appendIntermediateRange(indices []string, startNum, endNum, width, count int) ([]string, error) {
	if err := checkRemainingBudget(count, len(indices), endNum-startNum+1); err != nil {
		return nil, err
	}
	for i := startNum; i <= endNum; i++ {
		indices = append(indices, fmt.Sprintf("%0*d", width, i))
	}
	return indices, nil
}

// checkRemainingBudget reports errNodeLimitExceeded when size more indices
// of an intermediate bracket, on top of the pending indices it has already
// collected, cannot fit into the budget left after count final nodes. Each
// such index recurses into at least one final node. A non-positive size
// (an empty or reversed range) never fails.
func checkRemainingBudget(count, pending, size int) error {
	if size > 0 && count+pending+size > maxExpandedNodes {
		return errNodeLimitExceeded
	}
	return nil
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
