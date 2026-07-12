import { scoreSeverity } from './severity';

describe('scoreSeverity', () => {
  it.each([
    { score: -1, lowSample: false, want: 'ok' },
    { score: 0.999, lowSample: false, want: 'ok' },
    { score: 1, lowSample: false, want: 'warning' },
    { score: 4.999, lowSample: false, want: 'warning' },
    { score: 5, lowSample: false, want: 'critical' },
    { score: 100, lowSample: true, want: 'ok' },
  ] as const)('returns $want for score=$score lowSample=$lowSample', ({ score, lowSample, want }) => {
    expect(scoreSeverity(score, lowSample)).toBe(want);
  });
});
