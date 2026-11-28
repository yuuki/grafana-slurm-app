import { JobPhasesAnalysis } from './collect';
import {
  buildBasis,
  buildCoverageNotes,
  buildLimitNotes,
  describeNotComputed,
  describeWindow,
  draftLabel,
  formatByteRate,
  formatCpu,
  formatNumber,
  formatSeconds,
  formatShares,
  orderedTotals,
  phaseBackground,
  PHASE_LABELS,
  REASON_TEXT,
  stalledNowSeconds,
} from './present';
import { segmentPhases } from './segment';
import { PHASE_ORDER, PhaseId, PhaseTotal, UNCLASSIFIED_REASONS } from './types';

function total(phase: PhaseId, share: number): PhaseTotal {
  return {
    phase,
    seconds: share * 100_000,
    share,
    segmentCount: 1,
    evidence: { gpuPowerWatts: null, gpuUtilPercent: null, cpuBusy: null, storageWriteBytesPerSecond: null, networkBytesPerSecond: null },
  };
}

function printed(shares: Map<PhaseId, string>): number {
  return [...shares.values()].reduce((sum, text) => sum + (text.startsWith('<') ? 0 : Math.round(parseFloat(text) * 10)), 0);
}

describe('formatShares', () => {
  it('prints shares with one decimal that add up to exactly 100.0', () => {
    const shares = formatShares([total('init', 1 / 3), total('compute', 1 / 3), total('stalled', 1 / 3)]);
    expect([...shares.values()]).toEqual(['33.4%', '33.3%', '33.3%']);
    expect(printed(shares)).toBe(1000);
  });

  it('adds up for the example of the issue', () => {
    const shares = formatShares([total('init', 0.05), total('compute', 0.81), total('checkpoint', 0.12), total('stalled', 0.02)]);
    expect([...shares.entries()]).toEqual([
      ['init', '5.0%'],
      ['compute', '81.0%'],
      ['checkpoint', '12.0%'],
      ['stalled', '2.0%'],
    ]);
  });

  it('adds up for random splits, each share within 0.1 of its exact value', () => {
    let state = 42;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    for (let round = 0; round < 500; round++) {
      const weights = PHASE_ORDER.map(() => (random() < 0.2 ? 0 : random() ** 3)).map((weight, index) => (index === 1 ? weight + 0.01 : weight));
      const sum = weights.reduce((a, b) => a + b, 0);
      const totals = PHASE_ORDER.map((phase, index) => total(phase, weights[index] / sum)).filter((item) => item.share > 0);
      const shares = formatShares(totals);
      const tiny = [...shares.values()].filter((text) => text.startsWith('<')).length;
      // A share printed as "<0.1%" stands for less than 0.1; the rest then adds up to 100.0 minus at most that.
      expect(printed(shares)).toBeLessThanOrEqual(1000);
      expect(printed(shares)).toBeGreaterThanOrEqual(1000 - tiny);
      for (const item of totals) {
        const text = shares.get(item.phase)!;
        if (!text.startsWith('<')) {
          expect(Math.abs(parseFloat(text) - item.share * 100)).toBeLessThan(0.1 + 1e-9);
        } else {
          expect(item.share * 100).toBeLessThan(0.1);
        }
      }
    }
  });

  it('never prints a phase that exists as 0.0%', () => {
    const shares = formatShares([total('compute', 0.9996), total('checkpoint', 0.0004)]);
    expect(shares.get('checkpoint')).toBe('<0.1%');
    expect(shares.get('compute')).toBe('100.0%');
  });

  it('returns nothing for no totals', () => {
    expect(formatShares([]).size).toBe(0);
  });
});

describe('number formats', () => {
  it('formats durations', () => {
    expect(formatSeconds(0)).toBe('0s');
    expect(formatSeconds(45)).toBe('45s');
    expect(formatSeconds(60)).toBe('1m');
    expect(formatSeconds(94)).toBe('1m 34s');
    expect(formatSeconds(3600)).toBe('1h');
    expect(formatSeconds(3 * 3600 + 5 * 60 + 9)).toBe('3h 5m');
    expect(formatSeconds(2 * 86400 + 3600)).toBe('2d 1h');
  });

  it('formats byte rates, CPU load and missing values', () => {
    expect(formatByteRate(0)).toBe('0 B/s');
    expect(formatByteRate(1023)).toBe('1023 B/s');
    expect(formatByteRate(1024 * 1024)).toBe('1.0 MiB/s');
    expect(formatByteRate(190 * 1024 * 1024)).toBe('190 MiB/s');
    expect(formatByteRate(null)).toBe('no data');
    expect(formatCpu(0.2)).toBe('20%');
    expect(formatCpu(0.004)).toBe('0.4%');
    expect(formatCpu(null)).toBe('no data');
    expect(formatNumber(300.4, ' W')).toBe('300 W');
    expect(formatNumber(null, ' W')).toBe('no data');
  });
});

