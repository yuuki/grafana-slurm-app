package plugin

import (
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/yuuki/grafana-slurm-app/pkg/plugin/slurm"
)

// FuzzParseListOptions feeds arbitrary query strings to the /api/jobs and
// /api/jobs/metadata/options parameter parsers. cursorText is base64-encoded
// into the cursor parameter, so the fuzzer reaches the text inside it
// directly instead of having to produce valid base64 first.
func FuzzParseListOptions(f *testing.F) {
	for _, seed := range []struct{ query, cursor string }{
		{"clusterId=a100&limit=100", ""},
		{"clusterId=a100&nodesMin=-5&from=-100&elapsedMin=-3600", ""},
		{"nodeNames=gpu-node001,%20gpu-node002,,&nodeMatchMode=and", "100"},
		{"limit=1001&to=99999999999999999999", "-1"},
		{"cursor=not-base64", ""},
		{"cursor=MTAw", ""},
		{"field=user&limit=0&query=%25_", "007"},
		{"field=workDir&limit=101", "+5"},
		{"%zz&limit=5", "9223372036854775807"},
		{"nodeNames=gpu-node001", "k1:1700000000:42:100"},
		{"limit=10", "k1:1700000000:42"},
	} {
		f.Add(seed.query, seed.cursor)
	}

	f.Fuzz(func(t *testing.T, rawQuery, cursorText string) {
		// r.URL.Query() keeps whatever parses and drops the error, so do the same.
		q, _ := url.ParseQuery(rawQuery)
		if cursorText != "" {
			q.Set("cursor", base64.StdEncoding.EncodeToString([]byte(cursorText)))
		}

		opts, err := parseListOptions(q)
		if _, cursorErr := decodeJobsCursor(q.Get("cursor")); (err != nil) != (cursorErr != nil) {
			t.Fatalf("query %q cursor %q: parse error %v, cursor error %v", rawQuery, cursorText, err, cursorErr)
		}
		if err == nil {
			if opts.Offset < 0 || opts.Offset > maxCursorOffset {
				t.Fatalf("query %q cursor %q: offset %d outside [0, %d]", rawQuery, cursorText, opts.Offset, maxCursorOffset)
			}
			if opts.Limit < 1 || opts.Limit > 1000 {
				t.Fatalf("query %q: limit %d outside [1, 1000]", rawQuery, opts.Limit)
			}
			if opts.From < 0 || opts.To < 0 {
				t.Fatalf("query %q: negative time range [%d, %d]", rawQuery, opts.From, opts.To)
			}
			checkJobFilter(t, rawQuery, opts.JobFilter)
		}

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

// FuzzDecodeJobsCursor feeds arbitrary cursors to decodeJobsCursor, both as
// the raw query parameter and base64-encoded, so the fuzzer also reaches the
// text inside a cursor directly.
func FuzzDecodeJobsCursor(f *testing.F) {
	for _, seed := range []string{
		"",
		"0",
		"100",
		"007",
		"-1",
		"+5",
		" 5",
		"2147483647",
		"2147483648",
		"k1:1700000000:42:100",
		"k1:0:0:0",
		"k1:-9223372036854775808:4294967295:2147483647",
		"k1:1700000000:4294967296:0",
		"k1:01:42:0",
		"k1:1700000000:42",
		"k1:1700000000:42:100:7",
		"k1:::",
		"k2:1700000000:42:100",
		"MTAw",
		"not-base64!",
	} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, text string) {
		encoded := base64.StdEncoding.EncodeToString([]byte(text))
		for _, cursor := range []string{text, encoded} {
			decoded, err := decodeJobsCursor(cursor)
			if err != nil {
				if !errors.Is(err, errInvalidCursor) {
					t.Fatalf("decodeJobsCursor(%q) error %v, want errInvalidCursor", cursor, err)
				}
				continue
			}
			if decoded.Offset < 0 || decoded.Offset > maxCursorOffset {
				t.Fatalf("decodeJobsCursor(%q) offset %d outside [0, %d]", cursor, decoded.Offset, maxCursorOffset)
			}
			if decoded.After == nil {
				// The first page or a legacy offset: decimal digits only.
				if raw, _ := base64.StdEncoding.DecodeString(cursor); strings.TrimLeft(string(raw), "0123456789") != "" {
					t.Fatalf("decodeJobsCursor(%q) accepted %q as a legacy offset", cursor, raw)
				}
				continue
			}

			// A keyset cursor has a single spelling: re-encoding it gives the
			// cursor back, and decoding that gives the same position.
			again := encodeJobsCursor(*decoded.After, decoded.Offset)
			if cursor == encoded && again != cursor {
				t.Fatalf("decodeJobsCursor(%q) = %+v re-encodes to %q", cursor, decoded, again)
			}
			redecoded, err := decodeJobsCursor(again)
			if err != nil || redecoded.After == nil || *redecoded.After != *decoded.After || redecoded.Offset != decoded.Offset {
				t.Fatalf("cursor %q: round trip of %+v gave %+v, %v", cursor, decoded, redecoded, err)
			}
		}
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
