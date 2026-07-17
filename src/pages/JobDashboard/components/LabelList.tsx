import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, ConfirmModal, IconButton, LoadingPlaceholder } from '@grafana/ui';
import {
  deleteAnnotation,
  GrafanaAnnotation,
  isForbiddenError,
  listAnnotationsByTags,
  patchAnnotationTags,
  refetchAnnotationById,
} from '../../../api/annotationsApi';
import { parseTsfmTags, prepareConfirmUpdate, TSFM_LABEL_TAG } from '../../../utils/tsfmTags';

export interface LabelListProps {
  jobId: string;
  tsfmClusterId: string;
  /** Bumped by the parent after any successful create/confirm/delete. */
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
  event?: string;
  quality?: string;
  note: string;
  author: string;
  tags: string[];
}

function toRow(annotation: GrafanaAnnotation): LabelRow {
  const parsed = parseTsfmTags(annotation.tags ?? []);
  const timeEnd = annotation.timeEnd && annotation.timeEnd > 0 ? annotation.timeEnd : annotation.time;
  return {
    id: annotation.id,
    fromMs: annotation.time,
    toMs: timeEnd,
    event: parsed.event,
    quality: parsed.quality,
    note: annotation.text ?? '',
    author: annotation.login ?? annotation.email ?? (annotation.userId ? `user ${annotation.userId}` : 'unknown'),
    tags: annotation.tags ?? [],
  };
}

function formatMs(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function LabelList({ jobId, tsfmClusterId, refreshToken, onJumpToRange, onChanged }: LabelListProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rows, setRows] = useState<LabelRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  // Synchronous in-flight guard: React state updates are deferred, so a ref is
  // required to reliably block a second submission for the same row.
  const inFlightRef = useRef<Set<number>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<LabelRow | null>(null);

  const listTags = useMemo(
    () => [TSFM_LABEL_TAG, `tsfm:job=${jobId}`, `tsfm:cluster=${tsfmClusterId}`],
    [jobId, tsfmClusterId]
  );

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setLoadError(null);
    setActionError(null);
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

  const withBusy = useCallback(async (id: number, work: () => Promise<void>) => {
    if (inFlightRef.current.has(id)) {
      return; // a mutation is already in flight for this row
    }
    inFlightRef.current.add(id);
    setBusyIds((current) => new Set(current).add(id));
    try {
      await work();
    } finally {
      inFlightRef.current.delete(id);
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const onConfirm = (row: LabelRow) =>
    withBusy(row.id, async () => {
      setActionError(null);
      let latest: GrafanaAnnotation | null;
      try {
        latest = await refetchAnnotationById(listTags, row.id, LIST_LIMIT);
      } catch (error) {
        // A 403 here is a read-permission problem (GET), not an edit-permission one.
        setActionError(
          isForbiddenError(error)
            ? 'You do not have permission to view (read) annotations.'
            : error instanceof Error
              ? error.message
              : 'Failed to confirm the label.'
        );
        return;
      }
      if (!latest) {
        setActionError('This label no longer exists. Reloading the list.');
        onChanged();
        return;
      }
      const update = prepareConfirmUpdate(latest.tags, { event: row.event, job: jobId, cluster: tsfmClusterId });
      if ('error' in update) {
        setActionError(update.error);
        onChanged();
        return;
      }
      try {
        await patchAnnotationTags(row.id, update.tags);
        onChanged();
      } catch (error) {
        setActionError(
          isForbiddenError(error)
            ? 'You do not have permission to confirm (edit) annotations.'
            : error instanceof Error
              ? error.message
              : 'Failed to confirm the label.'
        );
      }
    });

  const onDelete = (row: LabelRow) =>
    withBusy(row.id, async () => {
      setActionError(null);
      try {
        await deleteAnnotation(row.id);
        onChanged();
      } catch (error) {
        setActionError(
          isForbiddenError(error)
            ? 'You do not have permission to delete annotations.'
            : error instanceof Error
              ? error.message
              : 'Failed to delete the label.'
        );
      } finally {
        setDeleteTarget(null);
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
              <th style={{ padding: '6px 8px' }}>Event</th>
              <th style={{ padding: '6px 8px' }}>Quality</th>
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
                  <td style={{ padding: '6px 8px' }}>{row.event ?? '-'}</td>
                  <td style={{ padding: '6px 8px' }}>{row.quality ?? '-'}</td>
                  <td style={{ padding: '6px 8px', maxWidth: 320, overflowWrap: 'anywhere' }}>{row.note || '-'}</td>
                  <td style={{ padding: '6px 8px' }}>{row.author}</td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onConfirm(row)}
                      disabled={busy || row.quality === 'confirmed'}
                      tooltip={row.quality === 'confirmed' ? 'Already confirmed' : undefined}
                    >
                      {busy ? 'Working...' : 'Confirm'}
                    </Button>
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
        body={deleteTarget ? `Delete the ${deleteTarget.event ?? 'label'} window from ${formatMs(deleteTarget.fromMs)}?` : ''}
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
