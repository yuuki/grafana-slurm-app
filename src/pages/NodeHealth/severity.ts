export type Severity = 'critical' | 'warning' | 'ok';

export function scoreSeverity(score: number, lowSample: boolean): Severity {
  if (lowSample) {
    return 'ok';
  }
  if (score >= 5) {
    return 'critical';
  }
  if (score >= 1) {
    return 'warning';
  }
  return 'ok';
}
