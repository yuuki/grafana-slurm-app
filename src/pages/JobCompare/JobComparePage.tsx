import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Alert, Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { getJob, listClusters } from '../../api/slurmApi';
import { ClusterSummary, JobRecord } from '../../api/types';
import { PLUGIN_ID } from '../../constants';
import { loadCompareViewPreferences, saveCompareViewPreferences } from '../../storage/userPreferences';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { getNextClusterId, SearchFilters } from '../JobSearch/model';
import { navigateToJobPage } from '../JobSearch/navigation';
import { resolveTimelineRange, timelineRangeToRawValues } from '../JobSearch/timelineRange';
import { CompareGrid } from './CompareGrid';
import { CompareOverlay } from './CompareOverlay';
import { CompareToolbar } from './CompareToolbar';
import { buildCompareView, CompareCellModel } from './compareView';
import { JobDetailModal } from './JobDetailModal';
import { finalizeJobSet, loadCompareTimeRange, loadFilterJobSet, loadPickedJobs } from './jobSet';
import { JobSetBar } from './JobSetBar';
import { fetchMetricTypes, listMetricNames, resolveMetricType } from './metricCatalog';
import { MetricPicker } from './MetricPicker';
import {
  buildCompareURLParams,
  CompareViewState,
  DEFAULT_VIEW_STATE,
  filtersFromCompareURLParams,
  toggleJobSelection,
  viewStateFromURLParams,
} from './model';
import { useCompareData } from './useCompareData';

interface JobSetState {
  jobs: JobRecord[];
  total: number;
  missingIds: string[];
  loading: boolean;
  error: string | null;
}

interface AppliedQuery {
  filters: SearchFilters;
  timeRange: TimeRange;
}

const EMPTY_JOB_SET: JobSetState = { jobs: [], total: 0, missingIds: [], loading: false, error: null };

function getStyles(theme: GrafanaTheme2) {
  return {
    page: css({ padding: theme.spacing(0, 2, 2, 2) }),
    empty: css({ padding: theme.spacing(4), textAlign: 'center', color: theme.colors.text.secondary }),
  };
}

