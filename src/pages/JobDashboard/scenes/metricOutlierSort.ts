import type { AutoFilterMetricSeries, ClusterSummary, JobRecord } from '../../../api/types';
import type { MetricExplorerEntry } from './metricDiscovery';

export interface MetricOutlierScore {
  intervalCount: number;
  outlyingSeriesCount: number;
}

interface OutlierInterval {
  start: number;
  end: number | undefined;
}

interface OutlierSeriesResult {
  isOutlier: boolean;
  outlierIntervals: OutlierInterval[];
  scores: number[];
}

interface OutlierOutputLike {
  outlyingSeries: number[];
  seriesResults: OutlierSeriesResult[];
  clusterBand: unknown;
}

export interface OutlierDetectorLike {
  detect(values: Float64Array[]): OutlierOutputLike;
}

export function normalizeOutlierValues(values: Array<number | null>): number[] | null {
  const normalized = values.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : null));
  const firstFiniteValue = normalized.find((value): value is number => value !== null);
  if (firstFiniteValue === undefined) {
    return null;
  }

  let lastValue = firstFiniteValue;
  return normalized.map((value) => {
    if (value === null) {
      return lastValue;
    }
    lastValue = value;
    return value;
  });
}

function emptyScore(): MetricOutlierScore {
  return {
    intervalCount: 0,
    outlyingSeriesCount: 0,
  };
}

export function computeMetricOutlierScores(
  series: Array<Pick<AutoFilterMetricSeries, 'metricKey' | 'values'>>,
  detector: OutlierDetectorLike
): Map<string, MetricOutlierScore> {
  const groupedSeries = new Map<string, Float64Array[]>();
  const scores = new Map<string, MetricOutlierScore>();
  let eligibleGroupCount = 0;
  let failedGroupCount = 0;

  for (const item of series) {
    scores.set(item.metricKey, emptyScore());
    const values = normalizeOutlierValues(item.values);
    if (!values) {
      continue;
    }

    const current = groupedSeries.get(item.metricKey) ?? [];
    current.push(new Float64Array(values));
    groupedSeries.set(item.metricKey, current);
  }

  for (const [metricKey, values] of groupedSeries) {
    if (values.length < 3) {
      continue;
    }
    eligibleGroupCount++;

    let outliers: OutlierOutputLike;
    try {
      outliers = detector.detect(values);
    } catch {
      failedGroupCount++;
      continue;
    }
    const intervalCount = outliers.seriesResults.reduce(
      (total, result) => total + (result.isOutlier ? result.outlierIntervals.length : 0),
      0
    );

    scores.set(metricKey, {
      intervalCount,
      outlyingSeriesCount: outliers.outlyingSeries.length,
    });
  }

  if (eligibleGroupCount > 0 && failedGroupCount === eligibleGroupCount) {
    throw new Error('Failed to detect outliers for all eligible metric groups.');
  }

  return scores;
}

export function compareMetricOutlierScores(
  left: MetricOutlierScore | undefined,
  right: MetricOutlierScore | undefined
): number {
  const leftScore = left ?? emptyScore();
  const rightScore = right ?? emptyScore();
  if (leftScore.intervalCount !== rightScore.intervalCount) {
    return rightScore.intervalCount - leftScore.intervalCount;
  }
  return rightScore.outlyingSeriesCount - leftScore.outlyingSeriesCount;
}

let dbscanOutlierDetectorPromise: Promise<OutlierDetectorLike> | undefined;

async function createDbscanOutlierDetector(): Promise<OutlierDetectorLike> {
  if (dbscanOutlierDetectorPromise) {
    return dbscanOutlierDetectorPromise;
  }

  dbscanOutlierDetectorPromise = (async () => {
    if (typeof WebAssembly !== 'object') {
      throw new Error('WASM is not supported by this browser.');
    }

    const outlierModule = await import('@bsull/augurs/outlier');
    await outlierModule.default();
    return outlierModule.OutlierDetector.dbscan({ sensitivity: 0.9 });
  })().catch((error) => {
    dbscanOutlierDetectorPromise = undefined;
    throw error;
  });

  return dbscanOutlierDetectorPromise;
}

export async function collectMetricOutlierScores({
  cluster,
  job,
  rawEntries,
  timeRange,
  detector,
}: {
  cluster: ClusterSummary;
  job: JobRecord;
  rawEntries: MetricExplorerEntry[];
  timeRange: { from: string; to: string };
  detector?: OutlierDetectorLike;
}): Promise<Map<string, MetricOutlierScore>> {
  const { collectMetricAutoFilterInput } = await import('./metricAutoFilter');
  const payload = await collectMetricAutoFilterInput({
    cluster,
    job,
    rawEntries,
    timeRange,
    filterGranularity: 'disaggregated',
  });

  return computeMetricOutlierScores(payload.series, detector ?? await createDbscanOutlierDetector());
}
