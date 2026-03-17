import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildAutoFilterRequestKey, canReuseAutoFilterResult, JobDashboardPage } from './JobDashboardPage';
import type { ClusterSummary, JobRecord } from '../../api/types';

jest.mock('@grafana/ui', () => {
  const React = require('react');
  const mockTheme = {
    colors: {
      border: { medium: '#ccc' },
      background: { primary: '#fff', secondary: '#f5f5f5' },
      text: { primary: '#111', secondary: '#666' },
      primary: { main: '#5794f2', transparent: 'rgba(87, 148, 242, 0.15)', text: '#1f60c4' },
    },
  };

  return {
    Alert: ({ title }: { title: string }) => <div>{title}</div>,
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
    InlineSwitch: ({
      id,
      label,
      value,
      showLabel,
      ...props
    }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; showLabel?: boolean; value?: boolean }) => (
      <div>
        {showLabel ? <label htmlFor={id}>{label}</label> : null}
        <input id={id} type="checkbox" role="switch" aria-label={label} checked={Boolean(value)} {...props} />
      </div>
    ),
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    LoadingPlaceholder: ({ text }: { text: string }) => <div>{text}</div>,
    IconButton: ({ name, tooltip, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { name?: string; tooltip?: string }) => (
      <button aria-label={props['aria-label'] ?? tooltip ?? name} {...props} />
    ),
    createLogger: () => ({
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    }),
    attachDebugger: () => undefined,
    useStyles2: (getStyles: (theme: typeof mockTheme) => unknown) => (getStyles ? getStyles(mockTheme) : {}),
  };
});

const listClusters = jest.fn();
const getJob = jest.fn();
const discoverJobMetrics = jest.fn();
const autoFilterMetrics = jest.fn();
const collectMetricAutoFilterInput = jest.fn();

jest.mock('../../api/slurmApi', () => ({
  exportDashboard: jest.fn(),
  listClusters: () => listClusters(),
  getJob: (...args: unknown[]) => getJob(...args),
  autoFilterMetrics: (...args: unknown[]) => autoFilterMetrics(...args),
}));

jest.mock('./scenes/jobDashboardScene', () => ({
  buildJobDashboardScene: jest.fn((_job: unknown, _cluster: unknown, _entries: unknown, displayMode: string) => ({
    Component: ({ model }: { model: { marker: string } }) => <div data-testid="pinned-panels">{model.marker}</div>,
    marker: `Pinned Panels (${displayMode})`,
  })),
}));

jest.mock('./scenes/metricPanelsScene', () => ({
  buildMetricPreviewScene: jest.fn((_job: unknown, _cluster: unknown, entry: { key: string }, displayMode: string) => ({
    Component: ({ model }: { model: { metricKey: string; displayMode: string } }) => (
      <div data-testid={`preview-${model.metricKey}`}>{model.displayMode}</div>
    ),
    metricKey: entry.key,
    displayMode,
  })),
  buildExploreMetricQuery: jest.fn(() => ({
    title: 'GPU Utilization',
    expr: 'DCGM_FI_DEV_GPU_UTIL{instance="gpu-node001:9400"}',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    fieldConfig: { defaults: {}, overrides: [] },
  })),
}));

jest.mock('./scenes/metricDiscovery', () => {
  const actual = jest.requireActual('./scenes/metricDiscovery');
  return {
    ...actual,
    discoverJobMetrics: (...args: unknown[]) => discoverJobMetrics(...args),
  };
});

jest.mock('./scenes/metricAutoFilter', () => ({
  collectMetricAutoFilterInput: (...args: unknown[]) => collectMetricAutoFilterInput(...args),
}));

