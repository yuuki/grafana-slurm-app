import { getJobMetricDefinition, getJobMetricsCatalog } from './metricsCatalog';

describe('job metrics catalog', () => {
  it('groups built-in metrics by category', () => {
    const catalog = getJobMetricsCatalog();

    expect(catalog.map((group) => group.category)).toEqual(['gpu', 'cpu-memory', 'network', 'disk']);
    expect(catalog.find((group) => group.category === 'gpu')?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'gpu-utilization', title: 'GPU Utilization' }),
        expect.objectContaining({ id: 'gpu-memory-used', title: 'GPU Memory Used' }),
      ])
    );
  });

  it('resolves metrics by stable id', () => {
    expect(getJobMetricDefinition('network-transmit')).toEqual(
      expect.objectContaining({
        id: 'network-transmit',
        category: 'network',
        title: 'Network Transmit',
      })
    );
  });
});
