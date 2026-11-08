import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Alert, Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { listClusters, listJobs, listLinkableDashboards } from '../../api/slurmApi';
import { ClusterSummary, JobRecord, LinkedDashboardSummary } from '../../api/types';
import { fetchJobsUtilizationBatch, JobUtilization } from './jobMetrics';
import {
  loadLinkedDashboardSelection,
  loadSearchPreferences,
  saveLinkedDashboardSelection,
  saveSearchPreferences,
} from '../../storage/userPreferences';
import {
  applyFilterValue,
  buildListJobsParams,
  filtersFromURLParams,
  jobKey,
  JOBS_PAGE_SIZE,
  mergeJobPages,
  MetadataField,
  getNextClusterId,
  SearchFilters,
  syncFiltersToURL,
} from './model';
import { JobFilters } from './JobFilters';
import { JobTable } from './JobTable';
import { JobTimeline } from './JobTimeline';
import { LinkedDashboardPicker } from './LinkedDashboardPicker';
import {
  loadInitialTimelineTimeRange,
  ResolvedTimelineRange,
  resolveTimelineRange,
  timelineRangeToRawValues,
} from './timelineRange';
import {
  buildDashboardDestinationKey,
  buildLinkedDashboardUrl,
  getDashboardUidFromDestinationKey,
  JOB_VIEW_DESTINATION_KEY,
  LINKED_DASHBOARD_TAG,
  LinkedDestinationOption,
  resolveInitialDestinationKey,
  sortLinkedDashboards,
} from './linkedDashboard';
import { buildCompareFromSearchParams, COMPARE_JOB_LIMIT } from '../JobCompare/model';
import { navigateToComparePage, navigateToJobPage, navigateToLinkedDashboard } from './navigation';

function getStyles(_theme: GrafanaTheme2) {
  return {
    page: css({
      padding: '0 16px 16px 16px',
    }),
    compareBar: css({
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      margin: '8px 0',
    }),
  };
}

/**
 * A job search as submitted: the filters and the absolute time range that
 * produced the first page. "Show more" repeats it with the next cursor, so
 * neither a filter edited since nor a relative range such as now-24h moving
 * on can change the query a cursor continues.
 */
interface JobsRequest {
  filters: SearchFilters;
  timeRange: ResolvedTimelineRange;
}

interface NextJobsPage {
  request: JobsRequest;
  cursor: string;
}

