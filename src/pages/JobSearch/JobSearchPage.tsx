import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppPluginMeta } from '@grafana/data';
import { Alert, Button, LoadingPlaceholder } from '@grafana/ui';
import { listClusters, listJobs } from '../../api/slurmApi';
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildJobRoute } from '../../constants';
import { loadRecentJobs, loadSearchPreferences, saveSearchPreferences } from '../../storage/userPreferences';
import { applyFilterValue, buildAutoSearchFilters, buildListJobsParams, MetadataField, getNextClusterId, SearchFilters } from './model';
import { JobFilters } from './JobFilters';
import { JobTable } from './JobTable';

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
  const [error, setError] = useState<string | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobRecord[]>(() => loadRecentJobs());

  const fetchJobs = useCallback(async (nextFilters: SearchFilters) => {
    if (!nextFilters.clusterId) {
      setJobs([]);
      return;
    }
    setLoadingJobs(true);
    setError(null);
    try {
      const response = await listJobs(buildListJobsParams(nextFilters));
      setJobs(response.jobs);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to fetch jobs';
      setError(message);
    } finally {
      setLoadingJobs(false);
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
          setRecentJobs(loadRecentJobs());
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
      setFilters((current) => {
        const next = applyFilterValue(current, field, value);
        void fetchJobs(next);
        return next;
      });
    },
    [fetchJobs]
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
      {recentJobs.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Recent Jobs</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {recentJobs.map((job) => (
              <Button key={`${job.clusterId}-${job.jobId}`} variant="secondary" size="sm" onClick={() => openJob(job.clusterId, job.jobId)}>
                {job.clusterId}/{job.jobId} {job.name}
              </Button>
            ))}
          </div>
        </div>
      )}
      {loadingClusters ? <LoadingPlaceholder text="Loading clusters..." /> : <JobTable jobs={jobs} loading={loadingJobs} onOpenJob={openJob} />}
    </div>
  );
}
