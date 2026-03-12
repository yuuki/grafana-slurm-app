import React from 'react';
import { Alert, Button, LoadingPlaceholder, Modal, useTheme2 } from '@grafana/ui';
import { JobRecord } from '../../api/types';
import { LinkedDestinationOption } from './linkedDashboard';

interface Props {
  job: JobRecord | null;
  options: LinkedDestinationOption[];
  loading: boolean;
  error: string | null;
  selectedDestinationKey: string;
  onSelectDestination: (destinationKey: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  onRefresh: () => void;
}

export function LinkedDashboardPicker({
  job,
  options,
  loading,
  error,
  selectedDestinationKey,
  onSelectDestination,
  onClose,
  onConfirm,
  onRefresh,
}: Props) {
  const theme = useTheme2();

  if (!job) {
    return null;
  }

  return (
    <Modal
      isOpen={true}
      title="Open linked dashboard"
      onDismiss={onClose}
      closeOnEscape={true}
      closeOnBackdropClick={true}
      trapFocus={true}
      contentClassName=""
    >
      <div style={{ color: theme.colors.text.secondary, fontSize: 13, marginBottom: 16 }}>
        {`Select a destination for job ${job.jobId} (${job.name}).`}
      </div>

      {loading && <LoadingPlaceholder text="Loading linked dashboards..." />}
      {error && <Alert severity="error" title={error} />}
      {!loading && !error && options.length === 0 && (
        <Alert severity="info" title="No dashboards found">
          No dashboards tagged with <code>slurm-job-link</code> are available.
        </Alert>
      )}
      {!loading && options.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {options.map((option) => (
            <label
              key={option.key}
              style={{
                display: 'flex',
                gap: 10,
                padding: 12,
                borderRadius: 6,
                border: `1px solid ${
                  option.key === selectedDestinationKey ? theme.colors.primary.main : theme.colors.border.weak
                }`,
                background:
                  option.key === selectedDestinationKey ? theme.colors.primary.transparent : theme.colors.background.secondary,
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="linked-dashboard"
                value={option.key}
                checked={option.key === selectedDestinationKey}
                onChange={() => onSelectDestination(option.key)}
                aria-label={option.title}
              />
              <span>
                <div style={{ fontWeight: 600 }}>{option.title}</div>
                <div style={{ color: theme.colors.text.secondary, fontSize: 12 }}>{option.description}</div>
              </span>
            </label>
          ))}
        </div>
      )}

      <Modal.ButtonRow
        leftItems={
          <Button variant="secondary" onClick={onRefresh} disabled={loading}>
            Refresh list
          </Button>
        }
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={loading || options.length === 0 || !selectedDestinationKey}>
            Open
          </Button>
        </div>
      </Modal.ButtonRow>
    </Modal>
  );
}
