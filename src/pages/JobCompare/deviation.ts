export const MIN_JOBS_PER_POINT = 3;
export const MAD_MULTIPLIER = 2;

export interface DeviationResult {
  score: number;
  signedMean: number;
  flagged: boolean;
}

// Profiles are keyed by jobKey and resampled onto a common grid.
// Phase 2 scorers (DTW, change-point position, ...) plug in through this signature.
export type DeviationScorer = (profiles: Map<string, number[]>) => Map<string, DeviationResult>;

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function medianProfile(profiles: number[][]): number[] {
  const length = profiles.reduce((max, p) => Math.max(max, p.length), 0);
  return Array.from({ length }, (_, i) => {
    const values = profiles.map((p) => p[i]).filter(Number.isFinite);
    return values.length >= MIN_JOBS_PER_POINT ? median(values) : NaN;
  });
}

export const medianDeviationScorer: DeviationScorer = (profiles) => {
  const result = new Map<string, DeviationResult>();
  const center = medianProfile([...profiles.values()]);

  for (const [key, profile] of profiles) {
    let absSum = 0;
    let signedSum = 0;
    let count = 0;
    profile.forEach((value, i) => {
      const m = center[i];
      if (!Number.isFinite(value) || !Number.isFinite(m)) {
        return;
      }
      absSum += Math.abs(value - m);
      signedSum += value - m;
      count += 1;
    });
    if (count > 0) {
      result.set(key, { score: absSum / count, signedMean: signedSum / count, flagged: false });
    }
  }

  const scores = [...result.values()].map((r) => r.score);
  if (scores.length >= MIN_JOBS_PER_POINT) {
    const med = median(scores);
    const mad = median(scores.map((s) => Math.abs(s - med)));
    const threshold = med + MAD_MULTIPLIER * mad;
    for (const r of result.values()) {
      r.flagged = r.score > threshold + 1e-9;
    }
  }
  return result;
};
