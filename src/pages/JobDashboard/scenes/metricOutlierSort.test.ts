import { computeMetricOutlierScores, normalizeOutlierValues, type OutlierDetectorLike } from './metricOutlierSort';

describe('metric outlier sort', () => {
  it('scores metrics by outlier intervals and outlying series count', () => {
    const detector: OutlierDetectorLike = {
      detect: jest.fn(() => ({
        outlyingSeries: [2],
        seriesResults: [
          { isOutlier: false, outlierIntervals: [], scores: [] },
          { isOutlier: false, outlierIntervals: [], scores: [] },
          {
            isOutlier: true,
            outlierIntervals: [
              { start: 1, end: 2 },
              { start: 4, end: 5 },
            ],
            scores: [],
          },
        ],
        clusterBand: undefined,
      })),
    };

    const scores = computeMetricOutlierScores(
      [
        { metricKey: 'raw:gpu_util', values: [10, 10, 10] },
        { metricKey: 'raw:gpu_util', values: [11, 11, 11] },
        { metricKey: 'raw:gpu_util', values: [99, 120, 99] },
      ],
      detector
    );

    expect(detector.detect).toHaveBeenCalledWith([
      new Float64Array([10, 10, 10]),
      new Float64Array([11, 11, 11]),
      new Float64Array([99, 120, 99]),
    ]);
    expect(scores.get('raw:gpu_util')).toEqual({
      intervalCount: 2,
      outlyingSeriesCount: 1,
    });
  });

  it('does not run DBSCAN for metrics with fewer than three valid series', () => {
    const detector: OutlierDetectorLike = {
      detect: jest.fn(),
    };

    const scores = computeMetricOutlierScores(
      [
        { metricKey: 'raw:node_load15', values: [1, 2, 3] },
        { metricKey: 'raw:node_load15', values: [2, 3, 4] },
      ],
      detector
    );

    expect(detector.detect).not.toHaveBeenCalled();
    expect(scores.get('raw:node_load15')).toEqual({
      intervalCount: 0,
      outlyingSeriesCount: 0,
    });
  });

  it('fills missing values and drops all-missing series before detection', () => {
    expect(normalizeOutlierValues([null, Number.NaN, 5, null, 7, Number.POSITIVE_INFINITY])).toEqual([5, 5, 5, 5, 7, 7]);
    expect(normalizeOutlierValues([null, Number.NaN])).toBeNull();
  });

  it('keeps scoring other metrics when one metric group fails detection', () => {
    const detector: OutlierDetectorLike = {
      detect: jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('invalid series shape');
        })
        .mockImplementationOnce(() => ({
          outlyingSeries: [1],
          seriesResults: [
            { isOutlier: false, outlierIntervals: [], scores: [] },
            { isOutlier: true, outlierIntervals: [{ start: 0, end: 1 }], scores: [] },
            { isOutlier: false, outlierIntervals: [], scores: [] },
          ],
          clusterBand: undefined,
        })),
    };

    const scores = computeMetricOutlierScores(
      [
        { metricKey: 'raw:first', values: [1, 1, 1] },
        { metricKey: 'raw:first', values: [2, 2, 2] },
        { metricKey: 'raw:first', values: [3, 3, 3] },
        { metricKey: 'raw:second', values: [10, 10, 10] },
        { metricKey: 'raw:second', values: [99, 120, 99] },
        { metricKey: 'raw:second', values: [11, 11, 11] },
      ],
      detector
    );

    expect(scores.get('raw:first')).toEqual({
      intervalCount: 0,
      outlyingSeriesCount: 0,
    });
    expect(scores.get('raw:second')).toEqual({
      intervalCount: 1,
      outlyingSeriesCount: 1,
    });
  });

  it('throws when every eligible metric group fails detection', () => {
    const detector: OutlierDetectorLike = {
      detect: jest.fn(() => {
        throw new Error('invalid series shape');
      }),
    };

    expect(() =>
      computeMetricOutlierScores(
        [
          { metricKey: 'raw:first', values: [1, 1, 1] },
          { metricKey: 'raw:first', values: [2, 2, 2] },
          { metricKey: 'raw:first', values: [3, 3, 3] },
          { metricKey: 'raw:second', values: [10, 10, 10] },
          { metricKey: 'raw:second', values: [11, 11, 11] },
          { metricKey: 'raw:second', values: [12, 12, 12] },
        ],
        detector
      )
    ).toThrow('Failed to detect outliers for all eligible metric groups.');
  });
});
