import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Alert, Button, IconButton, TimeRangeInput, useStyles2 } from '@grafana/ui';
import { ClusterSummary, JobRecord } from '../../api/types';
import { JobFilters } from '../JobSearch/JobFilters';
import { formatDuration } from '../JobSearch/jobTime';
import { applyFilterValue, MetadataField, SearchFilters } from '../JobSearch/model';
import { navigateToJobPage } from '../JobSearch/navigation';
import { timelineRangeToRawValues } from '../JobSearch/timelineRange';
import { COMPARE_JOB_LIMIT, JobSetMode } from './model';

interface Props {
  clusters: ClusterSummary[];
  loadingClusters: boolean;
  mode: JobSetMode;
  filters: SearchFilters;
  appliedFilters: SearchFilters;
  timeRange: TimeRange;
  loading: boolean;
  error: string | null;
  shownCount: number;
  total: number;
  hiddenNonGpu: number;
  missingIds: string[];
  baseline: JobRecord | null;
  onFiltersChange: (filters: SearchFilters) => void;
  onApplyFilter: (filters?: SearchFilters) => void;
  onTimeRangeChange: (range: TimeRange) => void;
  onSwitchToFilter: () => void;
  onClearBaseline: () => void;
}

const PLAIN_FILTERS: Array<[keyof SearchFilters, string]> = [
  ['name', 'name'],
  ['user', 'user'],
  ['account', 'account'],
  ['partition', 'partition'],
  ['state', 'state'],
  ['nodeNames', 'node'],
];

export function describeFilters(filters: Partial<SearchFilters>): string[] {
  const parts: string[] = [];
  for (const [field, label] of PLAIN_FILTERS) {
    const value = filters[field];
    if (value) {
      parts.push(`${label}=${value}`);
    }
  }
  if (filters.nodesMin) {
    parts.push(`nodes>=${filters.nodesMin}`);
  }
  if (filters.nodesMax) {
    parts.push(`nodes<=${filters.nodesMax}`);
  }
  if (filters.elapsedMin) {
    parts.push(`elapsed>=${formatDuration(Number(filters.elapsedMin))}`);
  }
  if (filters.elapsedMax) {
    parts.push(`elapsed<=${formatDuration(Number(filters.elapsedMax))}`);
  }
  return parts;
}

function getStyles(theme: GrafanaTheme2) {
  return {
    bar: css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing(1), margin: theme.spacing(1, 0) }),
    label: css({ color: theme.colors.text.secondary }),
    chip: css({
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: theme.shape.radius.default,
      padding: theme.spacing(0.25, 1),
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
    editor: css({ padding: theme.spacing(1), background: theme.colors.background.secondary, marginBottom: theme.spacing(1) }),
  };
}

export function JobSetBar({
  clusters,
  loadingClusters,
  mode,
  filters,
  appliedFilters,
  timeRange,
  loading,
  error,
  shownCount,
  total,
  hiddenNonGpu,
  missingIds,
  baseline,
  onFiltersChange,
  onApplyFilter,
  onTimeRangeChange,
  onSwitchToFilter,
  onClearBaseline,
}: Props) {
  const styles = useStyles2(getStyles);
  const [editing, setEditing] = useState(false);
  const clusterName = clusters.find((c) => c.id === appliedFilters.clusterId)?.displayName ?? appliedFilters.clusterId;
  const chips = describeFilters(appliedFilters);
  const raw = timelineRangeToRawValues(timeRange);

  const selectMetadata = (field: MetadataField, value: string) => {
    const next = applyFilterValue(filters, field, value);
    onFiltersChange(next);
    onApplyFilter(next);
  };

  return (
    <div>
      <div className={styles.bar}>
        <span className={styles.label}>Cluster</span>
        <span className={styles.chip}>{clusterName}</span>
        <span className={styles.label}>Jobs</span>
        {mode === 'filter' ? (
          <>
            {chips.length > 0 ? (
              chips.map((chip) => (
                <span key={chip} className={styles.chip}>
                  {chip}
                </span>
              ))
            ) : (
              <span className={styles.chip}>All jobs</span>
            )}
            <span className={styles.chip}>{`${raw.from} to ${raw.to}`}</span>
            <Button size="sm" variant="secondary" icon="filter" onClick={() => setEditing((current) => !current)}>
              {editing ? 'Hide filter' : 'Edit filter'}
            </Button>
          </>
        ) : (
          <>
            <span className={styles.chip}>{`${shownCount} picked jobs`}</span>
            <Button size="sm" variant="secondary" onClick={onSwitchToFilter}>
              Use search filter
            </Button>
          </>
        )}
        <span className={styles.muted}>{loading ? 'Loading jobs…' : `${shownCount} jobs`}</span>
        {hiddenNonGpu > 0 && <span className={styles.muted}>{`${hiddenNonGpu} jobs hidden (no GPUs)`}</span>}
        {baseline && (
          <span className={styles.chip}>
            {`Baseline: #${baseline.jobId} ${baseline.name}`}
            <IconButton name="times" size="sm" tooltip="Clear baseline" onClick={onClearBaseline} />
          </span>
        )}
      </div>
      {editing && mode === 'filter' && (
        <div className={styles.editor}>
          <TimeRangeInput value={timeRange} onChange={onTimeRangeChange} clearable={false} />
          <JobFilters
            clusters={clusters}
            filters={filters}
            loadingClusters={loadingClusters}
            onChange={onFiltersChange}
            onSelectMetadata={selectMetadata}
            onSearch={() => onApplyFilter()}
            onOpenJob={(clusterId, jobId) => navigateToJobPage(clusterId, jobId)}
          />
        </div>
      )}
      {mode === 'filter' && total > COMPARE_JOB_LIMIT && (
        <Alert severity="info" title={`Showing ${COMPARE_JOB_LIMIT} of ${total} jobs. Narrow the filter to compare others.`} />
      )}
      {missingIds.length > 0 && <Alert severity="warning" title={`Couldn't load jobs: ${missingIds.join(', ')}`} />}
      {error && <Alert severity="error" title={error} />}
    </div>
  );
}
