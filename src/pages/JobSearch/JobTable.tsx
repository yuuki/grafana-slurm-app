import React from 'react';
import { Badge, LoadingPlaceholder } from '@grafana/ui';
import { JobRecord } from '../../api/types';
import { getJobStateBadgeColor } from './jobStateStyles';

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

export function JobTable({ jobs, loading, onOpenJob }: Props) {
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
          <th style={thStyle}>Job ID</th>
          <th style={thStyle}>Name</th>
          <th style={thStyle}>User</th>
          <th style={thStyle}>Account</th>
          <th style={thStyle}>Partition</th>
          <th style={thStyle}>State</th>
          <th style={thStyle}>Nodes</th>
          <th style={thStyle}>GPUs</th>
          <th style={thStyle}>Start</th>
          <th style={thStyle}>Elapsed</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={`${job.clusterId}-${job.jobId}`} onClick={() => onOpenJob(job.clusterId, job.jobId)} style={{ cursor: 'pointer' }}>
            <td style={tdStyle}>{job.jobId}</td>
            <td style={tdStyle}>{job.name}</td>
            <td style={tdStyle}>{job.user}</td>
            <td style={tdStyle}>{job.account || '-'}</td>
            <td style={tdStyle}>{job.partition}</td>
            <td style={tdStyle}>
              <Badge text={job.state} color={getJobStateBadgeColor(job.state)} />
            </td>
            <td style={tdStyle}>{job.nodeCount}</td>
            <td style={tdStyle}>{job.gpusTotal || '-'}</td>
            <td style={tdStyle}>{formatTimestamp(job.startTime)}</td>
            <td style={tdStyle}>{formatDuration(elapsed(job))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '2px solid rgba(204, 204, 220, 0.15)',
  fontWeight: 500,
};

const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid rgba(204, 204, 220, 0.07)',
};
