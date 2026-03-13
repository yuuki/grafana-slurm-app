import { formatDuration, formatTimestamp } from './jobTime';

describe('formatDuration', () => {
  it('returns minutes only for short durations', () => {
    expect(formatDuration(300)).toBe('5m');
    expect(formatDuration(0)).toBe('0m');
  });

  it('returns hours and minutes for medium durations', () => {
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(7200)).toBe('2h 0m');
  });

  it('returns days, hours and minutes for long durations', () => {
    expect(formatDuration(90000)).toBe('1d 1h 0m');
    expect(formatDuration(172800)).toBe('2d 0h 0m');
    expect(formatDuration(187500)).toBe('2d 4h 5m');
  });

  it('clamps negative values to zero', () => {
    expect(formatDuration(-100)).toBe('0m');
  });
});

describe('formatTimestamp', () => {
  it('returns dash for zero timestamp', () => {
    expect(formatTimestamp(0)).toBe('-');
  });

  it('returns a locale string for non-zero timestamp', () => {
    const result = formatTimestamp(1700000000);
    expect(result).not.toBe('-');
    expect(typeof result).toBe('string');
  });
});
