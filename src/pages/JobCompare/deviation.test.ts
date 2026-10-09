import { median, medianDeviationScorer, medianProfile } from './deviation';

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('medianProfile', () => {
  it('ignores points with fewer than three finite values', () => {
    const profile = medianProfile([
      [1, 1, NaN],
      [2, 5, NaN],
      [3, NaN, 9],
    ]);
    expect(profile[0]).toBe(2);
    expect(Number.isNaN(profile[1])).toBe(true);
    expect(Number.isNaN(profile[2])).toBe(true);
  });
});

describe('medianDeviationScorer', () => {
  const flat = (v: number) => [v, v, v, v];

  it('scores distance from the median profile and flags the outlier', () => {
    const result = medianDeviationScorer(
      new Map([
        ['a', flat(60)],
        ['b', flat(61)],
        ['c', flat(59)],
        ['d', flat(60)],
        ['e', flat(20)],
      ])
    );
    expect(result.get('e')).toEqual({ score: 40, signedMean: -40, flagged: true });
    expect(result.get('a')?.flagged).toBe(false);
    expect(result.get('b')).toEqual({ score: 1, signedMean: 1, flagged: false });
  });

  it('does not flag deviations smaller than 5% of the metric scale', () => {
    const result = medianDeviationScorer(
      new Map([
        ['a', flat(89)],
        ['b', flat(89)],
        ['c', flat(89)],
        ['d', flat(89)],
        ['e', flat(87)],
      ])
    );
    expect(result.get('e')).toEqual({ score: 2, signedMean: -2, flagged: false });
  });

  it('skips jobs without overlapping points and does not flag with fewer than three jobs', () => {
    const result = medianDeviationScorer(
      new Map([
        ['a', [1, NaN]],
        ['b', [9, NaN]],
        ['c', [NaN, NaN]],
      ])
    );
    expect(result.has('c')).toBe(false);
    expect([...result.values()].some((r) => r.flagged)).toBe(false);
  });
});
