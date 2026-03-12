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
    rawLegendFormat: '{{instance}}',
    aggregatedLegendFormat: '{{instance}}',
    aggregationEligible: false,
    fieldConfig: emptyFieldConfig,
    labelKeys: ['instance'],
    ...overrides,
  };
}

function renderMetricExplorer(
  rawEntries: MetricExplorerEntry[],
  selectedMetricKeys: string[] = [],
  onDisplayModeChange = jest.fn()
) {
  return render(
    <MetricExplorer
      rawEntries={rawEntries}
      selectedMetricKeys={selectedMetricKeys}
      displayMode="aggregated"
      onDisplayModeChange={onDisplayModeChange}
      onTogglePin={jest.fn()}
      onOpenInExplore={jest.fn()}
      renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
    />
  );
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
        displayMode="aggregated"
        onDisplayModeChange={jest.fn()}
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

  it('switches display mode through the mode radios', () => {
    const onDisplayModeChange = jest.fn();
    renderMetricExplorer([entry({ key: 'raw:a', title: 'Alpha' })], [], onDisplayModeChange);

    fireEvent.click(screen.getByRole('radio', { name: 'Raw' }));

    expect(onDisplayModeChange).toHaveBeenCalledWith('raw');
  });

  it('matches incremental search tokens across metric titles', () => {
    renderMetricExplorer([
      entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL', title: 'GPU Utilization', matcherKind: 'gpu' }),
      entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_TEMP', title: 'GPU Temperature', matcherKind: 'gpu' }),
      entry({ key: 'raw:node:custom_metric', title: 'custom_metric' }),
    ]);

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'gpu li' } });

    expect(screen.getByText(/GPU Utilization/)).toBeInTheDocument();
    expect(screen.queryByText(/GPU Temperature/)).not.toBeInTheDocument();
    expect(screen.queryByText(/custom_metric/)).not.toBeInTheDocument();
  });

  it('matches incremental search tokens against metric names and sorts pinned entries before unpinned ones', () => {
    renderMetricExplorer(
      [
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
      ],
      ['raw:node:custom_gpu_util']
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
    renderMetricExplorer([
      entry({ key: 'raw:a', title: 'Alpha' }),
      entry({ key: 'raw:b', title: 'Beta' }),
    ]);

    expect(screen.getByText(/Alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Beta/)).toBeInTheDocument();
  });

  it('returns no raw entries when no tokens match', () => {
    renderMetricExplorer([
      entry({ key: 'raw:a', title: 'Alpha' }),
      entry({ key: 'raw:b', title: 'Beta' }),
    ]);

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'zzzzz' } });

    expect(screen.queryByText(/Alpha/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Beta/)).not.toBeInTheDocument();
  });

  it('normalizes separator characters in search query to match metric names', () => {
    renderMetricExplorer([
      entry({ key: 'raw:a', title: 'node_cpu_seconds_total', metricName: 'node_cpu_seconds_total' }),
      entry({ key: 'raw:b', title: 'GPU Temperature' }),
    ]);

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'cpu sec' } });

    expect(screen.getByText(/node_cpu_seconds_total/)).toBeInTheDocument();
    expect(screen.queryByText(/GPU Temperature/)).not.toBeInTheDocument();
  });

  it('shows 32 metrics first and appends more with the jobs table style button', () => {
    renderMetricExplorer(
      Array.from({ length: 40 }, (_, index) =>
        entry({
          key: `raw:node:metric_${String(index + 1).padStart(2, '0')}`,
          title: `metric_${String(index + 1).padStart(2, '0')}`,
          metricName: `metric_${String(index + 1).padStart(2, '0')}`,
        })
      )
    );

    expect(screen.getAllByTestId(/preview-raw:/)).toHaveLength(32);
    expect(screen.getByRole('button', { name: 'Show 8 more (32/40)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 8 more (32/40)' }));

    expect(screen.getAllByTestId(/preview-raw:/)).toHaveLength(40);
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it('filters metrics by auto-detected prefix chips and resets visible count when filters change', () => {
    renderMetricExplorer([
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
    ]);

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

  it('shows auto-filter controls and narrows the visible list when enabled', () => {
    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL', title: 'GPU Utilization', matcherKind: 'gpu', metricName: 'DCGM_FI_DEV_GPU_UTIL' }),
          entry({ key: 'raw:node:node_load15', title: 'Load Average (15m)', metricName: 'node_load15' }),
        ]}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        onRunAutoFilter={jest.fn()}
        autoFilterStatus="success"
        autoFilteredMetricKeys={['raw:gpu:DCGM_FI_DEV_GPU_UTIL']}
        autoFilterEnabled
        onAutoFilterEnabledChange={jest.fn()}
        autoFilterSummary={{ selectedMetricCount: 1, totalMetricCount: 2 }}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    expect(screen.getByRole('button', { name: 'Run auto filter' })).toBeInTheDocument();
    expect(screen.getByLabelText('Auto-filtered only')).toBeInTheDocument();
    expect(screen.getByText('Auto filter selected 1 of 2 metrics.')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Auto-filtered only'));

    expect(screen.getByTestId('preview-raw:gpu:DCGM_FI_DEV_GPU_UTIL')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-raw:node:node_load15')).not.toBeInTheDocument();
  });

  it('shows runtime auto-filter settings and reports custom setting changes', () => {
    const onAutoFilterSettingsChange = jest.fn();
    const defaultAutoFilterSettings = {
      searchMethod: 'pelt',
      costModel: 'l2',
      penalty: 'bic',
      penaltyAdjust: 2,
      bandwidth: 2.5,
      segmentSelectionMethod: 'weighted_max',
      nJobs: 1,
      withoutSimpleFilter: false,
    } as const;

    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL', title: 'GPU Utilization', matcherKind: 'gpu', metricName: 'DCGM_FI_DEV_GPU_UTIL' }),
        ]}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        onRunAutoFilter={jest.fn()}
        autoFilterStatus="idle"
        autoFilteredMetricKeys={[]}
        autoFilterEnabled={false}
        onAutoFilterEnabledChange={jest.fn()}
        defaultAutoFilterSettings={defaultAutoFilterSettings}
        autoFilterSettings={defaultAutoFilterSettings}
        useCustomAutoFilterSettings={false}
        onUseCustomAutoFilterSettingsChange={jest.fn()}
        onAutoFilterSettingsChange={onAutoFilterSettingsChange}
        onResetAutoFilterSettings={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Auto-filter settings' }));
    expect(screen.getByLabelText('Use custom settings')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Use custom settings'));
    fireEvent.change(screen.getByLabelText('Penalty adjust'), {
      target: { value: '4' },
    });

    expect(onAutoFilterSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ penaltyAdjust: 4 }));
  });
});
