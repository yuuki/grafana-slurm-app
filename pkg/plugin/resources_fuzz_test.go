package plugin

import (
	"encoding/base64"
	"net/url"
	"strings"
	"testing"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

// FuzzParseListOptions feeds arbitrary query strings to the /api/jobs and
// /api/jobs/metadata/options parameter parsers. cursorText is base64-encoded
// into the cursor parameter, so the fuzzer reaches the decimal offset inside
// it directly instead of having to produce valid base64 first.
func FuzzParseListOptions(f *testing.F) {
	for _, seed := range []struct{ query, cursor string }{
		{"clusterId=a100&limit=100", ""},
		{"clusterId=a100&nodesMin=-5&from=-100&elapsedMin=-3600", ""},
		{"nodeNames=gpu-node001,%20gpu-node002,,&nodeMatchMode=and", "100"},
		{"limit=1001&to=99999999999999999999", "-1"},
		{"cursor=not-base64", ""},
		{"field=user&limit=0&query=%25_", "007"},
		{"field=workDir&limit=101", "+5"},
		{"%zz&limit=5", "9223372036854775807"},
	} {
		f.Add(seed.query, seed.cursor)
	}

	f.Fuzz(func(t *testing.T, rawQuery, cursorText string) {
		// r.URL.Query() keeps whatever parses and drops the error, so do the same.
		q, _ := url.ParseQuery(rawQuery)
		if cursorText != "" {
			q.Set("cursor", base64.StdEncoding.EncodeToString([]byte(cursorText)))
		}

		opts := parseListOptions(q)
		if opts.Offset < 0 {
			t.Fatalf("query %q cursor %q: negative offset %d", rawQuery, cursorText, opts.Offset)
		}
		if decodeCursor(encodeCursor(opts.Offset)) != opts.Offset {
			t.Fatalf("cursor round trip of offset %d failed", opts.Offset)
		}
		if opts.Limit < 1 || opts.Limit > 1000 {
			t.Fatalf("query %q: limit %d outside [1, 1000]", rawQuery, opts.Limit)
		}
		if opts.From < 0 || opts.To < 0 {
			t.Fatalf("query %q: negative time range [%d, %d]", rawQuery, opts.From, opts.To)
		}
		checkJobFilter(t, rawQuery, opts.JobFilter)

		metadata, err := parseMetadataValuesOptions(q)
		if err != nil {
			if isSupportedMetadataField(q.Get("field")) {
				t.Fatalf("query %q: supported field rejected: %v", rawQuery, err)
			}
			return
		}
		if !isSupportedMetadataField(metadata.Field) {
			t.Fatalf("query %q: unsupported field %q accepted", rawQuery, metadata.Field)
		}
		if metadata.Limit < 1 || metadata.Limit > 100 {
			t.Fatalf("query %q: metadata limit %d outside [1, 100]", rawQuery, metadata.Limit)
		}
		checkJobFilter(t, rawQuery, metadata.JobFilter)
	})
}

// checkJobFilter asserts the invariants the repository relies on when it
// turns a filter into SQL arguments and node-name matches.
func checkJobFilter(t *testing.T, rawQuery string, f slurm.JobFilter) {
	t.Helper()
	if f.NodesMin < 0 || f.NodesMax < 0 || f.ElapsedMin < 0 || f.ElapsedMax < 0 {
		t.Fatalf("query %q: negative range filter %+v", rawQuery, f)
	}
	if f.NodeMatchMode != "" && f.NodeMatchMode != slurm.NodeMatchAND && f.NodeMatchMode != slurm.NodeMatchOR {
		t.Fatalf("query %q: node match mode %q", rawQuery, f.NodeMatchMode)
	}
	for _, name := range f.NodeNames {
		if name == "" || name != strings.TrimSpace(name) || strings.Contains(name, ",") {
			t.Fatalf("query %q: node name %q is not a trimmed, non-empty single name", rawQuery, name)
		}
	}
}
