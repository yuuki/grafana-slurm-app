import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Badge, Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { JobRecord } from '../../api/types';
import { formatDuration, formatTimestamp } from './jobTime';
import { getJobStateBadgeColor } from './jobStateStyles';
import { JobUtilization } from './jobMetrics';
import { jobKey } from './model';

interface Props {
  jobs: JobRecord[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadedCount: number;
  totalCount: number;
  pageSize: number;
  utilizationMap?: Map<string, JobUtilization>;
  onLoadMore: () => void;
  onOpenJob: (job: JobRecord) => void;
}

function formatPercent(value: number | undefined, loading: boolean): string {
  if (loading) {
    return '...';
  }
  if (value === undefined) {
    return '-';
  }
  return `${value.toFixed(1)}%`;
}

function getStyles(theme: GrafanaTheme2) {
  return {
    table: css({
      width: '100%',
      borderCollapse: 'collapse',
    }),
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
    row: css({
      cursor: 'pointer',
      '&:hover td': {
        background: theme.colors.action.hover,
      },
      '&:nth-child(even)': {
        background: theme.colors.background.secondary,
      },
    }),
    footer: css({
      marginTop: 16,
      display: 'flex',
      justifyContent: 'center',
    }),
  };
}

export function JobTable({ jobs, loading, hasMore, loadingMore, loadedCount, totalCount, pageSize, utilizationMap, onLoadMore, onOpenJob }: Props) {
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
  const remainingCount = Math.max(totalCount - loadedCount, 0);
  const nextLoadCount = Math.min(pageSize, remainingCount);

  return (
    <div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.th}>Job ID</th>
            <th className={styles.th}>Name</th>
            <th className={styles.th}>User</th>
            <th className={styles.th}>Account</th>
            <th className={styles.th}>Partition</th>
            <th className={styles.th}>State</th>
            <th className={styles.th}>Nodes</th>
            <th className={styles.th}>Node List</th>
            <th className={styles.th}>GPUs</th>
            <th className={styles.th}>Start</th>
            <th className={styles.th}>Elapsed</th>
            <th className={styles.th}>CPU%</th>
            <th className={styles.th}>GPU%</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const key = jobKey(job.clusterId, job.jobId);
            const util = utilizationMap?.get(key);
            const loadingUtil = utilizationMap !== undefined && util === undefined;
            return (
              <tr key={key} onClick={() => onOpenJob(job)} className={styles.row}>
                <td className={styles.td}>{job.jobId}</td>
                <td className={styles.td}>{job.name}</td>
                <td className={styles.td}>{job.user}</td>
                <td className={styles.td}>{job.account || '-'}</td>
                <td className={styles.td}>{job.partition}</td>
                <td className={styles.td}>
                  <Badge text={job.state} color={getJobStateBadgeColor(job.state)} />
                </td>
                <td className={styles.td}>{job.nodeCount}</td>
                <td className={styles.td}>{job.nodeList || '-'}</td>
                <td className={styles.td}>{job.gpusTotal || '-'}</td>
                <td className={styles.td}>{formatTimestamp(job.startTime)}</td>
                <td className={styles.td}>{formatDuration(elapsed(job))}</td>
                <td className={styles.td}>{formatPercent(util?.cpuPercent, loadingUtil)}</td>
                <td className={styles.td}>
                  {job.gpusTotal === 0 ? '-' : formatPercent(util?.gpuPercent, loadingUtil)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hasMore && nextLoadCount > 0 && (
        <div className={styles.footer}>
          <Button type="button" onClick={onLoadMore} disabled={loadingMore}>
            {`Show ${nextLoadCount} more (${loadedCount}/${totalCount})`}
          </Button>
        </div>
      )}
    </div>
  );
}
