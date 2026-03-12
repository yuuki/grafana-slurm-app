import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MetricExplorer } from './MetricExplorer';
import { MetricExplorerEntry } from '../scenes/metricDiscovery';

const emptyFieldConfig = { defaults: {}, overrides: [] };

function entry(overrides: Partial<MetricExplorerEntry> & Pick<MetricExplorerEntry, 'key' | 'title'>): MetricExplorerEntry {
  return {
    kind: 'raw',
    matcherKind: 'node',
    description: '',
    legendFormat: '{{instance}}',
    fieldConfig: emptyFieldConfig,
    labelKeys: ['instance'],
    ...overrides,
  };
}

describe('MetricExplorer', () => {
  it('renders raw metrics only and filters the list by search text', () => {
    const onTogglePin = jest.fn();
    const onOpenInExplore = jest.fn();

    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL', title: 'GPU Utilization', matcherKind: 'gpu' }),
          entry({ key: 'raw:node:custom_metric', title: 'custom_metric' }),
        ]}
        selectedMetricKeys={['raw:gpu:DCGM_FI_DEV_GPU_UTIL']}
        onTogglePin={onTogglePin}
        onOpenInExplore={onOpenInExplore}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    expect(screen.getByText('Metric Explorer')).toBeInTheDocument();
    expect(screen.queryByText('Recommended views')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview-raw:gpu:DCGM_FI_DEV_GPU_UTIL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unpin' })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'gpu' } });

    expect(screen.getByText(/GPU Utilization/)).toBeInTheDocument();
    expect(screen.queryByText('custom_metric')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Explore' }));

    expect(onTogglePin).toHaveBeenCalledWith('raw:gpu:DCGM_FI_DEV_GPU_UTIL');
    expect(onOpenInExplore).toHaveBeenCalledWith('raw:gpu:DCGM_FI_DEV_GPU_UTIL');
  });

  it('matches incremental search tokens across metric titles', () => {
    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL', title: 'GPU Utilization', matcherKind: 'gpu' }),
          entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_TEMP', title: 'GPU Temperature', matcherKind: 'gpu' }),
          entry({ key: 'raw:node:custom_metric', title: 'custom_metric' }),
        ]}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'gpu li' } });

    expect(screen.getByText(/GPU Utilization/)).toBeInTheDocument();
    expect(screen.queryByText(/GPU Temperature/)).not.toBeInTheDocument();
    expect(screen.queryByText(/custom_metric/)).not.toBeInTheDocument();
  });

  it('matches incremental search tokens against metric names and sorts pinned entries before unpinned ones', () => {
    render(
      <MetricExplorer
        rawEntries={[
          entry({
            key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
            title: 'Accelerator Busy',
            matcherKind: 'gpu',
            metricName: 'DCGM_FI_DEV_GPU_UTIL',
          }),
          entry({
            key: 'raw:node:custom_gpu_util',
            title: 'Custom GPU Util',
            matcherKind: 'node',
            metricName: 'custom_gpu_util',
          }),
          entry({
            key: 'raw:gpu:DCGM_FI_DEV_GPU_TEMP',
            title: 'GPU Temperature',
            matcherKind: 'gpu',
            metricName: 'DCGM_FI_DEV_GPU_TEMP',
          }),
        ]}
        selectedMetricKeys={['raw:node:custom_gpu_util']}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'dcg util' } });

    expect(screen.getByText(/Accelerator Busy/)).toBeInTheDocument();
    expect(screen.queryByText(/GPU Temperature/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'gpu util' } });

    expect(
      screen.getAllByTestId(/preview-raw:/).map((element) => element.getAttribute('data-testid'))
    ).toEqual(['preview-raw:node:custom_gpu_util', 'preview-raw:gpu:DCGM_FI_DEV_GPU_UTIL']);
  });

  it('returns all raw entries when the search query is empty', () => {
    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:a', title: 'Alpha' }),
          entry({ key: 'raw:b', title: 'Beta' }),
        ]}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    expect(screen.getByText(/Alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Beta/)).toBeInTheDocument();
  });

  it('returns no raw entries when no tokens match', () => {
    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:a', title: 'Alpha' }),
          entry({ key: 'raw:b', title: 'Beta' }),
        ]}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'zzzzz' } });

    expect(screen.queryByText(/Alpha/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Beta/)).not.toBeInTheDocument();
  });

  it('normalizes separator characters in search query to match metric names', () => {
    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:a', title: 'node_cpu_seconds_total', metricName: 'node_cpu_seconds_total' }),
          entry({ key: 'raw:b', title: 'GPU Temperature' }),
        ]}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'cpu sec' } });

    expect(screen.getByText(/node_cpu_seconds_total/)).toBeInTheDocument();
    expect(screen.queryByText(/GPU Temperature/)).not.toBeInTheDocument();
  });

  it('shows 32 metrics first and appends more with the jobs table style button', () => {
    render(
      <MetricExplorer
        rawEntries={Array.from({ length: 40 }, (_, index) =>
          entry({
            key: `raw:node:metric_${String(index + 1).padStart(2, '0')}`,
            title: `metric_${String(index + 1).padStart(2, '0')}`,
            metricName: `metric_${String(index + 1).padStart(2, '0')}`,
          })
        )}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    expect(screen.getAllByTestId(/preview-raw:/)).toHaveLength(32);
    expect(screen.getByRole('button', { name: 'Show 8 more (32/40)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 8 more (32/40)' }));

    expect(screen.getAllByTestId(/preview-raw:/)).toHaveLength(40);
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it('filters metrics by auto-detected prefix chips and resets visible count when filters change', () => {
    render(
      <MetricExplorer
        rawEntries={[
          ...Array.from({ length: 35 }, (_, index) =>
            entry({
              key: `raw:gpu:DCGM_FI_DEV_GPU_${index}`,
              title: `GPU Metric ${index}`,
              matcherKind: 'gpu',
              metricName: `DCGM_FI_DEV_GPU_${index}`,
            })
          ),
          entry({
            key: 'raw:node:node_cpu_seconds_total',
            title: 'node_cpu_seconds_total',
            metricName: 'node_cpu_seconds_total',
          }),
          entry({
            key: 'raw:node:node_memory_MemAvailable_bytes',
            title: 'node_memory_MemAvailable_bytes',
            metricName: 'node_memory_MemAvailable_bytes',
          }),
          entry({
            key: 'raw:node:custommetric',
            title: 'custommetric',
            metricName: 'custommetric',
          }),
        ]}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: 'DCGM_' }));
    expect(screen.getAllByTestId(/preview-raw:/)).toHaveLength(32);
    expect(screen.getByRole('button', { name: 'Show 3 more (32/35)' })).toBeInTheDocument();
    expect(screen.queryByText('node_cpu_seconds_total')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'node_' }));
    expect(screen.getAllByTestId(/preview-raw:/)).toHaveLength(2);
    expect(screen.getByTestId('preview-raw:node:node_cpu_seconds_total')).toBeInTheDocument();
    expect(screen.getByTestId('preview-raw:node:node_memory_MemAvailable_bytes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'custom' }));
    expect(screen.getByTestId('preview-raw:node:custommetric')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'memory' } });
    expect(screen.getAllByTestId(/preview-raw:/)).toHaveLength(1);
    expect(screen.getByTestId('preview-raw:node:node_memory_MemAvailable_bytes')).toBeInTheDocument();
  });
});