export function JobSearchPage() {
  const styles = useStyles2(getStyles);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [filters, setFilters] = useState<SearchFilters>(() => ({
    clusterId: '',
    ...(loadSearchPreferences<SearchFilters>() as Partial<SearchFilters>),
    ...filtersFromURLParams(new URLSearchParams(window.location.search)),
  }));
  const [loadingClusters, setLoadingClusters] = useState(true);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [totalJobs, setTotalJobs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [linkedDashboards, setLinkedDashboards] = useState<LinkedDashboardSummary[] | null>(null);
  const [loadingLinkedDashboards, setLoadingLinkedDashboards] = useState(false);
  const [linkedDashboardsError, setLinkedDashboardsError] = useState<string | null>(null);
  const [linkedJob, setLinkedJob] = useState<JobRecord | null>(null);
  const [preferredLinkedDestinationKey, setPreferredLinkedDestinationKey] = useState<string | null>(null);
  const [selectedDestinationKey, setSelectedDestinationKey] = useState('');
  const [utilizationMap, setUtilizationMap] = useState<Map<string, JobUtilization>>(() => new Map());
  const [selectedJobKeys, setSelectedJobKeys] = useState<Set<string>>(() => new Set());
  const [timelineTimeRange, setTimelineTimeRange] = useState<TimeRange>(() => loadInitialTimelineTimeRange());
  const timelineTimeRangeRef = useRef(timelineTimeRange);
  const requestIdRef = useRef(0);
  const loadMoreCursorRef = useRef<string | undefined>();
  const nextPageRef = useRef<NextJobsPage | null>(null);
  const utilizationRequestIdRef = useRef(0);
  const utilChainRef = useRef<Promise<void>>(Promise.resolve());
  const clustersRef = useRef<ClusterSummary[]>([]);
  const initialSearchDoneRef = useRef(false);
  // fetchJobs loads the first page of request, or with a cursor the page
  // after the loaded ones.
  const fetchJobs = useCallback(async (request: JobsRequest, cursor?: string) => {
    const append = cursor !== undefined;
    if (!request.filters.clusterId) {
      nextPageRef.current = null;
      setJobs([]);
      setNextCursor(undefined);
      setTotalJobs(0);
      return true;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (append) {
      setLoadingMore(true);
    } else {
      nextPageRef.current = null;
      setLoadingJobs(true);
      setLoadingMore(false);
      setNextCursor(undefined);
      setTotalJobs(0);
      setUtilizationMap(new Map());
      setSelectedJobKeys(new Set());
    }
    setError(null);
    try {
      const response = await listJobs(buildListJobsParams(request.filters, { cursor, timeRange: request.timeRange }));
      if (requestId !== requestIdRef.current) {
        return false;
      }
      nextPageRef.current = response.nextCursor ? { request, cursor: response.nextCursor } : null;
      setJobs((current) => mergeJobPages(append ? current : [], response.jobs));
      setNextCursor(response.nextCursor || undefined);
      setTotalJobs(response.total);
      const cluster = clustersRef.current.find((c) => c.id === request.filters.clusterId);
      if (cluster) {
        if (!append) {
          utilizationRequestIdRef.current++;
          utilChainRef.current = Promise.resolve();
        }
        const utilId = utilizationRequestIdRef.current;
        const batchJobs = response.jobs;
        // Serialize utilization fetches so Prometheus queries don't overlap,
        // preventing Grafana proxy overload on rapid "Show more" clicks.
        utilChainRef.current = utilChainRef.current
          .then(async () => {
            if (utilId !== utilizationRequestIdRef.current) {
              return;
            }
            const batchResult = await fetchJobsUtilizationBatch(batchJobs, cluster);
            if (utilId !== utilizationRequestIdRef.current) {
              return;
            }
            setUtilizationMap((current) => {
              const next = new Map(current);
              for (const job of batchJobs) {
                const k = jobKey(job.clusterId, job.jobId);
                next.set(k, batchResult.get(k) ?? { cpuPercent: undefined, gpuPercent: undefined });
              }
              return next;
            });
          })
          .catch(() => {});
      }
      return true;
    } catch (e) {
      if (requestId !== requestIdRef.current) {
        return false;
      }
      const message = e instanceof Error ? e.message : 'Failed to fetch jobs';
      setError(message);
      if (!append) {
        setJobs([]);
        setNextCursor(undefined);
        setTotalJobs(0);
      }
      return false;
    } finally {
      if (requestId === requestIdRef.current) {
        setLoadingJobs(false);
        setLoadingMore(false);
      }
    }
  }, []);

  // searchJobs starts a new search: it resolves the time range once and
  // freezes it with the submitted filters for every later "Show more".
  const searchJobs = useCallback(
    (nextFilters: SearchFilters, timeRange?: TimeRange) =>
      fetchJobs({
        filters: { ...nextFilters },
        timeRange: resolveTimelineRange(timeRange ?? timelineTimeRangeRef.current),
      }),
    [fetchJobs]
  );

  useEffect(() => {
    clustersRef.current = clusters;
  }, [clusters]);

  useEffect(() => {
    timelineTimeRangeRef.current = timelineTimeRange;
  }, [timelineTimeRange]);

  useEffect(() => {
    loadMoreCursorRef.current = undefined;
  }, [nextCursor]);

  useEffect(() => {
    let cancelled = false;
    setLoadingClusters(true);
    listClusters()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setClusters(response.clusters);
        setFilters((current) => {
          const nextClusterId = getNextClusterId(response.clusters, current.clusterId);
          return nextClusterId === current.clusterId ? current : { ...current, clusterId: nextClusterId };
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load clusters');
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
    if (loadingClusters || initialSearchDoneRef.current || !filters.clusterId) {
      return;
    }
    initialSearchDoneRef.current = true;
    void searchJobs(filters, timelineTimeRangeRef.current);
  }, [searchJobs, filters, loadingClusters]);

  useEffect(() => {
    saveSearchPreferences(filters);
    syncFiltersToURL(filters, timelineRangeToRawValues(timelineTimeRange));
  }, [filters, timelineTimeRange]);

  const openJob = useCallback((clusterId: string, jobId: number | string) => {
    navigateToJobPage(clusterId, jobId);
  }, []);

  const loadLinkedDashboards = useCallback(async (options?: { force?: boolean }) => {
    if ((!options?.force && linkedDashboards !== null) || loadingLinkedDashboards) {
      return linkedDashboards;
    }

    setLoadingLinkedDashboards(true);
    setLinkedDashboardsError(null);
    try {
      const dashboards = await listLinkableDashboards(LINKED_DASHBOARD_TAG);
      setLinkedDashboards(dashboards);
      return dashboards;
    } catch (e) {
      setLinkedDashboardsError(e instanceof Error ? e.message : 'Failed to load linked dashboards');
      return null;
    } finally {
      setLoadingLinkedDashboards(false);
    }
  }, [linkedDashboards, loadingLinkedDashboards]);

  const openLinkedDashboardPicker = useCallback(
    async (job: JobRecord) => {
      if (linkedDashboards?.length === 0) {
        openJob(job.clusterId, job.jobId);
        return;
      }

      setLinkedJob(job);
      const preferred = loadLinkedDashboardSelection(job.clusterId);
      setPreferredLinkedDestinationKey(preferred);
      const dashboards = await loadLinkedDashboards();
      if (dashboards?.length === 0) {
        setLinkedJob(null);
        setPreferredLinkedDestinationKey(null);
        setSelectedDestinationKey('');
        openJob(job.clusterId, job.jobId);
        return;
      }
      // Initialize the selection once, in the same commit as the loaded dashboards,
      // so a late reactive effect can never clobber a user's radio selection.
      setSelectedDestinationKey(resolveInitialDestinationKey(preferred, dashboards ?? []));
    },
    [linkedDashboards, loadLinkedDashboards, openJob]
  );

  const closeLinkedDashboardPicker = useCallback(() => {
    setLinkedJob(null);
    setPreferredLinkedDestinationKey(null);
    setLinkedDashboardsError(null);
    setSelectedDestinationKey('');
  }, []);

  const confirmLinkedDashboard = useCallback(() => {
    if (!linkedJob) {
      return;
    }

    if (selectedDestinationKey === JOB_VIEW_DESTINATION_KEY) {
      saveLinkedDashboardSelection(linkedJob.clusterId, JOB_VIEW_DESTINATION_KEY);
      setPreferredLinkedDestinationKey(JOB_VIEW_DESTINATION_KEY);
      navigateToJobPage(linkedJob.clusterId, linkedJob.jobId);
      return;
    }

    const linkedDashboardUid = getDashboardUidFromDestinationKey(selectedDestinationKey);
    const linkedDashboard = linkedDashboards?.find((dashboard) => dashboard.uid === linkedDashboardUid);
    if (!linkedDashboard || linkedDashboardUid === null) {
      return;
    }

    const destinationKey = buildDashboardDestinationKey(linkedDashboard.uid);
    saveLinkedDashboardSelection(linkedJob.clusterId, destinationKey);
    setPreferredLinkedDestinationKey(destinationKey);
    navigateToLinkedDashboard(buildLinkedDashboardUrl(linkedDashboard.url, linkedJob));
  }, [linkedDashboards, linkedJob, selectedDestinationKey]);

  const selectMetadataValue = useCallback(
    (field: MetadataField, value: string) => {
      const next = applyFilterValue(filters, field, value);
      setFilters(next);
      void searchJobs(next, timelineTimeRange);
    },
    [searchJobs, filters, timelineTimeRange]
  );

  const updateTimelineTimeRange = useCallback((range: TimeRange) => {
    timelineTimeRangeRef.current = range;
    setTimelineTimeRange(range);
    void searchJobs(filters, range);
  }, [searchJobs, filters]);

  const loadMoreJobs = useCallback(() => {
    const nextPage = nextPageRef.current;
    if (!nextPage || loadingMore || loadMoreCursorRef.current === nextPage.cursor) {
      return;
    }
    const { cursor } = nextPage;
    loadMoreCursorRef.current = cursor;
    void fetchJobs(nextPage.request, cursor).then((loaded) => {
      if (!loaded && loadMoreCursorRef.current === cursor) {
        loadMoreCursorRef.current = undefined;
      }
    });
  }, [fetchJobs, loadingMore]);

  const toggleJobSelected = useCallback((job: JobRecord) => {
    setSelectedJobKeys((current) => {
      const next = new Set(current);
      const key = jobKey(job.clusterId, job.jobId);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const openCompare = useCallback(() => {
    if (selectedJobKeys.size > COMPARE_JOB_LIMIT) {
      return;
    }
    const selectedIds = jobs
      .filter((job) => selectedJobKeys.has(jobKey(job.clusterId, job.jobId)))
      .map((job) => String(job.jobId));
    navigateToComparePage(buildCompareFromSearchParams(filters, timelineRangeToRawValues(timelineTimeRange), selectedIds));
  }, [filters, jobs, selectedJobKeys, timelineTimeRange]);

  const orderedLinkedDashboards = useMemo(
    () =>
      sortLinkedDashboards(
        linkedDashboards ?? [],
        preferredLinkedDestinationKey ? getDashboardUidFromDestinationKey(preferredLinkedDestinationKey) : null
      ),
    [linkedDashboards, preferredLinkedDestinationKey]
  );

  const linkedDestinationOptions = useMemo<LinkedDestinationOption[]>(
    () => [
      {
        key: JOB_VIEW_DESTINATION_KEY,
        title: 'Job view',
        description: 'Open the built-in job view for this job.',
      },
      ...orderedLinkedDashboards.map((dashboard) => ({
        key: buildDashboardDestinationKey(dashboard.uid),
        title: dashboard.title,
        description: dashboard.url,
      })),
    ],
    [orderedLinkedDashboards]
  );

  return (
    <div className={styles.page}>
      <JobFilters
        clusters={clusters}
        filters={filters}
        loadingClusters={loadingClusters}
        onChange={setFilters}
        onSelectMetadata={selectMetadataValue}
        onSearch={() => searchJobs(filters)}
        onOpenJob={openJob}
      />
      {error && <Alert severity="error" title={error} />}
      {loadingClusters ? (
        <LoadingPlaceholder text="Loading clusters..." />
      ) : (
        <>
          <JobTimeline
            jobs={jobs}
            loading={loadingJobs}
            hasMore={Boolean(nextCursor)}
            loadingMore={loadingMore}
            loadedCount={jobs.length}
            totalCount={totalJobs}
            onLoadMore={loadMoreJobs}
            timeRange={timelineTimeRange}
            onTimeRangeChange={updateTimelineTimeRange}
            onOpenJob={openLinkedDashboardPicker}
          />
          <div className={styles.compareBar}>
            <Button size="sm" variant="secondary" icon="chart-line" onClick={openCompare}>
              {selectedJobKeys.size > 0 ? `Compare metric (${selectedJobKeys.size})` : 'Compare metric'}
            </Button>
            {selectedJobKeys.size > COMPARE_JOB_LIMIT && (
              <span role="alert">{`Select up to ${COMPARE_JOB_LIMIT} jobs to compare.`}</span>
            )}
          </div>
          <JobTable
            jobs={jobs}
            loading={loadingJobs}
            hasMore={Boolean(nextCursor)}
            loadingMore={loadingMore}
            loadedCount={jobs.length}
            totalCount={totalJobs}
            pageSize={JOBS_PAGE_SIZE}
            utilizationMap={utilizationMap}
            selectedKeys={selectedJobKeys}
            onToggleSelect={toggleJobSelected}
            onLoadMore={loadMoreJobs}
            onOpenJob={openLinkedDashboardPicker}
          />
        </>
      )}
      <LinkedDashboardPicker
        job={linkedJob}
        options={linkedDestinationOptions}
        loading={loadingLinkedDashboards}
        error={linkedDashboardsError}
        selectedDestinationKey={selectedDestinationKey}
        onSelectDestination={setSelectedDestinationKey}
        onClose={closeLinkedDashboardPicker}
        onConfirm={confirmLinkedDashboard}
        onRefresh={() => loadLinkedDashboards({ force: true })}
      />
    </div>
  );
}
