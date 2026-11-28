import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { analyzeJobPhases, JobPhasesOutcome, PhaseAnalysisAborted } from './collect';
import { createDatasourceClient, MetricsClient } from './promClient';
import { resolvePhaseSettings } from './settings';

export type JobPhasesState =
  /** The cluster does not use the feature: nothing is shown and nothing is sent. */
  | { status: 'off' }
  /** The cluster's phase settings are invalid: nothing is sent. */
  | { status: 'invalid'; errors: string[] }
  | { status: 'loading'; queriesSent: number }
  | { status: 'error'; message: string }
  | { status: 'done'; outcome: JobPhasesOutcome };

export interface UseJobPhasesOptions {
  /** For tests: the client to query instead of the cluster's datasource. */
  client?: MetricsClient;
  /** For tests: the current time in seconds. */
  now?: () => number;
}

/**
 * Analyses the phases of a job once per job and cluster, and again on
 * reload(). Leaving the page, or changing the job, stops the queries that
 * were not sent yet and cancels the one under way.
 */
export function useJobPhases(job: JobRecord, cluster: ClusterSummary, options: UseJobPhasesOptions = {}): { state: JobPhasesState; reload: () => void } {
  const resolved = useMemo(() => resolvePhaseSettings(cluster.phases), [cluster.phases]);
  const [state, setState] = useState<JobPhasesState>({ status: 'off' });
  const [generation, setGeneration] = useState(0);
  const { client, now } = options;

  useEffect(() => {
    if (resolved.state === 'off') {
      setState({ status: 'off' });
      return;
    }
    if (resolved.state === 'invalid') {
      setState({ status: 'invalid', errors: resolved.errors });
      return;
    }
    if (!cluster.metricsDatasourceUid && !client) {
      setState({ status: 'error', message: 'The cluster has no metrics datasource.' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading', queriesSent: 0 });
    analyzeJobPhases({
      job,
      cluster,
      settings: resolved.settings,
      client: client ?? createDatasourceClient(cluster.metricsDatasourceUid, controller.signal),
      nowSec: now ? now() : Date.now() / 1000,
      signal: controller.signal,
      onProgress: (queriesSent) => {
        if (!controller.signal.aborted) {
          setState({ status: 'loading', queriesSent });
        }
      },
    })
      .then((outcome) => {
        if (!controller.signal.aborted) {
          setState({ status: 'done', outcome });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || error instanceof PhaseAnalysisAborted) {
          return;
        }
        setState({ status: 'error', message: error instanceof Error ? error.message : 'The analysis failed.' });
      });
    return () => controller.abort();
  }, [client, cluster, generation, job, now, resolved]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { state, reload };
}
