import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppPluginMeta } from '@grafana/data';
import { Alert, LoadingPlaceholder } from '@grafana/ui';
import { listClusters, listJobs } from '../../api/slurmApi';
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildJobRoute } from '../../constants';
import { loadSearchPreferences, saveSearchPreferences } from '../../storage/userPreferences';
import { applyFilterValue, buildAutoSearchFilters, buildListJobsParams, JOBS_PAGE_SIZE, MetadataField, getNextClusterId, SearchFilters } from './model';
import { JobFilters } from './JobFilters';
import { JobTable } from './JobTable';
import { JobTimeline } from './JobTimeline';

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

  const openJob = useCallback((clusterId: string, jobId: number | string) => {
    window.location.assign(buildJobRoute(clusterId, jobId));
  }, []);

  const selectMetadataValue = useCallback(
    (field: MetadataField, value: string) => {
      const next = applyFilterValue(filters, field, value);
      setFilters(next);
      void fetchJobs(next);
    },
    [fetchJobs, filters]
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
          <JobTimeline jobs={jobs} loading={loadingJobs} onOpenJob={openJob} />
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
            onOpenJob={openJob}
          />
        </>
      )}
    </div>
  );
}
