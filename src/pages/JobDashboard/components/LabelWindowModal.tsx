import React, { useEffect, useMemo, useRef, useState } from 'react';
import { dateTime, SelectableValue, TimeRange } from '@grafana/data';
import { Alert, Button, Field, Modal, Select, TextArea, TimeRangeInput } from '@grafana/ui';
import { createAnnotation, isForbiddenError } from '../../../api/annotationsApi';
import { buildAnnotationTags, validateAnnotationInput } from '../../../utils/annotationTags';

export interface LabelWindowModalProps {
  isOpen: boolean;
  jobId: string;
  clusterId: string;
  /** Configured category vocabulary; custom values are also allowed. */
  categories: string[];
  /** Snapshot of the current Scene time range, epoch milliseconds. */
  initialRange: { fromMs: number; toMs: number };
  /** Job execution window for the out-of-range warning. `endMs` null = running. */
  jobWindow: { startMs: number; endMs: number | null };
  onCreated: () => void;
  onDismiss: () => void;
}

function toTimeRange(fromMs: number, toMs: number): TimeRange {
  const from = dateTime(fromMs);
  const to = dateTime(toMs);
  return { from, to, raw: { from, to } };
}

/**
 * True when the selected window falls substantially outside the job's
 * execution window. Advisory only (never blocks submission). For running jobs
 * (`endMs` null) only the lower bound is checked.
 */
export function isRangeFarOutsideJob(
  range: { fromMs: number; toMs: number },
  job: { startMs: number; endMs: number | null }
): boolean {
  const duration = job.endMs !== null ? Math.max(job.endMs - job.startMs, 0) : 0;
  const margin = Math.max(duration * 0.1, 60_000);
  if (range.fromMs < job.startMs - margin) {
    return true;
  }
  if (job.endMs !== null && range.toMs > job.endMs + margin) {
    return true;
  }
  return false;
}

export function LabelWindowModal(props: LabelWindowModalProps) {
  // Mount only while open so all local state resets on each reopen.
  if (!props.isOpen) {
    return null;
  }
  return <LabelWindowModalContent key={JSON.stringify([props.jobId, props.clusterId])} {...props} />;
}

function LabelWindowModalContent({
  isOpen,
  jobId,
  clusterId,
  categories,
  initialRange,
  jobWindow,
  onCreated,
  onDismiss,
}: LabelWindowModalProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>(() => toTimeRange(initialRange.fromMs, initialRange.toMs));
  const [category, setCategory] = useState<string>('');
  const [memo, setMemo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const categoryOptions = useMemo<Array<SelectableValue<string>>>(
    () => categories.map((value) => ({ label: value, value })),
    [categories]
  );

  const fromMs = timeRange.from.valueOf();
  const toMs = timeRange.to.valueOf();

  const previewTags = useMemo(
    () => buildAnnotationTags({ category: category || '<category>', job: jobId, cluster: clusterId }),
    [category, clusterId, jobId]
  );

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!(toMs > fromMs)) {
      errors.push('End time must be after the start time.');
    }
    errors.push(...validateAnnotationInput({ category, job: jobId, cluster: clusterId }));
    return errors;
  }, [category, clusterId, fromMs, jobId, toMs]);

  const outsideJobWarning = isRangeFarOutsideJob({ fromMs, toMs }, jobWindow);

  const onSubmit = async () => {
    if (validationErrors.length > 0 || submitting) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmedMemo = memo.trim();
      await createAnnotation({
        time: fromMs,
        timeEnd: toMs,
        tags: buildAnnotationTags({ category, job: jobId, cluster: clusterId }),
        text: trimmedMemo || category.trim(),
      });
      if (!activeRef.current) {
        return;
      }
      onCreated();
      onDismiss();
    } catch (error) {
      if (!activeRef.current) {
        return;
      }
      if (isForbiddenError(error)) {
        setSubmitError('You do not have permission to create annotations. An Editor or Admin role with core annotation write access is required.');
      } else {
        setSubmitError(error instanceof Error ? error.message : 'Failed to create the label.');
      }
    } finally {
      if (activeRef.current) {
        setSubmitting(false);
      }
    }
  };

  return (
    <Modal title="Label window" isOpen={isOpen} onDismiss={onDismiss}>
      {submitError && <Alert severity="error" title={submitError} />}

      <Field label="Time range" description="Zoom a panel to the window of interest, then fine-tune here. Stored as absolute time.">
        <TimeRangeInput value={timeRange} onChange={setTimeRange} clearable={false} hideTimeZone={false} />
      </Field>

      <Field label="Category" description="Pick a configured category or type a custom one.">
        <Select
          inputId="job-annotation-category"
          options={categoryOptions}
          value={category ? { label: category, value: category } : null}
          onChange={(selected) => setCategory(selected?.value ?? '')}
          onCreateOption={(custom) => setCategory(custom.trim())}
          allowCustomValue
          placeholder="Select or type a category..."
        />
      </Field>

      <Field label="Note" description="Free-text context stored on the annotation.">
        <TextArea value={memo} onChange={(e) => setMemo(e.currentTarget.value)} rows={3} placeholder="What happened in this window?" />
      </Field>

      <Field label="Tags preview">
        <div aria-label="Tags preview" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {previewTags.map((tag) => (
            <code key={tag} style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(127,127,127,0.15)' }}>
              {tag}
            </code>
          ))}
        </div>
      </Field>

      {outsideJobWarning && (
        <Alert severity="warning" title="The selected window is well outside this job's execution period.">
          You can still save it, but double-check the range.
        </Alert>
      )}

      {validationErrors.length > 0 && (
        <Alert severity="info" title="Complete the form to save">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {validationErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Modal.ButtonRow>
        <Button variant="secondary" onClick={onDismiss} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={submitting || validationErrors.length > 0}>
          {submitting ? 'Saving...' : 'Save label'}
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
}
