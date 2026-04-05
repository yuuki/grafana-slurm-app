import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { listClusters, listJobs, listLinkableDashboards } from '../../api/slurmApi';
import { ClusterSummary, JobRecord, LinkedDashboardSummary } from '../../api/types';
import { fetchJobsUtilizationBatch, JobUtilization } from './jobMetrics';
import {
  loadLinkedDashboardSelection,
  loadSearchPreferences,
  saveLinkedDashboardSelection,
  saveSearchPreferences,
} from '../../storage/userPreferences';
import { applyFilterValue, buildAutoSearchFilters, buildListJobsParams, filtersFromURLParams, jobKey, JOBS_PAGE_SIZE, MetadataField, getNextClusterId, SearchFilters, syncFiltersToURL } from './model';
import { JobFilters } from './JobFilters';
import { JobTable } from './JobTable';
import { JobTimeline } from './JobTimeline';
import { LinkedDashboardPicker } from './LinkedDashboardPicker';
import {
  buildDashboardDestinationKey,
  buildLinkedDashboardUrl,
  getDashboardUidFromDestinationKey,
  JOB_VIEW_DESTINATION_KEY,
  LINKED_DASHBOARD_TAG,
  LinkedDestinationOption,
  sortLinkedDashboards,
} from './linkedDashboard';
import { navigateToJobPage, navigateToLinkedDashboard } from './navigation';

function getStyles(_theme: GrafanaTheme2) {
  return {
    page: css({
      padding: '0 16px 16px 16px',
    }),
  };
}

export function JobSearchPage() {
  const styles = useStyles2(getStyles);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [filters, setFilters] = useState<SearchFilters>(() => {
    const urlFilters = filtersFromURLParams(new URLSearchParams(window.location.search));
    const hasURLFilters = Object.keys(urlFilters).length > 0;
    return {
      clusterId: '',
      ...(loadSearchPreferences<SearchFilters>() as Partial<SearchFilters>),
      ...(hasURLFilters ? urlFilters : {}),
    };
  });
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
  const requestIdRef = useRef(0);
  const utilizationRequestIdRef = useRef(0);
  const utilChainRef = useRef<Promise<void>>(Promise.resolve());
  const clustersRef = useRef<ClusterSummary[]>([]);
  const fetchJobs = useCallback(async (nextFilters: SearchFilters, options?: { append?: boolean; cursor?: string }) => {
    if (!nextFilters.clusterId) {
      setJobs([]);
      setNextCursor(undefined);
      setTotalJobs(0);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (options?.append) {
      setLoadingMore(true);
    } else {
      setLoadingJobs(true);
      setLoadingMore(false);
      setNextCursor(undefined);
      setTotalJobs(0);
      setUtilizationMap(new Map());
    }
    setError(null);
    try {
      const response = await listJobs(buildListJobsParams(nextFilters, { cursor: options?.cursor }));
      if (requestId !== requestIdRef.current) {
        return;
      }
      setJobs((current) => (options?.append ? [...current, ...response.jobs] : response.jobs));
      setNextCursor(response.nextCursor || undefined);
      setTotalJobs(response.total);
      const cluster = clustersRef.current.find((c) => c.id === nextFilters.clusterId);
      if (cluster) {
        if (!options?.append) {
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
    } catch (e) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      const message = e instanceof Error ? e.message : 'Failed to fetch jobs';
      setError(message);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoadingJobs(false);
        setLoadingMore(false);
      }
    }
  }, []);

  const autoSearchFilters = useMemo(
    () => buildAutoSearchFilters({ clusterId: filters.clusterId }),
    [filters.clusterId]
  );

  useEffect(() => {
    clustersRef.current = clusters;
  }, [clusters]);

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
    if (!loadingClusters && autoSearchFilters.clusterId) {
      fetchJobs(autoSearchFilters);
    }
  }, [autoSearchFilters, fetchJobs, loadingClusters]);

  useEffect(() => {
    saveSearchPreferences(filters);
    syncFiltersToURL(filters);
  }, [filters]);

  useEffect(() => {
    if (!linkedJob) {
      return;
    }

    const savedDashboardUid = preferredLinkedDestinationKey
      ? getDashboardUidFromDestinationKey(preferredLinkedDestinationKey)
      : null;
    const hasSavedDashboard =
      savedDashboardUid !== null && linkedDashboards?.some((dashboard) => dashboard.uid === savedDashboardUid);

    setSelectedDestinationKey(
      preferredLinkedDestinationKey === JOB_VIEW_DESTINATION_KEY || hasSavedDashboard
        ? preferredLinkedDestinationKey ?? JOB_VIEW_DESTINATION_KEY
        : JOB_VIEW_DESTINATION_KEY
    );
  }, [linkedDashboards, linkedJob, preferredLinkedDestinationKey]);

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
      setPreferredLinkedDestinationKey(loadLinkedDashboardSelection(job.clusterId));
      const dashboards = await loadLinkedDashboards();
      if (dashboards?.length === 0) {
        setLinkedJob(null);
        setPreferredLinkedDestinationKey(null);
        setSelectedDestinationKey('');
        openJob(job.clusterId, job.jobId);
      }
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
      void fetchJobs(next);
    },
    [fetchJobs, filters]
  );

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
        onSearch={() => fetchJobs(filters)}
        onOpenJob={openJob}
      />
      {error && <Alert severity="error" title={error} />}
      {loadingClusters ? (
        <LoadingPlaceholder text="Loading clusters..." />
      ) : (
        <>
          <JobTimeline jobs={jobs} loading={loadingJobs} onOpenJob={openLinkedDashboardPicker} />
          <JobTable
            jobs={jobs}
            loading={loadingJobs}
            hasMore={Boolean(nextCursor)}
            loadingMore={loadingMore}
            loadedCount={jobs.length}
            totalCount={totalJobs}
            pageSize={JOBS_PAGE_SIZE}
            utilizationMap={utilizationMap}
            onLoadMore={() => {
              if (!nextCursor) {
                return;
              }
              void fetchJobs(filters, { append: true, cursor: nextCursor });
            }}
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