describe('JobDashboardPage', () => {
  const meta = {
    jsonData: {
      metricsifterServiceUrl: 'http://metricsifter:8000',
      metricsifterDefaultParams: {
        searchMethod: 'pelt',
        costModel: 'l2',
        penalty: 'bic',
        penaltyAdjust: 2,
        bandwidth: 2.5,
        segmentSelectionMethod: 'weighted_max',
        nJobs: 1,
        withoutSimpleFilter: false,
      },
    },
  } as any;

  const cluster: ClusterSummary = {
    id: 'a100',
    displayName: 'A100 Cluster',
    slurmClusterName: 'slurm-a100',
    metricsDatasourceUid: 'prom-main',
    metricsType: 'prometheus',
    aggregationNodeLabels: ['host.name', 'instance'],
    instanceLabel: 'instance',
    nodeMatcherMode: 'host:port',
    defaultTemplateId: 'distributed-training',
    metricsFilterLabel: 'cluster',
    metricsFilterValue: 'slurm-a100',
  };

  const job: JobRecord = {
    clusterId: 'a100',
    jobId: 10001,
    name: 'train_llm',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'RUNNING',
    nodes: ['gpu-node001'],
    nodeCount: 1,
    gpusTotal: 8,
    startTime: 1700000000,
    endTime: 0,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1001=gres/gpu:8',
    templateId: 'distributed-training',
  };

  beforeEach(() => {
    listClusters.mockReset();
    getJob.mockReset();
    discoverJobMetrics.mockReset();
    autoFilterMetrics.mockReset();
    collectMetricAutoFilterInput.mockReset();
    listClusters.mockResolvedValue({ clusters: [cluster] });
    getJob.mockResolvedValue(job);
    discoverJobMetrics.mockResolvedValue([
      {
        kind: 'raw',
        key: 'raw:DCGM_FI_DEV_GPU_UTIL',
        title: 'DCGM_FI_DEV_GPU_UTIL',
        description: '',
        legendFormat: '{{instance}} / GPU {{gpu}}',
        fieldConfig: { defaults: {}, overrides: [] },
        labelKeys: ['instance', 'gpu'],
        metricName: 'DCGM_FI_DEV_GPU_UTIL',
      },
    ]);
    collectMetricAutoFilterInput.mockResolvedValue({
      clusterId: 'a100',
      jobId: '10001',
      timestamps: [1700000000000, 1700000060000],
      series: [
        {
          seriesId: 'gpu:DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400',
          metricKey: 'raw:DCGM_FI_DEV_GPU_UTIL',
          metricName: 'DCGM_FI_DEV_GPU_UTIL',
          values: [20, 40],
        },
      ],
    });
    autoFilterMetrics.mockResolvedValue({
      selectedMetricKeys: ['raw:DCGM_FI_DEV_GPU_UTIL'],
      selectedSeriesIds: ['DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400'],
      selectedSeriesCount: 1,
      totalSeriesCount: 1,
      selectedMetricCount: 1,
      totalMetricCount: 1,
    });
    window.localStorage.clear();
  });

  it('does not render the pinned area until a metric is pinned', async () => {
    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    const metadataTitle = await screen.findByText('Job metadata');
    const explorerTitle = await screen.findByText('Metric Explorer');

    await waitFor(() => expect(screen.getByText('train_llm')).toBeInTheDocument());
    expect(screen.queryByTestId('pinned-panels')).not.toBeInTheDocument();
    expect(metadataTitle.compareDocumentPosition(explorerTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders job metadata, pinned panels, and metric explorer in that order', async () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    const metadataTitle = await screen.findByText('Job metadata');
    const explorerTitle = await screen.findByText('Metric Explorer');
    const pinnedPanels = await screen.findByTestId('pinned-panels');

    await waitFor(() => expect(screen.getByText('train_llm')).toBeInTheDocument());
    expect(screen.getByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL')).toHaveTextContent('aggregated');
    expect(pinnedPanels).toHaveTextContent('Pinned Panels (aggregated)');
    expect(metadataTitle.compareDocumentPosition(pinnedPanels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pinnedPanels.compareDocumentPosition(explorerTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('Recommended views')).not.toBeInTheDocument();
  });

  it('runs auto filter when the toggle is enabled and shows the result summary', async () => {
    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await screen.findByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL');
    fireEvent.click(await screen.findByRole('switch', { name: 'Auto filter' }));

    await waitFor(() =>
      expect(autoFilterMetrics).toHaveBeenCalledWith({
        clusterId: 'a100',
        jobId: '10001',
        timestamps: [1700000000000, 1700000060000],
        series: [
          {
            seriesId: 'gpu:DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400',
            metricKey: 'raw:DCGM_FI_DEV_GPU_UTIL',
            metricName: 'DCGM_FI_DEV_GPU_UTIL',
            values: [20, 40],
          },
        ],
        params: {
          searchMethod: 'pelt',
          costModel: 'l2',
          penalty: 'bic',
          penaltyAdjust: 2,
          bandwidth: 2.5,
          segmentSelectionMethod: 'weighted_max',
          nJobs: 1,
          withoutSimpleFilter: false,
        },
      })
    );

    expect(screen.getByText('Auto filter selected 1 of 1 series across 1 of 1 metrics.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Auto filter' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Run auto filter' })).not.toBeInTheDocument();
  });

  it('uses saved runtime overrides when custom settings are enabled', async () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.metricsifter-runtime-overrides',
      JSON.stringify({
        enabled: true,
        params: {
          searchMethod: 'bottomup',
          costModel: 'rbf',
          penalty: 8,
          penaltyAdjust: 3,
          bandwidth: 4.5,
          segmentSelectionMethod: 'max',
          nJobs: -1,
          withoutSimpleFilter: true,
        },
      })
    );

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await screen.findByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL');
    fireEvent.click(await screen.findByRole('switch', { name: 'Auto filter' }));

    await waitFor(() =>
      expect(autoFilterMetrics).toHaveBeenCalledWith(expect.objectContaining({
        params: {
          searchMethod: 'bottomup',
          costModel: 'rbf',
          penalty: 8,
          penaltyAdjust: 3,
          bandwidth: 4.5,
          segmentSelectionMethod: 'max',
          nJobs: -1,
          withoutSimpleFilter: true,
        },
      }))
    );
  });

  it('turns auto filter back off when the request fails', async () => {
    autoFilterMetrics.mockRejectedValueOnce(new Error('metricsifter unavailable'));

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await screen.findByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL');
    fireEvent.click(await screen.findByRole('switch', { name: 'Auto filter' }));

    await waitFor(() => expect(autoFilterMetrics).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('metricsifter unavailable')).toBeInTheDocument());
    expect(screen.getByRole('switch', { name: 'Auto filter' })).not.toBeChecked();
  });

  it('turns auto filter back off when metricsifter returns no matching metrics', async () => {
    autoFilterMetrics.mockResolvedValueOnce({
      selectedMetricKeys: [],
      selectedSeriesIds: [],
      selectedSeriesCount: 0,
      totalSeriesCount: 1,
      selectedMetricCount: 0,
      totalMetricCount: 1,
    });

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await screen.findByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL');
    fireEvent.click(await screen.findByRole('switch', { name: 'Auto filter' }));

    await waitFor(() => expect(autoFilterMetrics).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Auto filter selected 0 of 1 series across 0 of 1 metrics.')).toBeInTheDocument());
    expect(screen.getByRole('switch', { name: 'Auto filter' })).not.toBeChecked();
    expect(screen.getByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL')).toBeInTheDocument();
  });

  it('does not reuse cached auto-filter results for running jobs', () => {
    const requestKey = buildAutoFilterRequestKey({
      clusterId: 'a100',
      jobId: '10001',
      metricKeys: ['raw:DCGM_FI_DEV_GPU_UTIL'],
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      params: meta.jsonData.metricsifterDefaultParams,
      filterGranularity: 'disaggregated' as const,
    });

    expect(
      canReuseAutoFilterResult(
        job,
        requestKey,
        requestKey,
        {
          selectedMetricKeys: ['raw:DCGM_FI_DEV_GPU_UTIL'],
          selectedSeriesCount: 1,
          totalSeriesCount: 1,
          selectedMetricCount: 1,
          totalMetricCount: 1,
        }
      )
    ).toBe(false);
  });

  it('treats different time ranges as different auto-filter cache keys', () => {
    const baseInput = {
      clusterId: 'a100',
      jobId: '10001',
      metricKeys: ['raw:DCGM_FI_DEV_GPU_UTIL'],
      params: meta.jsonData.metricsifterDefaultParams,
      filterGranularity: 'disaggregated' as const,
    };

    expect(
      buildAutoFilterRequestKey({
        ...baseInput,
        timeRange: { from: '2023-11-14T22:13:20.000Z', to: '2023-11-14T22:14:20.000Z' },
      })
    ).not.toBe(
      buildAutoFilterRequestKey({
        ...baseInput,
        timeRange: { from: '2023-11-14T22:13:20.000Z', to: '2023-11-14T22:15:20.000Z' },
      })
    );
  });

  it('does not rerun auto filter for every settings edit while enabled', async () => {
    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await screen.findByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL');
    fireEvent.click(await screen.findByRole('switch', { name: 'Auto filter' }));
    await waitFor(() => expect(autoFilterMetrics).toHaveBeenCalled());
    autoFilterMetrics.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Auto-filter settings' }));
    fireEvent.click(screen.getByLabelText('Use custom settings'));
    fireEvent.change(screen.getByLabelText('Penalty adjust'), { target: { value: '4' } });

    await waitFor(() => expect(screen.getByLabelText('Penalty adjust')).toHaveValue(4));
    expect(autoFilterMetrics).not.toHaveBeenCalled();
  });

  it('starts in aggregated mode and lets the user switch previews and pinned panels back to raw', async () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    expect(await screen.findByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL')).toHaveTextContent('aggregated');
    expect(await screen.findByTestId('pinned-panels')).toHaveTextContent('Pinned Panels (aggregated)');

    fireEvent.click(screen.getByRole('radio', { name: 'Raw' }));

    await waitFor(() => expect(screen.getByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL')).toHaveTextContent('raw'));
    expect(await screen.findByTestId('pinned-panels')).toHaveTextContent('Pinned Panels (raw)');
  });
});
