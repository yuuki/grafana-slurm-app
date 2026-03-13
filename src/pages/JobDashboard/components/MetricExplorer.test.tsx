import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MetricExplorer } from './MetricExplorer';
import { MetricExplorerEntry } from '../scenes/metricDiscovery';

const emptyFieldConfig = { defaults: {}, overrides: [] };

function entry(overrides: Partial<MetricExplorerEntry> & Pick<MetricExplorerEntry, 'key' | 'title'>): MetricExplorerEntry {
  return {
    kind: 'raw',
    description: '',
    legendFormat: '{{instance}}',
    fieldConfig: emptyFieldConfig,
    labelKeys: ['instance'],
    ...overrides,
  };
}

function renderMetricExplorer(rawEntries: MetricExplorerEntry[], selectedMetricKeys: string[] = []) {
  return render(
    <MetricExplorer
      rawEntries={rawEntries}
      selectedMetricKeys={selectedMetricKeys}
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
          entry({ key: 'raw:DCGM_FI_DEV_GPU_UTIL', title: 'DCGM_FI_DEV_GPU_UTIL', metricName: 'DCGM_FI_DEV_GPU_UTIL' }),
          entry({ key: 'raw:custom_metric', title: 'custom_metric', metricName: 'custom_metric' }),
        ]}
        selectedMetricKeys={['raw:DCGM_FI_DEV_GPU_UTIL']}
        onTogglePin={onTogglePin}
        onOpenInExplore={onOpenInExplore}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    expect(screen.getByText('Metric Explorer')).toBeInTheDocument();
    expect(screen.getByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unpin' })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'dcgm gpu' } });

    expect(screen.getByText(/DCGM_FI_DEV_GPU_UTIL/)).toBeInTheDocument();
    expect(screen.queryByText('custom_metric')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Explore' }));

    expect(onTogglePin).toHaveBeenCalledWith('raw:DCGM_FI_DEV_GPU_UTIL');
    expect(onOpenInExplore).toHaveBeenCalledWith('raw:DCGM_FI_DEV_GPU_UTIL');
  });

  it('matches incremental search tokens against metric names and sorts pinned entries before unpinned ones', () => {
    renderMetricExplorer(
      [
        entry({
          key: 'raw:DCGM_FI_DEV_GPU_UTIL',
          title: 'Accelerator Busy',
          metricName: 'DCGM_FI_DEV_GPU_UTIL',
        }),
        entry({
          key: 'raw:custom_gpu_util',
          title: 'Custom GPU Util',
          metricName: 'custom_gpu_util',
        }),
        entry({
          key: 'raw:DCGM_FI_DEV_GPU_TEMP',
          title: 'GPU Temperature',
          metricName: 'DCGM_FI_DEV_GPU_TEMP',
        }),
      ],
      ['raw:custom_gpu_util']
    );

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'dcg util' } });

    expect(screen.getByText(/Accelerator Busy/)).toBeInTheDocument();
    expect(screen.queryByText(/GPU Temperature/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'gpu util' } });

    expect(
      screen.getAllByTestId(/preview-raw:/).map((element) => element.getAttribute('data-testid'))
    ).toEqual(['preview-raw:custom_gpu_util', 'preview-raw:DCGM_FI_DEV_GPU_UTIL']);
  });

  it('filters metrics by auto-detected prefix chips and resets visible count when filters change', () => {
    renderMetricExplorer([
      ...Array.from({ length: 35 }, (_, index) =>
        entry({
          key: `raw:DCGM_FI_DEV_GPU_${index}`,
          title: `GPU Metric ${index}`,
          metricName: `DCGM_FI_DEV_GPU_${index}`,
        })
      ),
      entry({
        key: 'raw:node_cpu_seconds_total',
        title: 'node_cpu_seconds_total',
        metricName: 'node_cpu_seconds_total',
      }),
      entry({
        key: 'raw:node_memory_MemAvailable_bytes',
        title: 'node_memory_MemAvailable_bytes',
        metricName: 'node_memory_MemAvailable_bytes',
      }),
      entry({
        key: 'raw:custommetric',
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
    expect(screen.getByTestId('preview-raw:node_cpu_seconds_total')).toBeInTheDocument();
    expect(screen.getByTestId('preview-raw:node_memory_MemAvailable_bytes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'custom' }));
    expect(screen.getByTestId('preview-raw:custommetric')).toBeInTheDocument();
  });

  it('shows auto-filter controls and narrows the visible list when enabled', () => {
    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:DCGM_FI_DEV_GPU_UTIL', title: 'DCGM_FI_DEV_GPU_UTIL', metricName: 'DCGM_FI_DEV_GPU_UTIL' }),
          entry({ key: 'raw:node_load15', title: 'node_load15', metricName: 'node_load15' }),
        ]}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        onRunAutoFilter={jest.fn()}
        autoFilterStatus="success"
        autoFilteredMetricKeys={['raw:DCGM_FI_DEV_GPU_UTIL']}
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

    expect(screen.getByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-raw:node_load15')).not.toBeInTheDocument();
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
        rawEntries={[entry({ key: 'raw:DCGM_FI_DEV_GPU_UTIL', title: 'DCGM_FI_DEV_GPU_UTIL', metricName: 'DCGM_FI_DEV_GPU_UTIL' })]}
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
