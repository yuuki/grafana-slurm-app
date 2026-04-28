import { computeMetricOutlierScores, collectMetricOutlierScores, normalizeOutlierValues, type OutlierDetectorLike } from './metricOutlierSort';
import { collectMetricAutoFilterInput } from './metricAutoFilter';
import initOutlierWasm, { OutlierDetector } from '@bsull/augurs/outlier';

jest.mock('./metricAutoFilter', () => ({
  collectMetricAutoFilterInput: jest.fn(),
}));

jest.mock('@bsull/augurs/outlier', () => ({
  __esModule: true,
  default: jest.fn(() => Promise.resolve()),
  OutlierDetector: {
    dbscan: jest.fn(() => ({
      detect: jest.fn(() => ({
        outlyingSeries: [],
        seriesResults: [
          { isOutlier: false, outlierIntervals: [], scores: [] },
          { isOutlier: false, outlierIntervals: [], scores: [] },
          { isOutlier: false, outlierIntervals: [], scores: [] },
        ],
        clusterBand: undefined,
      })),
    })),
  },
}));

describe('metric outlier sort', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it('initializes the default outlier detector with the bundled wasm asset URL', async () => {
    jest.mocked(collectMetricAutoFilterInput).mockResolvedValueOnce({
      clusterId: 'a100',
      jobId: '10001',
      timestamps: [1, 2, 3],
      series: [
        { seriesId: 'a', metricKey: 'raw:gpu_util', metricName: 'gpu_util', values: [1, 1, 1] },
        { seriesId: 'b', metricKey: 'raw:gpu_util', metricName: 'gpu_util', values: [2, 2, 2] },
        { seriesId: 'c', metricKey: 'raw:gpu_util', metricName: 'gpu_util', values: [3, 3, 3] },
      ],
    });

    await collectMetricOutlierScores({
      cluster: {
        id: 'a100',
        displayName: 'A100',
        slurmClusterName: 'slurm-a100',
        metricsDatasourceUid: 'prom-main',
        metricsType: 'prometheus',
        aggregationNodeLabels: [],
        instanceLabel: 'instance',
        nodeMatcherMode: 'host:port',
        defaultTemplateId: '',
      },
      job: {
        clusterId: 'a100',
        jobId: 10001,
        name: 'job',
        user: 'user',
        account: 'account',
        partition: 'gpu',
        state: 'RUNNING',
        nodes: ['node001'],
        nodeList: 'node001',
        nodeCount: 1,
        gpusTotal: 1,
        startTime: 1,
        endTime: 2,
        exitCode: 0,
        workDir: '',
        tres: '',
        templateId: '',
      },
      rawEntries: [],
      timeRange: { from: '1970-01-01T00:00:01Z', to: '1970-01-01T00:00:02Z' },
    });

    const initArg = jest.mocked(initOutlierWasm).mock.calls[0][0];
    expect(initArg).toBeInstanceOf(URL);
    expect(String(initArg)).toContain('node_modules/@bsull/augurs/outlier_bg.wasm');
    expect(OutlierDetector.dbscan).toHaveBeenCalledWith({ sensitivity: 0.9 });
  });
});
