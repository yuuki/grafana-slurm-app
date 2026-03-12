import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppPluginMeta } from '@grafana/data';
import { Alert, LoadingPlaceholder } from '@grafana/ui';
import { listClusters, listJobs, listLinkableDashboards } from '../../api/slurmApi';
import { ClusterSummary, JobRecord, LinkedDashboardSummary } from '../../api/types';
import {
  loadLinkedDashboardSelection,
  loadSearchPreferences,
  saveLinkedDashboardSelection,
  saveSearchPreferences,
} from '../../storage/userPreferences';
import { applyFilterValue, buildAutoSearchFilters, buildListJobsParams, JOBS_PAGE_SIZE, MetadataField, getNextClusterId, SearchFilters } from './model';
import { JobFilters } from './JobFilters';
import { JobTable } from './JobTable';
import { JobTimeline } from './JobTimeline';
import { LinkedDashboardPicker } from './LinkedDashboardPicker';
import { buildLinkedDashboardUrl, LINKED_DASHBOARD_TAG, sortLinkedDashboards } from './linkedDashboard';
import { navigateToJobPage, navigateToLinkedDashboard } from './navigation';

interface Props {
  meta: AppPluginMeta;
}

export function JobSearchPage({ meta: _meta }: Props) {
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [filters, setFilters] = useState<SearchFilters>(() => ({
    clusterId: '',
    ...(loadSearchPreferences<SearchFilters>() as Partial<SearchFilters>),
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
  const [preferredLinkedDashboardUid, setPreferredLinkedDashboardUid] = useState<string | null>(null);
  const [selectedLinkedDashboardUid, setSelectedLinkedDashboardUid] = useState('');
  const requestIdRef = useRef(0);
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
  }, [filters]);

  useEffect(() => {
    if (!linkedJob) {
      return;
    }

    const savedUid =
      preferredLinkedDashboardUid && linkedDashboards?.some((dashboard) => dashboard.uid === preferredLinkedDashboardUid)
        ? preferredLinkedDashboardUid
        : null;

    setSelectedLinkedDashboardUid(savedUid ?? linkedDashboards?.[0]?.uid ?? '');
  }, [linkedDashboards, linkedJob, preferredLinkedDashboardUid]);

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
      setPreferredLinkedDashboardUid(loadLinkedDashboardSelection(job.clusterId));
      const dashboards = await loadLinkedDashboards();
      if (dashboards?.length === 0) {
        setLinkedJob(null);
        setPreferredLinkedDashboardUid(null);
        setSelectedLinkedDashboardUid('');
        openJob(job.clusterId, job.jobId);
      }
    },
    [linkedDashboards, loadLinkedDashboards, openJob]
  );

  const closeLinkedDashboardPicker = useCallback(() => {
    setLinkedJob(null);
    setPreferredLinkedDashboardUid(null);
    setLinkedDashboardsError(null);
    setSelectedLinkedDashboardUid('');
  }, []);

  const confirmLinkedDashboard = useCallback(() => {
    if (!linkedJob) {
      return;
    }

    const linkedDashboard = linkedDashboards?.find((dashboard) => dashboard.uid === selectedLinkedDashboardUid);
    if (!linkedDashboard) {
      return;
    }

    saveLinkedDashboardSelection(linkedJob.clusterId, linkedDashboard.uid);
    setPreferredLinkedDashboardUid(linkedDashboard.uid);
    navigateToLinkedDashboard(buildLinkedDashboardUrl(linkedDashboard.url, linkedJob));
  }, [linkedDashboards, linkedJob, selectedLinkedDashboardUid]);

  const selectMetadataValue = useCallback(
    (field: MetadataField, value: string) => {
      const next = applyFilterValue(filters, field, value);
      setFilters(next);
      void fetchJobs(next);
    },
    [fetchJobs, filters]
  );

  const orderedLinkedDashboards = useMemo(
    () => sortLinkedDashboards(linkedDashboards ?? [], preferredLinkedDashboardUid),
    [linkedDashboards, preferredLinkedDashboardUid]
  );

  return (
    <div>
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
        dashboards={orderedLinkedDashboards}
        loading={loadingLinkedDashboards}
        error={linkedDashboardsError}
        selectedDashboardUid={selectedLinkedDashboardUid}
        onSelectDashboard={setSelectedLinkedDashboardUid}
        onClose={closeLinkedDashboardPicker}
        onConfirm={confirmLinkedDashboard}
        onRefresh={() => loadLinkedDashboards({ force: true })}
      />
    </div>
  );
}
