import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, ConfirmModal, IconButton, LoadingPlaceholder } from '@grafana/ui';
import {
  deleteAnnotation,
  GrafanaAnnotation,
  isForbiddenError,
  listAnnotationsByTags,
  refetchAnnotationById,
} from '../../../api/annotationsApi';
import {
  buildAnnotationScopeTags,
  parseAnnotationTags,
  validateAnnotationIdentity,
} from '../../../utils/annotationTags';

export interface LabelListProps {
  jobId: string;
  clusterId: string;
  /** Bumped by the parent after any successful create/delete. */
  refreshToken: number;
  /** Jump the Scene time range to a label's window. */
  onJumpToRange: (fromMs: number, toMs: number) => void;
  /** Notify the parent so it can refresh the list and the panel data layer. */
  onChanged: () => void;
}

const LIST_LIMIT = 100;

interface LabelRow {
  id: number;
  fromMs: number;
  toMs: number;
  category?: string;
  note: string;
  author: string;
  tags: string[];
}

interface MutationContext {
  key: string;
  generation: number;
}

function toRow(annotation: GrafanaAnnotation): LabelRow {
  const parsed = parseAnnotationTags(annotation.tags ?? []);
  const timeEnd = annotation.timeEnd && annotation.timeEnd > 0 ? annotation.timeEnd : annotation.time;
  return {
    id: annotation.id,
    fromMs: annotation.time,
    toMs: timeEnd,
    category: parsed.category,
    note: annotation.text ?? '',
    author: annotation.login ?? annotation.email ?? (annotation.userId ? `user ${annotation.userId}` : 'unknown'),
    tags: annotation.tags ?? [],
  };
}

function formatMs(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function LabelList({ jobId, clusterId, refreshToken, onJumpToRange, onChanged }: LabelListProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rows, setRows] = useState<LabelRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  // React state updates are deferred, and context-scoped keys keep a stale
  // operation from blocking or releasing the same annotation ID in a new job.
  const inFlightRef = useRef<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<LabelRow | null>(null);

  const contextKey = useMemo(() => JSON.stringify([jobId, clusterId]), [jobId, clusterId]);
  const activeContextRef = useRef<MutationContext>({ key: contextKey, generation: 0 });
  const listTags = useMemo(
    () => buildAnnotationScopeTags({ job: jobId, cluster: clusterId }),
    [clusterId, jobId]
  );

  useLayoutEffect(() => {
    if (activeContextRef.current.key === contextKey) {
      return;
    }
    activeContextRef.current = {
      key: contextKey,
      generation: activeContextRef.current.generation + 1,
    };
    setActionError(null);
    setDeleteTarget(null);
    setBusyIds(new Set());
  }, [contextKey]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setLoadError(null);
    listAnnotationsByTags(listTags, LIST_LIMIT)
      .then((annotations) => {
        if (cancelled) {
          return;
        }
        const mapped = annotations.map(toRow).sort((a, b) => b.fromMs - a.fromMs);
        setRows(mapped);
        setTruncated(annotations.length >= LIST_LIMIT);
        setStatus('ready');
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : 'Failed to load labels.');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [listTags, refreshToken]);

  const withBusy = useCallback(async (id: number, operationContext: MutationContext, work: (isCurrent: () => boolean) => Promise<void>) => {
    const operationKey = JSON.stringify([operationContext.key, operationContext.generation, id]);
    if (inFlightRef.current.has(operationKey)) {
      return; // a mutation is already in flight for this row
    }
    inFlightRef.current.add(operationKey);
    setBusyIds((current) => new Set(current).add(id));
    const isCurrent = () =>
      activeContextRef.current.key === operationContext.key &&
      activeContextRef.current.generation === operationContext.generation;
    try {
      await work(isCurrent);
    } finally {
      inFlightRef.current.delete(operationKey);
      if (!isCurrent()) {
        return;
      }
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const onDelete = (row: LabelRow) =>
    withBusy(row.id, activeContextRef.current, async (isCurrent) => {
      setActionError(null);
      let latest: GrafanaAnnotation | null;
      try {
        latest = await refetchAnnotationById(row.id);
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        setActionError(
          isForbiddenError(error)
            ? 'You do not have permission to view (read) annotations.'
            : error instanceof Error
              ? error.message
              : 'Failed to load the latest label before deleting.'
        );
        setDeleteTarget(null);
        return;
      }
      if (!isCurrent()) {
        return;
      }
      if (!latest) {
        setActionError('This label no longer exists. Reloading the list.');
        setDeleteTarget(null);
        onChanged();
        return;
      }
      const identityError = validateAnnotationIdentity(latest.tags, {
        category: row.category ?? '',
        job: jobId,
        cluster: clusterId,
      });
      if (identityError) {
        setActionError(identityError);
        setDeleteTarget(null);
        onChanged();
        return;
      }
      try {
        await deleteAnnotation(row.id);
        if (!isCurrent()) {
          return;
        }
        onChanged();
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        setActionError(
          isForbiddenError(error)
            ? 'You do not have permission to delete annotations.'
            : error instanceof Error
              ? error.message
              : 'Failed to delete the label.'
        );
      } finally {
        if (isCurrent()) {
          setDeleteTarget(null);
        }
      }
    });

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Labels for this job</div>

      {actionError && <Alert severity="error" title={actionError} onRemove={() => setActionError(null)} />}
      {truncated && (
        <Alert severity="warning" title={`Showing the first ${LIST_LIMIT} labels. Narrow the job scope to see the rest.`} />
      )}

      {status === 'loading' && <LoadingPlaceholder text="Loading labels..." />}
      {status === 'error' && <Alert severity="error" title={loadError ?? 'Failed to load labels.'} />}
      {status === 'ready' && rows.length === 0 && (
        <div style={{ color: 'rgba(127,127,127,0.9)' }}>No labels yet. Use “Label window” to create one.</div>
      )}

      {status === 'ready' && rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(127,127,127,0.3)' }}>
              <th style={{ padding: '6px 8px' }}>Window</th>
              <th style={{ padding: '6px 8px' }}>Category</th>
              <th style={{ padding: '6px 8px' }}>Note</th>
              <th style={{ padding: '6px 8px' }}>Author</th>
              <th style={{ padding: '6px 8px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const busy = busyIds.has(row.id);
              return (
                <tr key={row.id} style={{ borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
                  <td style={{ padding: '6px 8px' }}>
                    <button
                      type="button"
                      onClick={() => onJumpToRange(row.fromMs, row.toMs)}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#5794f2', textAlign: 'left' }}
                      aria-label={`Jump to window for label ${row.id}`}
                    >
                      {formatMs(row.fromMs)} → {formatMs(row.toMs)}
                    </button>
                  </td>
                  <td style={{ padding: '6px 8px' }}>{row.category ?? '-'}</td>
                  <td style={{ padding: '6px 8px', maxWidth: 320, overflowWrap: 'anywhere' }}>{row.note || '-'}</td>
                  <td style={{ padding: '6px 8px' }}>{row.author}</td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    <IconButton
                      name="trash-alt"
                      aria-label={`Delete label ${row.id}`}
                      tooltip="Delete label"
                      disabled={busy}
                      onClick={() => setDeleteTarget(row)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Delete label"
        body={deleteTarget ? `Delete the ${deleteTarget.category ?? 'annotation'} window from ${formatMs(deleteTarget.fromMs)}?` : ''}
        confirmText="Delete"
        onConfirm={() => {
          if (deleteTarget) {
            void onDelete(deleteTarget);
          }
        }}
        onDismiss={() => setDeleteTarget(null)}
      />
    </div>
  );
}
