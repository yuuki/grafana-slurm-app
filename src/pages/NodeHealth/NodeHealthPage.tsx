import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue, TimeRange } from '@grafana/data';
import {
  Alert,
  Badge,
  Field,
  LoadingPlaceholder,
  RadioButtonGroup,
  Select,
  TimeRangePicker,
  useStyles2,
} from '@grafana/ui';
import { listClusters } from '../../api/slurmApi';
import { ClusterSummary } from '../../api/types';
import { formatTimestamp } from '../JobSearch/jobTime';
import { TIME_RANGE_PRESETS } from '../JobSearch/JobTimeline';
import { getNextClusterId } from '../JobSearch/model';
import {
  DEFAULT_TIMELINE_RAW_TO,
  makeAbsoluteTimeRange,
  makeRelativeTimeRange,
  resolveTimelineRange,
} from '../JobSearch/timelineRange';
import { getNodeHealth } from './api';
import { scoreSeverity, Severity } from './severity';
import { NodeHealthPayload, NodeHealthStats } from './types';
import { buildViewJobsUrl } from './viewJobsLink';

const DEFAULT_NODE_HEALTH_RANGE = 'now-7d';

function badgeColor(severity: Severity): 'red' | 'orange' | 'green' {
  switch (severity) {
    case 'critical':
      return 'red';
    case 'warning':
      return 'orange';
    default:
      return 'green';
  }
}

function failureRatePercent(node: NodeHealthStats): number {
  return Math.min(100, Math.max(0, node.failureRate * 100));
}

function getStyles(theme: GrafanaTheme2) {
  return {
    page: css({
      padding: '16px 24px 32px',
    }),
    heading: css({
      marginTop: 0,
      marginBottom: 16,
    }),
    controls: css({
      display: 'flex',
      alignItems: 'flex-end',
      flexWrap: 'wrap',
      gap: 16,
      marginBottom: 16,
    }),
    presets: css({
      paddingBottom: 4,
    }),
    tableWrapper: css({
      overflowX: 'auto',
      marginTop: 16,
    }),
    table: css({
      width: '100%',
      borderCollapse: 'collapse',
      minWidth: 1080,
    }),
    th: css({
      textAlign: 'left',
      padding: '8px 12px',
      borderBottom: `2px solid ${theme.colors.border.medium}`,
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }),
    td: css({
      padding: '8px 12px',
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      whiteSpace: 'nowrap',
    }),
    row: css({
      '&:nth-child(even)': {
        background: theme.colors.background.secondary,
      },
      '&:hover td': {
        background: theme.colors.action.hover,
      },
    }),
    lowSample: css({
      color: theme.colors.text.secondary,
      opacity: 0.6,
    }),
    rate: css({
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }),
    rateTrack: css({
      width: 80,
      height: 6,
      overflow: 'hidden',
      borderRadius: 3,
      background: theme.colors.background.canvas,
      border: `1px solid ${theme.colors.border.weak}`,
    }),
    rateFill: css({
      height: '100%',
      background: theme.colors.primary.main,
    }),
  };
}

