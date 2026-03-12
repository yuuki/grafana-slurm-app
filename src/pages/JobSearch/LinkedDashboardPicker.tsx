import React from 'react';
import { Alert, Button, LoadingPlaceholder, Modal, useTheme2 } from '@grafana/ui';
import { JobRecord, LinkedDashboardSummary } from '../../api/types';

interface Props {
  job: JobRecord | null;
  dashboards: LinkedDashboardSummary[];
  loading: boolean;
  error: string | null;
  selectedDashboardUid: string;
  onSelectDashboard: (dashboardUid: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  onRefresh: () => void;
}

export function LinkedDashboardPicker({
  job,
  dashboards,
  loading,
  error,
  selectedDashboardUid,
  onSelectDashboard,
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
        {`Select a dashboard for job ${job.jobId} (${job.name}).`}
      </div>

      {loading && <LoadingPlaceholder text="Loading linked dashboards..." />}
      {error && <Alert severity="error" title={error} />}
      {!loading && !error && dashboards.length === 0 && (
        <Alert severity="info" title="No dashboards found">
          No dashboards tagged with <code>slurm-job-link</code> are available.
        </Alert>
      )}
      {!loading && dashboards.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {dashboards.map((dashboard) => (
            <label
              key={dashboard.uid}
              style={{
                display: 'flex',
                gap: 10,
                padding: 12,
                borderRadius: 6,
                border: `1px solid ${
                  dashboard.uid === selectedDashboardUid ? theme.colors.primary.main : theme.colors.border.weak
                }`,
                background:
                  dashboard.uid === selectedDashboardUid ? theme.colors.primary.transparent : theme.colors.background.secondary,
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="linked-dashboard"
                value={dashboard.uid}
                checked={dashboard.uid === selectedDashboardUid}
                onChange={() => onSelectDashboard(dashboard.uid)}
                aria-label={dashboard.title}
              />
              <span>
                <div style={{ fontWeight: 600 }}>{dashboard.title}</div>
                <div style={{ color: theme.colors.text.secondary, fontSize: 12 }}>{dashboard.url}</div>
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
          <Button onClick={onConfirm} disabled={loading || dashboards.length === 0 || !selectedDashboardUid}>
            Open dashboard
          </Button>
        </div>
      </Modal.ButtonRow>
    </Modal>
  );
}
