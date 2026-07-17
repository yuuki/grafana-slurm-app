import { getBackendSrv } from '@grafana/runtime';

/**
 * Thin wrapper over the core Grafana annotations HTTP API
 * (`/api/annotations`). Calls go through `getBackendSrv()` so they run in the
 * browsing user's session: the annotation's author (`userId`/`login`) is
 * recorded correctly and creation/edit/delete are governed by the user's core
 * annotation RBAC (see docs/annotation-labeling.md).
 *
 * Annotations are written org-level (no `dashboardUID`) so labels outlive any
 * particular dashboard/lens UI.
 */

const ANNOTATIONS_URL = '/api/annotations';

export interface GrafanaAnnotation {
  id: number;
  time: number;
  timeEnd?: number;
  tags: string[];
  text: string;
  userId?: number;
  login?: string;
  email?: string;
}

export interface CreateAnnotationInput {
  /** Region start, epoch milliseconds. */
  time: number;
  /** Region end, epoch milliseconds. Must be greater than `time`. */
  timeEnd: number;
  tags: string[];
  text: string;
}

export interface CreateAnnotationResult {
  id: number;
  message?: string;
}

/** Create an org-level region annotation. */
export async function createAnnotation(input: CreateAnnotationInput): Promise<CreateAnnotationResult> {
  return getBackendSrv().post<CreateAnnotationResult>(ANNOTATIONS_URL, input);
}

/**
 * List annotations matching *all* of the given tags (AND semantics). Grafana
 * requires one repeated `tags` query parameter per tag, so this uses
 * `URLSearchParams.append()` (not `.set()`), and pins `matchAny=false`.
 */
export async function listAnnotationsByTags(tags: string[], limit = 100): Promise<GrafanaAnnotation[]> {
  const params = new URLSearchParams();
  for (const tag of tags) {
    params.append('tags', tag);
  }
  params.append('matchAny', 'false');
  params.append('limit', String(limit));
  return getBackendSrv().get<GrafanaAnnotation[]>(`${ANNOTATIONS_URL}?${params.toString()}`);
}

/**
 * Grafana has no single-annotation GET endpoint, so re-read via the same
 * tag query the list uses and locate by id. Returns null if the annotation is
 * no longer present under those tags (deleted or re-tagged concurrently).
 */
export async function refetchAnnotationById(
  tags: string[],
  id: number,
  limit = 100
): Promise<GrafanaAnnotation | null> {
  const annotations = await listAnnotationsByTags(tags, limit);
  return annotations.find((annotation) => annotation.id === id) ?? null;
}

/**
 * Partially update an annotation's tags. PATCH replaces the entire `tags`
 * array (it is not additive), so callers must send the full desired set.
 */
export async function patchAnnotationTags(id: number, tags: string[]): Promise<void> {
  await getBackendSrv().patch(`${ANNOTATIONS_URL}/${id}`, { tags });
}

export async function deleteAnnotation(id: number): Promise<void> {
  await getBackendSrv().delete(`${ANNOTATIONS_URL}/${id}`);
}

/** True when an error thrown by getBackendSrv represents an HTTP 403. */
export function isForbiddenError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: number }).status === 403;
}
