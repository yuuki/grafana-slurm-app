import { useCallback, useEffect, useRef, useState } from 'react';
import { ClusterSummary, JobRecord } from '../../api/types';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { jobKey } from '../JobSearch/model';
import { fetchCompareSeries } from './metricQuery';
import { JobSeries } from './seriesTransform';

export interface CompareDataState {
  series: Map<string, JobSeries>;
  failedJobKeys: Set<string>;
  loading: boolean;
  now: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function useCompareData({
  jobs,
  cluster,
  metric,
  metricType,
}: {
  jobs: JobRecord[];
  cluster: ClusterSummary | null;
  metric: string;
  metricType: PrometheusMetricType;
}): CompareDataState & { retry: () => void } {
  const [state, setState] = useState<CompareDataState>(() => ({
    series: new Map(),
    failedJobKeys: new Set(),
    loading: false,
    now: nowSeconds(),
  }));
  const [attempt, setAttempt] = useState(0);
  const jobsRef = useRef(jobs);
  const jobsKey = jobs.map((job) => jobKey(job.clusterId, job.jobId)).join(',');

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    const targetJobs = jobsRef.current;
    if (!cluster || !metric || targetJobs.length === 0) {
      setState((current) => ({ ...current, series: new Map(), failedJobKeys: new Set(), loading: false }));
      return;
    }
    let cancelled = false;
    const now = nowSeconds();
    setState({ series: new Map(), failedJobKeys: new Set(), loading: true, now });
    fetchCompareSeries({ jobs: targetJobs, cluster, metricName: metric, metricType, now })
      .then((result) => {
        if (!cancelled) {
          setState({ series: result.series, failedJobKeys: result.failedJobKeys, loading: false, now });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            series: new Map(),
            failedJobKeys: new Set(targetJobs.map((job) => jobKey(job.clusterId, job.jobId))),
            loading: false,
            now,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cluster, metric, metricType, jobsKey, attempt]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { ...state, retry };
}