describe('texts', () => {
  it('has a label for every phase and a sentence for every reason', () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASE_LABELS[phase]).toBeTruthy();
    }
    for (const reason of UNCLASSIFIED_REASONS) {
      expect(REASON_TEXT[reason]).toBeTruthy();
    }
  });

  it('gives every label its own colour in both themes, and hatches missing data', () => {
    for (const isDark of [false, true]) {
      const backgrounds = PHASE_ORDER.map((phase) => phaseBackground(phase, isDark));
      expect(new Set(backgrounds).size).toBe(PHASE_ORDER.length);
      expect(phaseBackground('no-data', isDark)).toContain('repeating-linear-gradient');
    }
    expect(phaseBackground('compute', false)).not.toBe(phaseBackground('compute', true));
  });

  it('says why a job has no result', () => {
    expect(describeNotComputed({ state: 'not-computed', reason: 'not-started', queryCount: 0 })).toBe('The job has not started, or has no node.');
    expect(describeNotComputed({ state: 'not-computed', reason: 'too-short', stepSec: 240, queryCount: 2 })).toBe(
      'The job is too short: the phases need at least 5 buckets of 4m inside the run.'
    );
    expect(describeNotComputed({ state: 'not-computed', reason: 'too-many-nodes', maxNodes: 4800, queryCount: 0 })).toBe(
      'The job has more nodes than one analysis reads (4800).'
    );
    expect(describeNotComputed({ state: 'not-computed', reason: 'no-gpus', queryCount: 1 })).toContain('allocated no GPU');
    expect(describeNotComputed({ state: 'not-computed', reason: 'no-gpu-telemetry', queryCount: 5 })).toBe(
      "The job's nodes report no GPU telemetry in the job's run."
    );
    expect(describeNotComputed({ state: 'not-computed', reason: 'shared-nodes', gpusReported: 16, gpusAllocated: 4, queryCount: 1 })).toBe(
      "The job's nodes report 16 GPUs and the job allocated 4. GPU telemetry is read per node, so the phases would mix this job with whatever runs on the other GPUs."
    );
  });

  it('builds a draft label that names the phase and asks for a review', () => {
    expect(draftLabel('checkpoint', undefined)).toEqual({
      category: 'phase:checkpoint',
      note: 'Detected by the job phase segmentation: Checkpoint / storage I/O. Review the window before saving.',
    });
    expect(draftLabel('unclassified', 'nodes-disagree').note).toContain('Unclassified (No majority');
  });
});

function analysisOf(overrides: Partial<JobPhasesAnalysis> = {}): JobPhasesAnalysis {
  const row = (letters: string, working: number, idle: number) => Float64Array.from([...letters].map((letter) => (letter === 'W' ? working : idle)));
  const gpu = 'iiWWWWWWWWiiiiiiiiiiii';
  const result = segmentPhases({
    startSec: 1200,
    stepSec: 60,
    bucketCount: gpu.length,
    nodeCount: 2,
    signals: {
      gpuPower: [row(gpu, 300, 60), row(gpu, 300, 60)],
      gpuUtilMean: [row(gpu, 95, 0), row(gpu, 95, 0)],
      gpuUtilMax: [row(gpu, 100, 0), row(gpu, 100, 0)],
    },
  });
  return {
    window: { startSec: 1200, endSec: 1200 + 60 * gpu.length, stepSec: 60, bucketCount: gpu.length, runStartSec: 1147, runEndSec: 2527, running: false, scrapeSec: 15, scrapeMeasured: true },
    result,
    signals: [
      { signal: 'gpuUtilMax', metrics: ['DCGM_FI_DEV_GPU_UTIL'], status: 'ok', coverage: 1 },
      { signal: 'gpuUtilMean', metrics: ['DCGM_FI_DEV_GPU_UTIL'], status: 'ok', coverage: 1 },
      { signal: 'gpuPower', metrics: ['DCGM_FI_DEV_POWER_USAGE'], status: 'ok', coverage: 0.987 },
      { signal: 'cpuBusy', metrics: ['node_cpu_seconds_total'], status: 'ok', coverage: 1 },
      { signal: 'storageWrite', metrics: ['node_disk_written_bytes_total'], status: 'ok', coverage: 1 },
      { signal: 'network', metrics: ['node_network_receive_bytes_total', 'node_network_transmit_bytes_total'], status: 'ok', coverage: 1 },
    ],
    nodes: ['node-a001', 'node-a002'],
    thresholds: { idleGpuUtilizationPercent: 5, stallMinSeconds: 600, checkpointMinWriteBytesPerSecond: 1024 * 1024 },
    gpuCounts: { perNode: [4, 4], total: 8 },
    gpusAllocated: 8,
    droppedPoints: 0,
    queryCount: 8,
    ...overrides,
  };
}

