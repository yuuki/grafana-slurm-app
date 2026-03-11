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
  it('renders raw metrics, recommended views, and filters the raw list by search text', () => {
    const onTogglePin = jest.fn();
    const onOpenInExplore = jest.fn();

    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL', title: 'GPU Utilization', matcherKind: 'gpu' }),
          entry({ key: 'raw:node:custom_metric', title: 'custom_metric' }),
        ]}
        recommendedEntries={[entry({ kind: 'view', key: 'view:disk-read', title: 'Disk Read' })]}
        selectedMetricKeys={['raw:gpu:DCGM_FI_DEV_GPU_UTIL']}
        onTogglePin={onTogglePin}
        onOpenInExplore={onOpenInExplore}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    expect(screen.getByText('Metric Explorer')).toBeInTheDocument();
    expect(screen.getByText('Recommended views')).toBeInTheDocument();
    expect(screen.getByTestId('preview-raw:gpu:DCGM_FI_DEV_GPU_UTIL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unpin' })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'gpu' } });

    expect(screen.getByText(/GPU Utilization/)).toBeInTheDocument();
    expect(screen.queryByText('custom_metric')).not.toBeInTheDocument();
    expect(screen.getByText(/Disk Read/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    const openButtons = screen.getAllByRole('button', { name: 'Open in Explore' });
    fireEvent.click(openButtons[openButtons.length - 1]);

    expect(onTogglePin).toHaveBeenCalledWith('raw:gpu:DCGM_FI_DEV_GPU_UTIL');
    expect(onOpenInExplore).toHaveBeenCalledWith('view:disk-read');
  });

  it('matches incremental search tokens across metric titles while keeping recommended views visible', () => {
    render(
      <MetricExplorer
        rawEntries={[
          entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL', title: 'GPU Utilization', matcherKind: 'gpu' }),
          entry({ key: 'raw:gpu:DCGM_FI_DEV_GPU_TEMP', title: 'GPU Temperature', matcherKind: 'gpu' }),
          entry({ key: 'raw:node:custom_metric', title: 'custom_metric' }),
        ]}
        recommendedEntries={[entry({ kind: 'view', key: 'view:disk-read', title: 'Disk Read' })]}
        selectedMetricKeys={[]}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'gpu li' } });

    expect(screen.getByText('GPU Utilization')).toBeInTheDocument();
    expect(screen.queryByText('GPU Temperature')).not.toBeInTheDocument();
    expect(screen.queryByText('custom_metric')).not.toBeInTheDocument();
    expect(screen.getByText('Disk Read')).toBeInTheDocument();
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
        recommendedEntries={[]}
        selectedMetricKeys={['raw:node:custom_gpu_util']}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'dcg util' } });

    expect(screen.getByText('Accelerator Busy')).toBeInTheDocument();
    expect(screen.queryByText('GPU Temperature')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search metrics'), { target: { value: 'gpu util' } });

    expect(
      screen.getAllByTestId(/preview-raw:/).map((element) => element.getAttribute('data-testid'))
    ).toEqual(['preview-raw:node:custom_gpu_util', 'preview-raw:gpu:DCGM_FI_DEV_GPU_UTIL']);
  });
});
