import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Badge, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { JobRecord } from '../../api/types';

interface Props {
  jobs: JobRecord[];
  loading: boolean;
  onOpenJob: (clusterId: string, jobId: number) => void;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

function formatTimestamp(ts: number): string {
  if (ts === 0) {
    return '-';
  }
  return new Date(ts * 1000).toLocaleString();
}

type BadgeColor = 'green' | 'red' | 'orange' | 'blue';

function stateColor(state: string): BadgeColor {
  switch (state) {
    case 'RUNNING':
      return 'green';
    case 'COMPLETED':
      return 'blue';
    case 'FAILED':
    case 'NODE_FAIL':
      return 'red';
    case 'PENDING':
    case 'SUSPENDED':
      return 'orange';
    default:
      return 'blue';
  }
}

function getStyles(theme: GrafanaTheme2) {
  return {
    th: css({
      textAlign: 'left' as const,
      padding: '8px 12px',
      borderBottom: `2px solid ${theme.colors.border.medium}`,
      fontWeight: 500,
    }),
    td: css({
      padding: '8px 12px',
      borderBottom: `1px solid ${theme.colors.border.weak}`,
    }),
  };
}

export function JobTable({ jobs, loading, onOpenJob }: Props) {
  const styles = useStyles2(getStyles);

  if (loading) {
    return <LoadingPlaceholder text="Loading jobs..." />;
  }

  if (jobs.length === 0) {
    return <div>No jobs found.</div>;
  }

  const elapsed = (job: JobRecord) => {
    const end = job.endTime > 0 ? job.endTime : Math.floor(Date.now() / 1000);
    return end - job.startTime;
  };

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th className={styles.th}>Job ID</th>
          <th className={styles.th}>Name</th>
          <th className={styles.th}>User</th>
          <th className={styles.th}>Account</th>
          <th className={styles.th}>Partition</th>
          <th className={styles.th}>State</th>
          <th className={styles.th}>Nodes</th>
          <th className={styles.th}>GPUs</th>
          <th className={styles.th}>Start</th>
          <th className={styles.th}>Elapsed</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={`${job.clusterId}-${job.jobId}`} onClick={() => onOpenJob(job.clusterId, job.jobId)} style={{ cursor: 'pointer' }}>
            <td className={styles.td}>{job.jobId}</td>
            <td className={styles.td}>{job.name}</td>
            <td className={styles.td}>{job.user}</td>
            <td className={styles.td}>{job.account || '-'}</td>
            <td className={styles.td}>{job.partition}</td>
            <td className={styles.td}>
              <Badge text={job.state} color={stateColor(job.state)} />
            </td>
            <td className={styles.td}>{job.nodeCount}</td>
            <td className={styles.td}>{job.gpusTotal || '-'}</td>
            <td className={styles.td}>{formatTimestamp(job.startTime)}</td>
            <td className={styles.td}>{formatDuration(elapsed(job))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

