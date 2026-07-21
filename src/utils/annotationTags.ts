/** Marker identifying annotations owned by this application. */
export const ANNOTATION_MARKER_TAG = 'slurm-app:annotation';

/** Schema version written by this application. */
export const ANNOTATION_SCHEMA_VERSION = '1' as const;
export type AnnotationSchemaVersion = typeof ANNOTATION_SCHEMA_VERSION;

export const ANNOTATION_TAG_KEYS = ['schema', 'job', 'cluster', 'category'] as const;
export type AnnotationTagKey = (typeof ANNOTATION_TAG_KEYS)[number];

export interface AnnotationInput {
  category: string;
  job: string;
  cluster: string;
}

export interface ParsedAnnotationTags {
  hasMarker: boolean;
  markerCount: number;
  schema?: string;
  job?: string;
  cluster?: string;
  category?: string;
  duplicateKeys: AnnotationTagKey[];
  unknownTags: string[];
}

export type AnnotationIdentityExpectation = AnnotationInput;
export type AnnotationScope = Pick<AnnotationInput, 'job' | 'cluster'>;

function isAnnotationTagKey(key: string): key is AnnotationTagKey {
  return (ANNOTATION_TAG_KEYS as readonly string[]).includes(key);
}

function parseKeyValueTag(tag: string): { key: string; value: string } | null {
  const prefix = 'slurm-app:';
  if (!tag.startsWith(prefix)) {
    return null;
  }

  const body = tag.slice(prefix.length);
  const separator = body.indexOf('=');
  if (separator < 0) {
    return null;
  }

  return { key: body.slice(0, separator), value: body.slice(separator + 1) };
}

export function buildAnnotationTags(input: AnnotationInput): string[] {
  return [
    ANNOTATION_MARKER_TAG,
    `slurm-app:schema=${ANNOTATION_SCHEMA_VERSION}`,
    `slurm-app:job=${input.job.trim()}`,
    `slurm-app:cluster=${input.cluster.trim()}`,
    `slurm-app:category=${input.category.trim()}`,
  ];
}

export function buildAnnotationScopeTags(input: AnnotationScope): string[] {
  return [
    ANNOTATION_MARKER_TAG,
    `slurm-app:schema=${ANNOTATION_SCHEMA_VERSION}`,
    `slurm-app:job=${input.job.trim()}`,
    `slurm-app:cluster=${input.cluster.trim()}`,
  ];
}

export function parseAnnotationTags(tags: readonly string[]): ParsedAnnotationTags {
  const seen = new Map<AnnotationTagKey, number>();
  const parsed: ParsedAnnotationTags = {
    hasMarker: false,
    markerCount: 0,
    duplicateKeys: [],
    unknownTags: [],
  };

  for (const tag of tags) {
    if (tag === ANNOTATION_MARKER_TAG) {
      parsed.hasMarker = true;
      parsed.markerCount += 1;
      continue;
    }

    const keyValue = parseKeyValueTag(tag);
    if (keyValue && isAnnotationTagKey(keyValue.key)) {
      seen.set(keyValue.key, (seen.get(keyValue.key) ?? 0) + 1);
      if (parsed[keyValue.key] === undefined) {
        parsed[keyValue.key] = keyValue.value;
      }
      continue;
    }

    parsed.unknownTags.push(tag);
  }

  parsed.duplicateKeys = ANNOTATION_TAG_KEYS.filter((key) => (seen.get(key) ?? 0) > 1);
  return parsed;
}

export function validateAnnotationInput(input: AnnotationInput): string[] {
  const fields = [
    { label: 'Category', value: input.category },
    { label: 'Job ID', value: input.job },
    { label: 'Cluster ID', value: input.cluster },
  ];

  return fields
    .filter((field) => field.value.trim() === '')
    .map((field) => `${field.label} must not be empty.`);
}

export function validateAnnotationIdentity(
  latestTags: readonly string[],
  expected: AnnotationIdentityExpectation
): string | null {
  const parsed = parseAnnotationTags(latestTags);

  if (!parsed.hasMarker) {
    return 'This annotation is no longer an application-managed annotation. Reload the list and try again.';
  }
  if (parsed.markerCount > 1) {
    return 'This annotation has a duplicate application annotation marker. Reload the list and resolve it before continuing.';
  }
  if (parsed.duplicateKeys.length > 0) {
    return 'This annotation has duplicate application annotation tags. Reload the list and resolve it before continuing.';
  }
  if (parsed.schema !== ANNOTATION_SCHEMA_VERSION) {
    return 'This annotation has a missing or unsupported annotation schema. Reload the list before continuing.';
  }

  const identityValues = [
    parsed.job,
    parsed.cluster,
    parsed.category,
    expected.job,
    expected.cluster,
    expected.category,
  ];
  if (identityValues.some((value) => typeof value !== 'string' || value.trim() === '')) {
    return 'This annotation has missing or empty application annotation identity tags. Reload the list and resolve it before continuing.';
  }
  if (
    parsed.job !== expected.job ||
    parsed.cluster !== expected.cluster ||
    parsed.category !== expected.category
  ) {
    return 'This annotation changed since it was listed. Reload the list before continuing.';
  }

  return null;
}
