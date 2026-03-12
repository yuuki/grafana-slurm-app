import React from 'react';
import { Alert, Button, LoadingPlaceholder, useTheme2 } from '@grafana/ui';
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
}: Props) {
  const theme = useTheme2();

  if (!job) {
    return null;
  }

  return (
    <div
      aria-hidden="false"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="linked-dashboard-picker-title"
        style={{
          width: 'min(640px, 100%)',
          maxHeight: '80vh',
          overflow: 'auto',
          borderRadius: 8,
          background: theme.colors.background.primary,
          border: `1px solid ${theme.colors.border.medium}`,
          boxShadow: theme.shadows.z3,
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
          <div>
            <h2 id="linked-dashboard-picker-title" style={{ margin: 0, fontSize: 20 }}>
              Open linked dashboard
            </h2>
            <div style={{ marginTop: 6, color: theme.colors.text.secondary, fontSize: 13 }}>
              {`Select a dashboard for job ${job.jobId} (${job.name}).`}
            </div>
          </div>
          <Button variant="secondary" fill="text" onClick={onClose}>
            Close
          </Button>
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

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={loading || dashboards.length === 0 || !selectedDashboardUid}>
            Open dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