export function NodeHealthPage() {
  const styles = useStyles2(getStyles);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [clusterId, setClusterId] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRange>(() =>
    makeRelativeTimeRange(DEFAULT_NODE_HEALTH_RANGE, DEFAULT_TIMELINE_RAW_TO)
  );
  const [timeZone, setTimeZone] = useState('browser');
  const [payload, setPayload] = useState<NodeHealthPayload | null>(null);
  const [loadingClusters, setLoadingClusters] = useState(true);
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listClusters()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setClusters(response.clusters);
        setLoadingHealth(response.clusters.length > 0);
        setError(null);
        setClusterId((current) => getNextClusterId(response.clusters, current));
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoadingHealth(false);
          setError(cause instanceof Error ? cause.message : 'Failed to load clusters');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingClusters(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!clusterId) {
      return;
    }
    let cancelled = false;
    const window = resolveTimelineRange(timeRange);
    getNodeHealth(clusterId, window.from, window.to)
      .then((response) => {
        if (!cancelled) {
          setPayload(response);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setPayload(null);
          setError(cause instanceof Error ? cause.message : 'Failed to load node health');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingHealth(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId, timeRange]);

  const clusterOptions = useMemo<Array<SelectableValue<string>>>(
    () => clusters.map((cluster) => ({ label: cluster.displayName, value: cluster.id })),
    [clusters]
  );
  const activePreset =
    typeof timeRange.raw.from === 'string' && timeRange.raw.to === DEFAULT_TIMELINE_RAW_TO
      ? timeRange.raw.from
      : undefined;
  const updateTimeRange = useCallback((next: TimeRange) => {
    setLoadingHealth(true);
    setError(null);
    setTimeRange(next);
  }, []);
  const moveBackward = useCallback(() => {
    const { from, to } = resolveTimelineRange(timeRange);
    const half = Math.floor((to - from) / 2);
    updateTimeRange(makeAbsoluteTimeRange((from - half) * 1000, (to - half) * 1000));
  }, [timeRange, updateTimeRange]);
  const moveForward = useCallback(() => {
    const { from, to } = resolveTimelineRange(timeRange);
    const half = Math.floor((to - from) / 2);
    updateTimeRange(makeAbsoluteTimeRange((from + half) * 1000, (to + half) * 1000));
  }, [timeRange, updateTimeRange]);
  const zoom = useCallback(() => {
    const { from, to } = resolveTimelineRange(timeRange);
    const half = Math.floor((to - from) / 2);
    updateTimeRange(makeAbsoluteTimeRange((from - half) * 1000, (to + half) * 1000));
  }, [timeRange, updateTimeRange]);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Node Health</h1>
      <div className={styles.controls}>
        <Field label="Cluster">
          <Select
            options={clusterOptions}
            value={clusterOptions.find((option) => option.value === clusterId) ?? null}
            onChange={(option: SelectableValue<string>) => {
              setLoadingHealth(true);
              setError(null);
              setClusterId(option.value ?? '');
            }}
            width={24}
            isLoading={loadingClusters}
            placeholder="Choose cluster..."
          />
        </Field>
        <div className={styles.presets}>
          <RadioButtonGroup
            size="sm"
            options={TIME_RANGE_PRESETS}
            value={activePreset}
            onChange={(value) => updateTimeRange(makeRelativeTimeRange(value, DEFAULT_TIMELINE_RAW_TO))}
          />
        </div>
        <TimeRangePicker
          value={timeRange}
          onChange={updateTimeRange}
          onChangeTimeZone={setTimeZone}
          timeZone={timeZone}
          onMoveBackward={moveBackward}
          onMoveForward={moveForward}
          onZoom={zoom}
        />
      </div>

      {error && <Alert severity="error" title={error} />}
      {payload?.truncated && (
        <Alert severity="warning" title="results based on the most recent 20,000 jobs" />
      )}
      {(loadingClusters || loadingHealth) && <LoadingPlaceholder text="Loading node health..." />}
      {!loadingClusters && !loadingHealth && payload && payload.nodes.length === 0 && (
        <div>No finished jobs in this window</div>
      )}
      {!loadingClusters && !loadingHealth && payload && payload.nodes.length > 0 && (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Node</th>
                <th className={styles.th}>Jobs</th>
                <th className={styles.th}>Failed</th>
                <th className={styles.th}>NODE_FAIL</th>
                <th className={styles.th}>failed_node hits</th>
                <th className={styles.th}>Failure rate</th>
                <th className={styles.th}>Score</th>
                <th className={styles.th}>Last failure</th>
                <th className={styles.th}>View jobs</th>
              </tr>
            </thead>
            <tbody>
              {payload.nodes.map((node) => {
                const percent = failureRatePercent(node);
                const severity = scoreSeverity(node.score, node.lowSample);
                return (
                  <tr
                    key={node.name}
                    className={`${styles.row}${node.lowSample ? ` ${styles.lowSample}` : ''}`}
                  >
                    <td className={styles.td}>{node.name}</td>
                    <td className={styles.td}>{node.totalJobs}</td>
                    <td className={styles.td}>{node.failedJobs}</td>
                    <td className={styles.td}>{node.nodeFailJobs}</td>
                    <td className={styles.td}>{node.failedNodeHits}</td>
                    <td className={styles.td}>
                      <div className={styles.rate}>
                        <div className={styles.rateTrack} aria-hidden="true">
                          <div className={styles.rateFill} style={{ width: `${percent}%` }} />
                        </div>
                        <span>{percent.toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className={styles.td}>
                      <Badge text={node.score.toFixed(2)} color={badgeColor(severity)} />
                    </td>
                    <td className={styles.td}>
                      {node.lastFailureAt ? formatTimestamp(node.lastFailureAt) : '-'}
                    </td>
                    <td className={styles.td}>
                      <a
                        href={buildViewJobsUrl(
                          payload.cluster.id,
                          node.name,
                          payload.window.from * 1000,
                          payload.window.to * 1000
                        )}
                      >
                        View jobs
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
