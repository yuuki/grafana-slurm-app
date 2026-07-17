/**
 * TSFM annotation control-tag helpers (pure functions).
 *
 * These build and parse the controlled `tsfm:` tag vocabulary that the
 * grafana-slurm-app writes onto Grafana region annotations and that the
 * sakuraone `tsfm annotations collect` pipeline reads back
 * (`src/tsfm/annotations.py`). The tag *syntax* (`tsfm:key=value`) is the
 * contract between the two sides; the event-type vocabulary is intentionally
 * open (validated for syntax only, not membership) so vocabulary additions do
 * not require a lock-step release of both repositories.
 */

/** Marker tag that identifies a TSFM label. Also the collector's query key. */
export const TSFM_LABEL_TAG = 'tsfm:label';

/** Key/value tag keys under the `tsfm:` namespace. */
export const TSFM_KV_KEYS = ['event', 'job', 'cluster', 'quality'] as const;
export type TsfmTagKey = (typeof TSFM_KV_KEYS)[number];

/** Maximum allowed length of a single tag value (post-trim). */
export const MAX_TAG_VALUE_LENGTH = 64;

export type TsfmQuality = 'candidate' | 'confirmed';
export const TSFM_QUALITIES: readonly TsfmQuality[] = ['candidate', 'confirmed'];

/** Structured input used to assemble the tag array for a new label. */
export interface TsfmLabelInput {
  event: string;
  job: string;
  cluster: string;
  quality: TsfmQuality;
}

/** Result of parsing a raw Grafana tag array. */
export interface ParsedTsfmTags {
  hasLabel: boolean;
  event?: string;
  job?: string;
  cluster?: string;
  quality?: string;
  /** Keys that appeared more than once (e.g. two `tsfm:quality=` tags). */
  duplicateKeys: TsfmTagKey[];
  /**
   * Every tag that is not the `tsfm:label` marker and not one of the four
   * recognised `tsfm:` key/value tags. Preserved verbatim so concurrent edits
   * (including future/unknown tsfm tags and unrelated Grafana tags) survive a
   * quality update.
   */
  unknownTags: string[];
}

function isTsfmKvKey(key: string): key is TsfmTagKey {
  return (TSFM_KV_KEYS as readonly string[]).includes(key);
}

/** Parse a single `tsfm:key=value` tag. Returns null for anything else. */
export function parseTsfmKvTag(tag: string): { key: string; value: string } | null {
  if (!tag.startsWith('tsfm:')) {
    return null;
  }
  const body = tag.slice('tsfm:'.length);
  const eq = body.indexOf('=');
  if (eq < 0) {
    return null;
  }
  return { key: body.slice(0, eq), value: body.slice(eq + 1) };
}

/**
 * Assemble the ordered tag array for a TSFM label. The order matches the
 * frozen contract fixture (`__fixtures__/tsfm-annotation-contract.json`).
 * Values are trimmed; callers should validate first via
 * {@link validateTsfmLabelInput}.
 */
export function buildTsfmTags(input: TsfmLabelInput): string[] {
  return [
    TSFM_LABEL_TAG,
    `tsfm:event=${input.event.trim()}`,
    `tsfm:job=${input.job.trim()}`,
    `tsfm:cluster=${input.cluster.trim()}`,
    `tsfm:quality=${input.quality}`,
  ];
}

/** Parse a raw Grafana tag array into its TSFM view, preserving unknown tags. */
export function parseTsfmTags(tags: readonly string[]): ParsedTsfmTags {
  const seen = new Map<TsfmTagKey, number>();
  const parsed: ParsedTsfmTags = { hasLabel: false, duplicateKeys: [], unknownTags: [] };

  for (const tag of tags) {
    if (tag === TSFM_LABEL_TAG) {
      parsed.hasLabel = true;
      continue;
    }
    const kv = parseTsfmKvTag(tag);
    if (kv && isTsfmKvKey(kv.key)) {
      seen.set(kv.key, (seen.get(kv.key) ?? 0) + 1);
      // First occurrence wins for the structured view; duplicates are flagged.
      if (parsed[kv.key] === undefined) {
        parsed[kv.key] = kv.value;
      }
      continue;
    }
    parsed.unknownTags.push(tag);
  }

  parsed.duplicateKeys = TSFM_KV_KEYS.filter((key) => (seen.get(key) ?? 0) > 1);
  return parsed;
}

/**
 * Validate the syntax of a label input. Returns a list of human-readable
 * error messages (empty when valid). Membership of `event` in the configured
 * vocabulary is *not* checked here — custom event types are allowed.
 */
export function validateTsfmLabelInput(input: TsfmLabelInput): string[] {
  const errors: string[] = [];
  const fields: Array<{ key: TsfmTagKey; label: string; value: string }> = [
    { key: 'event', label: 'Event type', value: input.event },
    { key: 'job', label: 'Job ID', value: input.job },
    { key: 'cluster', label: 'Cluster ID', value: input.cluster },
  ];

  for (const field of fields) {
    const trimmed = field.value.trim();
    if (trimmed === '') {
      errors.push(`${field.label} must not be empty.`);
    } else if (trimmed.length > MAX_TAG_VALUE_LENGTH) {
      errors.push(`${field.label} must be at most ${MAX_TAG_VALUE_LENGTH} characters.`);
    }
  }

  if (!TSFM_QUALITIES.includes(input.quality)) {
    errors.push(`Quality must be one of: ${TSFM_QUALITIES.join(', ')}.`);
  }

  return errors;
}

/**
 * Replace the quality tag in an existing tag array, preserving every other
 * tag verbatim (including non-TSFM tags and any unknown `tsfm:` tags). Used by
 * the confirm workflow, which must not clobber concurrent edits.
 */
export function setQualityTag(tags: readonly string[], quality: TsfmQuality): string[] {
  const kept = tags.filter((tag) => {
    const kv = parseTsfmKvTag(tag);
    return !(kv && kv.key === 'quality');
  });
  return [...kept, `tsfm:quality=${quality}`];
}

/** The identity of a label as captured when the list was rendered. */
export interface ConfirmExpectation {
  event?: string;
  job: string;
  cluster: string;
}

export type ConfirmUpdate = { tags: string[] } | { error: string };

/**
 * Build the tag array for confirming a label, from the *freshly re-fetched*
 * tags, aborting on any drift from what the list showed. Callers must PATCH
 * with the returned tags (whole-array replacement) only when no `error` is
 * present. See design §3.3.
 */
export function prepareConfirmUpdate(latestTags: readonly string[], expected: ConfirmExpectation): ConfirmUpdate {
  const parsed = parseTsfmTags(latestTags);
  if (!parsed.hasLabel) {
    return { error: 'This annotation is no longer a TSFM label. Reload the list and try again.' };
  }
  if (parsed.duplicateKeys.length > 0) {
    return { error: 'This annotation has duplicate TSFM tags. Reload the list and resolve it before confirming.' };
  }
  if (parsed.job !== expected.job || parsed.cluster !== expected.cluster || parsed.event !== expected.event) {
    return { error: 'This annotation changed since it was listed. Reload the list before confirming.' };
  }
  return { tags: setQualityTag(latestTags, 'confirmed') };
}
