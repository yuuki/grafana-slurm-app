import { useCallback, useEffect, useState } from 'react';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { createDatasourceClient } from './promClient';
import { computeJobEfficiency, JobEfficiency } from './scorecard';

export type EfficiencyState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: JobEfficiency };

/**
 * Scores the job once per job and cluster. A running job is not re-scored
 * on a timer (each scorecard costs up to seven queries); reload() scores it
 * again on demand.
 */
export function useJobEfficiency(job: JobRecord | null, cluster: ClusterSummary | null): { state: EfficiencyState; reload: () => void } {
  const [state, setState] = useState<EfficiencyState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!job || !cluster) {
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    computeJobEfficiency({
      job,
      cluster,
      nowSeconds: Math.floor(Date.now() / 1000),
      client: createDatasourceClient(cluster.metricsDatasourceUid),
    })
      .then((result) => {
        if (!cancelled) {
          setState({ status: 'done', result });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to score job efficiency' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [job, cluster, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);
  return { state, reload };
}