describe('what the result is based on', () => {
  it('lists each signal once with its metrics and coverage, rounded down', () => {
    expect(buildBasis(analysisOf())).toEqual([
      { signal: 'gpuUtilMax', label: 'GPU utilization', metrics: 'DCGM_FI_DEV_GPU_UTIL', status: 'used, 100% of node buckets', available: true },
      { signal: 'gpuPower', label: 'GPU power', metrics: 'DCGM_FI_DEV_POWER_USAGE', status: 'used, 98% of node buckets', available: true },
      { signal: 'cpuBusy', label: 'CPU load', metrics: 'node_cpu_seconds_total', status: 'used, 100% of node buckets', available: true },
      { signal: 'storageWrite', label: 'Storage write rate', metrics: 'node_disk_written_bytes_total', status: 'used, 100% of node buckets', available: true },
      {
        signal: 'network',
        label: 'Network rate',
        metrics: 'node_network_receive_bytes_total, node_network_transmit_bytes_total',
        status: 'used, 100% of node buckets',
        available: true,
      },
    ]);
  });

  it('names a signal that is missing, failed or not usable', () => {
    const analysis = analysisOf();
    analysis.signals[3] = { signal: 'cpuBusy', metrics: ['node_cpu_seconds_total'], status: 'invalid', coverage: 0 };
    analysis.signals[4] = { signal: 'storageWrite', metrics: ['node_disk_written_bytes_total'], status: 'no-series', coverage: 0 };
    analysis.signals[5] = { signal: 'network', metrics: ['node_network_receive_bytes_total'], status: 'failed', coverage: 0, error: 'timeout' };
    const basis = buildBasis(analysis);
    expect(basis.map((line) => [line.signal, line.status, line.available])).toEqual([
      ['gpuUtilMax', 'used, 100% of node buckets', true],
      ['gpuPower', 'used, 98% of node buckets', true],
      ['cpuBusy', 'values not usable', false],
      ['storageWrite', 'no series', false],
      ['network', 'query failed', false],
    ]);
  });

  it('states no limit when every signal is there', () => {
    expect(buildLimitNotes(analysisOf())).toEqual([]);
    expect(buildCoverageNotes(analysisOf())).toEqual([]);
  });

  it('states what each missing signal means for the result', () => {
    const analysis = analysisOf({ droppedPoints: 3 });
    analysis.signals = analysis.signals.filter((report) => report.signal === 'gpuPower');
    analysis.window.scrapeMeasured = false;
    analysis.window.scrapeSec = 30;
    expect(buildLimitNotes(analysis)).toEqual([
      'Without GPU utilization, idle cannot be proven from power alone: no stall is reported.',
      'Without a storage write series, no checkpoint is reported: GPU dips stay unclassified.',
      'Without a CPU series, a stall cannot be told from a stretch of CPU-only work.',
      'The scrape interval could not be measured; 30 s is assumed.',
      '3 points of the responses were not on the bucket grid and were dropped.',
    ]);
    const utilOnly = analysisOf();
    utilOnly.signals = utilOnly.signals.filter((report) => report.signal !== 'gpuPower');
    expect(buildLimitNotes(utilOnly)).toEqual([
      'Without GPU power, the working level is judged on utilization alone: a GPU that spins at full utilization without doing work is not seen.',
    ]);
  });

  it('names silent nodes and a GPU count that does not match the allocation', () => {
    const analysis = analysisOf({ gpuCounts: { perNode: [4, 2], total: 6 } });
    analysis.result.silentNodes = [1];
    expect(buildCoverageNotes(analysis)).toEqual([
      '1 of 2 nodes reported no GPU telemetry in the window (node-a002). A job phase needs more than half of the nodes, and a stall needs all of them.',
      'The nodes report 6 GPUs and the job allocated 8. The idle test covers the GPUs that report.',
    ]);
    expect(buildCoverageNotes(analysisOf({ gpusAllocated: 0 }))).toEqual([
      "Slurm records no GPU count for this job, so the plugin cannot check that the nodes' GPUs are all the job's.",
    ]);
  });

  it('describes the resolution and the edges that are not analysed', () => {
    expect(describeWindow(analysisOf())).toEqual({
      resolution:
        '22 buckets of 1m (scrape interval 15 s). A stretch shorter than about one bucket is not visible, and a boundary is right to within one bucket.',
      edges: '1m at the edges of the run is outside the buckets and not analysed.',
    });
    const exact = analysisOf();
    exact.window.runStartSec = exact.window.startSec;
    exact.window.runEndSec = exact.window.endSec;
    expect(describeWindow(exact).edges).toBeNull();
  });

  it('orders the totals and finds a stall that lasts until now', () => {
    const analysis = analysisOf();
    expect(orderedTotals(analysis).map((item) => item.phase)).toEqual(['init', 'compute', 'stalled']);
    expect(stalledNowSeconds(analysis)).toBeNull();
    analysis.window.running = true;
    expect(stalledNowSeconds(analysis)).toBe(720);
  });
});