export function JobComparePage() {
  const styles = useStyles2(getStyles);
  const [initialParams] = useState(() => new URLSearchParams(window.location.search));
  const [view, setView] = useState<CompareViewState>(() => ({
    ...DEFAULT_VIEW_STATE,
    ...loadCompareViewPreferences(),
    ...viewStateFromURLParams(initialParams),
  }));
  const [filters, setFilters] = useState<SearchFilters>(() => ({
    clusterId: '',
    ...filtersFromCompareURLParams(initialParams),
  }));
  const [timeRange, setTimeRange] = useState<TimeRange>(() => loadCompareTimeRange(initialParams));
  const [applied, setApplied] = useState<AppliedQuery>(() => ({ filters, timeRange }));
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [loadingClusters, setLoadingClusters] = useState(true);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [jobSet, setJobSet] = useState<JobSetState>(EMPTY_JOB_SET);
  const [baselineJob, setBaselineJob] = useState<JobRecord | null>(null);
  const [metricNames, setMetricNames] = useState<string[]>([]);
  const [metricTypes, setMetricTypes] = useState<Map<string, PrometheusMetricType>>(() => new Map());
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [detailCell, setDetailCell] = useState<CompareCellModel | null>(null);

  const cluster = clusters.find((c) => c.id === applied.filters.clusterId) ?? null;
  const patchView = useCallback((patch: Partial<CompareViewState>) => setView((current) => ({ ...current, ...patch })), []);

  useEffect(() => {
    let cancelled = false;
    listClusters()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setClusters(response.clusters);
        const resolve = (current: SearchFilters) => {
          const clusterId = getNextClusterId(response.clusters, current.clusterId);
          return clusterId === current.clusterId ? current : { ...current, clusterId };
        };
        setFilters(resolve);
        setApplied((current) => ({ ...current, filters: resolve(current.filters) }));
      })
      .catch((e) => {
        if (!cancelled) {
          setClusterError(e instanceof Error ? e.message : 'Failed to load clusters');
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

  const pickedKey = view.pickedJobIds.join(',');
  useEffect(() => {
    if (loadingClusters || !applied.filters.clusterId) {
      return;
    }
    let cancelled = false;
    setJobSet((current) => ({ ...current, loading: true, error: null }));
    const pickedIds = pickedKey ? pickedKey.split(',') : [];
    const load =
      view.jobSetMode === 'pick'
        ? loadPickedJobs(applied.filters.clusterId, pickedIds).then((r) => ({ jobs: r.jobs, total: r.jobs.length, missingIds: r.missingIds }))
        : loadFilterJobSet(applied.filters, resolveTimelineRange(applied.timeRange)).then((r) => ({ ...r, missingIds: [] }));
    load
      .then((result) => {
        if (!cancelled) {
          setJobSet({ ...result, loading: false, error: null });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setJobSet({ ...EMPTY_JOB_SET, error: e instanceof Error ? e.message : 'Failed to load jobs' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applied, loadingClusters, view.jobSetMode, pickedKey]);

  useEffect(() => {
    const id = view.baselineJobId;
    const clusterId = applied.filters.clusterId;
    if (!id || !clusterId) {
      setBaselineJob(null);
      return;
    }
    const inSet = jobSet.jobs.find((job) => String(job.jobId) === id);
    if (inSet) {
      setBaselineJob(inSet);
      return;
    }
    let cancelled = false;
    getJob(clusterId, id)
      .then((job) => !cancelled && setBaselineJob(job))
      .catch(() => !cancelled && setBaselineJob(null));
    return () => {
      cancelled = true;
    };
  }, [view.baselineJobId, applied.filters.clusterId, jobSet.jobs]);

  useEffect(() => {
    if (!cluster) {
      return;
    }
    let cancelled = false;
    setLoadingMetrics(true);
    Promise.all([
      listMetricNames(cluster, resolveTimelineRange(applied.timeRange)).catch(() => [] as string[]),
      fetchMetricTypes(cluster),
    ])
      .then(([names, types]) => {
        if (!cancelled) {
          setMetricNames(names);
          setMetricTypes(types);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingMetrics(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cluster, applied.timeRange]);

  useEffect(() => {
    const params = buildCompareURLParams(view, applied.filters, timelineRangeToRawValues(applied.timeRange));
    const url = `${window.location.pathname}?${params.toString()}`;
    if (url !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, '', url);
    }
    saveCompareViewPreferences(view);
  }, [view, applied]);

  const metricType = view.metric ? resolveMetricType(view.metric, metricTypes) : 'unknown';
  const displayed = useMemo(
    () => finalizeJobSet(jobSet.jobs, { metric: view.metric, baseline: baselineJob }),
    [jobSet.jobs, view.metric, baselineJob]
  );
  // Wait for metadata so a counter is not first queried as a gauge.
  const data = useCompareData({
    jobs: displayed.jobs,
    cluster,
    metric: loadingMetrics ? '' : view.metric,
    metricType,
  });
  const model = useMemo(
    () =>
      buildCompareView({
        jobs: displayed.jobs,
        series: data.series,
        failedJobKeys: data.failedJobKeys,
        loading: data.loading || loadingMetrics,
        view,
        now: data.now,
      }),
    [displayed.jobs, data.series, data.failedJobKeys, data.loading, data.now, loadingMetrics, view]
  );

  const applyFilter = useCallback(
    (next?: SearchFilters) => {
      const nextFilters = next ?? filters;
      setFilters(nextFilters);
      setApplied({ filters: nextFilters, timeRange });
      patchView({ jobSetMode: 'filter', pickedJobIds: [], selectedJobIds: [] });
    },
    [filters, timeRange, patchView]
  );

  const changeTimeRange = useCallback(
    (range: TimeRange) => {
      setTimeRange(range);
      setApplied((current) => ({ ...current, timeRange: range }));
    },
    []
  );

  const cellActions = {
    onOpen: (cell: CompareCellModel) => setDetailCell(cell),
    onToggleSelect: (cell: CompareCellModel) =>
      setView((current) => ({ ...current, selectedJobIds: toggleJobSelection(current.selectedJobIds, String(cell.job.jobId)) })),
    onSetBaseline: (cell: CompareCellModel) => patchView({ baselineJobId: cell.isBaseline ? '' : String(cell.job.jobId) }),
    onOpenDashboard: (cell: CompareCellModel) => navigateToJobPage(cell.job.clusterId, cell.job.jobId),
  };

  const failedCount = model.cells.filter((cell) => cell.status === 'error').length;

  const renderBody = () => {
    if (cluster && !cluster.metricsDatasourceUid) {
      return (
        <Alert severity="info" title="This cluster has no metrics datasource">
          Set a Prometheus or VictoriaMetrics datasource for this cluster in the{' '}
          <a href={`/plugins/${PLUGIN_ID}`}>plugin configuration</a>.
        </Alert>
      );
    }
    if (!view.metric) {
      return (
        <div className={styles.empty}>
          <h3>Pick a metric to compare</h3>
          <p>Choose a metric above to draw one series per job.</p>
        </div>
      );
    }
    if (jobSet.loading && displayed.jobs.length === 0) {
      return <LoadingPlaceholder text="Loading jobs..." />;
    }
    if (displayed.jobs.length === 0) {
      return <div className={styles.empty}>No jobs match this filter.</div>;
    }
    return (
      <>
        {failedCount > 0 && (
          <Alert severity="warning" title={`${failedCount} of ${displayed.jobs.length} jobs failed to load`}>
            <Button size="sm" variant="secondary" onClick={data.retry}>
              Retry
            </Button>
          </Alert>
        )}
        {view.layout === 'overlay' ? (
          <CompareOverlay model={model} state={view} />
        ) : (
          <CompareGrid model={model} state={view} {...cellActions} />
        )}
      </>
    );
  };

  return (
    <div className={styles.page}>
      {clusterError && <Alert severity="error" title={clusterError} />}
      {loadingClusters ? (
        <LoadingPlaceholder text="Loading clusters..." />
      ) : (
        <>
          <MetricPicker
            names={metricNames}
            loading={loadingMetrics}
            value={view.metric}
            metricType={view.metric ? metricType : null}
            onChange={(metric) => patchView({ metric, selectedJobIds: [] })}
          />
          <JobSetBar
            clusters={clusters}
            loadingClusters={loadingClusters}
            mode={view.jobSetMode}
            filters={filters}
            appliedFilters={applied.filters}
            timeRange={timeRange}
            loading={jobSet.loading}
            error={jobSet.error}
            shownCount={displayed.jobs.length}
            total={jobSet.total}
            hiddenNonGpu={displayed.hiddenNonGpu}
            missingIds={jobSet.missingIds}
            baseline={baselineJob}
            onFiltersChange={setFilters}
            onApplyFilter={applyFilter}
            onTimeRangeChange={changeTimeRange}
            onSwitchToFilter={() => applyFilter()}
            onClearBaseline={() => patchView({ baselineJobId: '' })}
          />
          <CompareToolbar
            state={view}
            onChange={patchView}
            selectedCount={view.selectedJobIds.length}
            onOverlaySelected={() => patchView({ layout: 'overlay' })}
            onClearSelection={() => patchView({ selectedJobIds: [] })}
          />
          {renderBody()}
        </>
      )}
      {detailCell && cluster && (
        <JobDetailModal
          job={detailCell.job}
          cluster={cluster}
          metricName={view.metric}
          metricType={metricType}
          onDismiss={() => setDetailCell(null)}
        />
      )}
    </div>
  );
}
