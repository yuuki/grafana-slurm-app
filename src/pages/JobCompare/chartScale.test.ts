import { buildBandPath, buildLinePath, formatValue, formatXValue, scaleValue } from './chartScale';

describe('chartScale', () => {
  it('scales linearly and handles empty domains', () => {
    expect(scaleValue(5, [0, 10], [0, 100])).toBe(50);
    expect(scaleValue(5, [0, 10], [100, 0])).toBe(50);
    expect(scaleValue(5, [5, 5], [0, 100])).toBe(0);
  });

  it('breaks the line at missing values', () => {
    expect(buildLinePath([0, 1, 2, 3], [0, 1, NaN, 1], [0, 3], [0, 1], 300, 100)).toBe('M0 100 L100 0 M300 0');
  });

  it('builds closed band polygons per contiguous segment', () => {
    expect(buildBandPath([0, 1], [0, 0], [1, 1], [0, 1], [0, 1], 100, 100)).toBe('M0 0 L100 0 L100 100 L0 100 Z');
    expect(buildBandPath([0, 1, 2], [0, NaN, 0], [1, NaN, 1], [0, 2], [0, 1], 100, 100)).toBe('');
  });

  it('formats x values per axis', () => {
    expect(formatXValue(42.4, 'progress')).toBe('42%');
    expect(formatXValue(12660, 'elapsed')).toBe('3h 31m');
    expect(formatXValue(0, 'absolute')).toBe('1970-01-01 00:00');
  });

  it('formats values compactly', () => {
    expect(formatValue(undefined)).toBe('-');
    expect(formatValue(NaN)).toBe('-');
    expect(formatValue(0.61234)).toBe('0.612');
    expect(formatValue(61.23)).toBe('61.2');
    expect(formatValue(612.3)).toBe('612');
    expect(formatValue(1234)).toBe('1.2k');
    expect(formatValue(2_500_000)).toBe('2.5M');
    expect(formatValue(3_000_000_000)).toBe('3.0G');
  });
});
