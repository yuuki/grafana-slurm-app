import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildAutoFilterRequestKey, canReuseAutoFilterResult, canonicalizeDecimalJobId, JobDashboardPage } from './JobDashboardPage';
import type { ClusterSummary, JobRecord } from '../../api/types';
import { buildJobDashboardScene } from './scenes/jobDashboardScene';
import { LabelWindowModal } from './components/LabelWindowModal';
import { LabelList } from './components/LabelList';

jest.mock('@grafana/ui', () => {
  const React = require('react');
  const mockTheme = {
    colors: {
      border: { medium: '#ccc' },
      background: { primary: '#fff', secondary: '#f5f5f5' },
      text: { primary: '#111', secondary: '#666' },
      primary: { main: '#5794f2', transparent: 'rgba(87, 148, 242, 0.15)', text: '#1f60c4' },
    },
    spacing: (v: number) => `${v * 8}px`,
    typography: { bodySmall: { fontSize: '12px' } },
  };

  return {
    Alert: ({ title }: { title: string }) => <div>{title}</div>,
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
    Checkbox: ({ label, value, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; value?: boolean }) => (
      <label>
        <input type="checkbox" checked={Boolean(value)} {...props} />
        {label}
      </label>
    ),
    Field: ({ label, children, className }: { label?: string; children?: React.ReactNode; className?: string }) => (
      <div className={className}>
        {label && <label>{label}</label>}
        {children}
      </div>
    ),
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
    RadioButtonGroup: ({ options, value, onChange }: { options: Array<{ label: string; value: string }>; value: string; onChange: (v: string) => void }) => (
      <div role="radiogroup">
        {options.map((opt: { label: string; value: string }) => (
          <label key={opt.value}>
            <input
              type="radio"
              checked={opt.value === value}
              onChange={() => onChange(opt.value)}
            />
            {opt.label}
          </label>
        ))}
      </div>
    ),
    Select: ({ options, value, onChange, ...props }: any) => (
      <select
        aria-label={props['aria-label']}
        value={value?.value ?? ''}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          const selected = (options || []).find((o: any) => String(o.value) === e.target.value);
          if (selected) {
            onChange(selected);
          }
        }}
      >
        {(options || []).map((opt: any) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
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
const collectMetricOutlierScores = jest.fn();

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

const buildJobDashboardSceneMock = buildJobDashboardScene as jest.Mock;

jest.mock('./components/LabelWindowModal', () => ({
  LabelWindowModal: jest.fn(({ jobId, clusterId, categories, isOpen }: { jobId: string; clusterId: string; categories: string[]; isOpen: boolean }) => (
    <div
      data-testid="label-window-job-id"
      data-open={String(isOpen)}
      data-cluster={clusterId}
      data-categories={categories.join(',')}
    >
      {jobId}
      {isOpen && <input aria-label="Mock label note" defaultValue="" />}
    </div>
  )),
}));

jest.mock('./components/LabelList', () => ({
  LabelList: jest.fn(({ jobId, clusterId }: { jobId: string; clusterId: string }) => (
    <div data-testid="label-list-job-id" data-cluster={clusterId}>{jobId}</div>
  )),
}));

const labelWindowModalMock = LabelWindowModal as jest.Mock;
const labelListMock = LabelList as jest.Mock;

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

jest.mock('./scenes/metricOutlierSort', () => {
  const actual = jest.requireActual('./scenes/metricOutlierSort');
  return {
    ...actual,
    collectMetricOutlierScores: (...args: unknown[]) => collectMetricOutlierScores(...args),
  };
});

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
  const labelingMeta = {
    ...meta,
    jsonData: {
      ...meta.jsonData,
      clusters: [{ id: 'a100' }],
      annotationLabeling: {
        enabled: true,
        categories: ['maintenance'],
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
    nodeList: 'gpu-node001',
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
    labelWindowModalMock.mockClear();
    labelListMock.mockClear();
    buildJobDashboardSceneMock.mockReset();
    buildJobDashboardSceneMock.mockImplementation((_job: unknown, _cluster: unknown, _entries: unknown, displayMode: string) => ({
      Component: ({ model }: { model: { marker: string } }) => <div data-testid="pinned-panels">{model.marker}</div>,
      marker: `Pinned Panels (${displayMode})`,
    }));
    listClusters.mockReset();
    getJob.mockReset();
    discoverJobMetrics.mockReset();
    autoFilterMetrics.mockReset();
    collectMetricAutoFilterInput.mockReset();
    collectMetricOutlierScores.mockReset();
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
    collectMetricOutlierScores.mockResolvedValue(new Map([
      ['raw:DCGM_FI_DEV_GPU_UTIL', { intervalCount: 2, outlyingSeriesCount: 1 }],
    ]));
    window.localStorage.clear();
  });

  it('canonicalizes decimal job IDs without converting them to JavaScript numbers', () => {
    expect(canonicalizeDecimalJobId('00018446744073709551615')).toBe('18446744073709551615');
    expect(canonicalizeDecimalJobId('000')).toBe('0');
    expect(canonicalizeDecimalJobId('10e3')).toBeNull();
    expect(canonicalizeDecimalJobId('-1')).toBeNull();
  });

  it('waits for the route job before capturing its initial scene time range', async () => {
    const initialRange = {
      from: { valueOf: () => 1700000000000 },
      to: { valueOf: () => 1700003600000 },
    };
    const nextRange = {
      from: { valueOf: () => 1800000000000 },
      to: { valueOf: () => 1800003600000 },
    };
    buildJobDashboardSceneMock.mockImplementation(
      (builtJob: JobRecord, _cluster: unknown, _entries: unknown, displayMode: string, _series: unknown, snapshot: unknown) => ({
        Component: ({ model }: { model: { marker: string } }) => <div data-testid="pinned-panels">{model.marker}</div>,
        marker: `Pinned Panels (${displayMode})`,
        state: {
          $timeRange: {
            state: { value: snapshot ?? (builtJob.jobId === 10001 ? initialRange : nextRange) },
            onTimeRangeChange: jest.fn(),
          },
        },
      })
    );
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:20002',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );
    let resolveNextJob!: (value: JobRecord) => void;
    const pendingNextJob = new Promise<JobRecord>((resolve) => {
      resolveNextJob = resolve;
    });
    const nextJob = { ...job, jobId: 20002, name: 'next_job', startTime: 1800000000 };
    getJob.mockResolvedValueOnce(job).mockReturnValueOnce(pendingNextJob);

    const { rerender } = render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);
    await waitFor(() => expect(buildJobDashboardSceneMock).toHaveBeenCalled());
    const callCountBeforeRouteChange = buildJobDashboardSceneMock.mock.calls.length;

    rerender(<JobDashboardPage meta={meta} clusterId="a100" jobId="20002" />);

    await waitFor(() => expect(getJob).toHaveBeenLastCalledWith('a100', '20002'));
    expect(buildJobDashboardSceneMock).toHaveBeenCalledTimes(callCountBeforeRouteChange);

    resolveNextJob(nextJob);

    await waitFor(() => {
      const nextJobCall = buildJobDashboardSceneMock.mock.calls.find(([builtJob]) => builtJob === nextJob);
      expect(nextJobCall).toBeDefined();
      expect(nextJobCall?.[5]).toBeUndefined();
    });
  });

  it('builds the scene when a zero-padded route job ID matches the loaded job', async () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:0010001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="0010001" />);

    await waitFor(() => expect(getJob).toHaveBeenCalledWith('a100', '10001'));
    await waitFor(() => expect(buildJobDashboardSceneMock.mock.calls.some(([builtJob]) => builtJob === job)).toBe(true));
    const sceneCall = buildJobDashboardSceneMock.mock.calls.find(([builtJob]) => builtJob === job);
    expect(sceneCall?.[1]).toBe(cluster);
    expect(sceneCall?.[5]).toBeUndefined();
  });

  it('preserves the current time range when only the route job ID padding changes', async () => {
    const nonDefaultRange = {
      from: { valueOf: () => 1700001234000 },
      to: { valueOf: () => 1700005678000 },
    };
    buildJobDashboardSceneMock.mockImplementation(
      (_job: JobRecord, _cluster: unknown, _entries: unknown, displayMode: string, _series: unknown, snapshot: unknown) => ({
        Component: ({ model }: { model: { marker: string } }) => <div data-testid="pinned-panels">{model.marker}</div>,
        marker: `Pinned Panels (${displayMode})`,
        state: {
          $timeRange: {
            state: { value: snapshot ?? nonDefaultRange },
            onTimeRangeChange: jest.fn(),
          },
        },
      })
    );
    for (const routeJobId of ['10001', '0010001']) {
      window.localStorage.setItem(
        `yuuki-slurm-app.job-dashboard-panels:a100:${routeJobId}`,
        JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
      );
    }
    window.localStorage.setItem('yuuki-slurm-app.metric-explorer-sort-by', JSON.stringify('name'));
    getJob.mockResolvedValueOnce(job).mockReturnValueOnce(new Promise<JobRecord>(() => {}));

    const { rerender } = render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);
    await screen.findByTestId('pinned-panels');
    const callCountBeforePaddingChange = buildJobDashboardSceneMock.mock.calls.length;

    rerender(<JobDashboardPage meta={meta} clusterId="a100" jobId="0010001" />);

    const firstRebuildCall = buildJobDashboardSceneMock.mock.calls[callCountBeforePaddingChange];
    expect(firstRebuildCall).toBeDefined();
    expect(firstRebuildCall[5]).toEqual(nonDefaultRange);
  });

  it('keeps the label modal mounted without refetching when only route padding changes', async () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:0010001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );
    window.localStorage.setItem('yuuki-slurm-app.metric-explorer-sort-by', JSON.stringify('name'));
    getJob.mockResolvedValueOnce(job).mockReturnValueOnce(new Promise<JobRecord>(() => {}));

    const { rerender } = render(<JobDashboardPage meta={labelingMeta} clusterId="a100" jobId="10001" />);
    await screen.findByTestId('pinned-panels');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Label window' }));
    await waitFor(() => expect(screen.getByTestId('label-window-job-id')).toHaveAttribute('data-open', 'true'));
    const noteInput = screen.getByRole('textbox', { name: 'Mock label note' });
    fireEvent.change(noteInput, { target: { value: 'keep this note' } });

    rerender(<JobDashboardPage meta={labelingMeta} clusterId="a100" jobId="0010001" />);

    expect(screen.getByTestId('label-window-job-id')).toHaveAttribute('data-open', 'true');
    expect(screen.getByRole('textbox', { name: 'Mock label note' })).toBe(noteInput);
    expect(noteInput).toHaveValue('keep this note');
    expect(getJob).toHaveBeenCalledTimes(1);
  });

  it('uses one canonical job ID for annotation create, list, and overlay paths', async () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:0010001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );

    render(<JobDashboardPage meta={labelingMeta} clusterId="a100" jobId="0010001" />);

    await waitFor(() => expect(buildJobDashboardSceneMock).toHaveBeenCalled());
    const sceneCall = buildJobDashboardSceneMock.mock.calls.find(([, , , , , , annotationTags]) => annotationTags);
    expect(sceneCall?.[6]).toEqual([
      'slurm-app:annotation',
      'slurm-app:schema=1',
      'slurm-app:job=10001',
      'slurm-app:cluster=a100',
    ]);
    expect(screen.getByTestId('label-window-job-id')).toHaveTextContent('10001');
    expect(screen.getByTestId('label-list-job-id')).toHaveTextContent('10001');
    expect(screen.getByTestId('label-window-job-id')).toHaveAttribute('data-cluster', 'a100');
    expect(screen.getByTestId('label-window-job-id')).toHaveAttribute('data-categories', 'maintenance');
    expect(screen.getByTestId('label-list-job-id')).toHaveAttribute('data-cluster', 'a100');
  });

  it('passes no category suggestions when the generic config omits categories', async () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );
    const metaWithoutCategories = {
      ...labelingMeta,
      jsonData: {
        ...labelingMeta.jsonData,
        annotationLabeling: { enabled: true },
      },
    } as any;

    render(<JobDashboardPage meta={metaWithoutCategories} clusterId="a100" jobId="10001" />);

    await waitFor(() => expect(screen.getByTestId('label-window-job-id')).toHaveAttribute('data-categories', ''));
  });

  it('publishes annotation context only after the route job is loaded and verified', async () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:20002',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );
    let resolveNextJob!: (value: JobRecord) => void;
    const pendingNextJob = new Promise<JobRecord>((resolve) => {
      resolveNextJob = resolve;
    });
    const nextJob = { ...job, jobId: 20002, name: 'next_job' };
    getJob.mockResolvedValueOnce(job).mockReturnValueOnce(pendingNextJob);

    const { rerender } = render(<JobDashboardPage meta={labelingMeta} clusterId="a100" jobId="10001" />);
    await waitFor(() => expect(labelListMock.mock.calls.some(([props]) => props.jobId === '10001')).toBe(true));

    rerender(<JobDashboardPage meta={labelingMeta} clusterId="a100" jobId="20002" />);

    await waitFor(() => expect(getJob).toHaveBeenLastCalledWith('a100', '20002'));
    expect(labelListMock.mock.calls.some(([props]) => props.jobId === '20002')).toBe(false);
    expect(labelWindowModalMock.mock.calls.some(([props]) => props.jobId === '20002')).toBe(false);

    await act(async () => resolveNextJob(nextJob));

    await waitFor(() => expect(labelListMock.mock.calls.some(([props]) => props.jobId === '20002')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('label-window-job-id')).toHaveAttribute('data-open', 'false'));
  });

  it('does not publish an annotation namespace for an invalid route job ID', async () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL'])
    );
    getJob.mockResolvedValueOnce(job).mockReturnValueOnce(new Promise<JobRecord>(() => {}));

    const { rerender } = render(<JobDashboardPage meta={labelingMeta} clusterId="a100" jobId="10001" />);
    await waitFor(() => expect(labelListMock.mock.calls.some(([props]) => props.jobId === '10001')).toBe(true));

    rerender(<JobDashboardPage meta={labelingMeta} clusterId="a100" jobId="not-a-job" />);

    await waitFor(() => expect(getJob).toHaveBeenLastCalledWith('a100', 'not-a-job'));
    expect(labelListMock.mock.calls.some(([props]) => props.jobId === 'not-a-job')).toBe(false);
    expect(labelWindowModalMock.mock.calls.some(([props]) => props.jobId === 'not-a-job')).toBe(false);
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

  it('scores outliers after metric discovery and passes the default outlier sort into Metric Explorer', async () => {
    discoverJobMetrics.mockResolvedValueOnce([
      {
        kind: 'raw',
        key: 'raw:node_load15',
        title: 'node_load15',
        description: '',
        legendFormat: '{{instance}}',
        fieldConfig: { defaults: {}, overrides: [] },
        labelKeys: ['instance'],
        metricName: 'node_load15',
      },
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
    collectMetricOutlierScores.mockResolvedValueOnce(new Map([
      ['raw:DCGM_FI_DEV_GPU_UTIL', { intervalCount: 2, outlyingSeriesCount: 1 }],
      ['raw:node_load15', { intervalCount: 0, outlyingSeriesCount: 0 }],
    ]));

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await waitFor(() =>
      expect(collectMetricOutlierScores).toHaveBeenCalledWith(expect.objectContaining({
        cluster,
        job,
        rawEntries: expect.arrayContaining([
          expect.objectContaining({ key: 'raw:node_load15' }),
          expect.objectContaining({ key: 'raw:DCGM_FI_DEV_GPU_UTIL' }),
        ]),
      }))
    );
    await waitFor(() =>
      expect(screen.getAllByTestId(/preview-raw:/).map((element) => element.getAttribute('data-testid'))).toEqual([
        'preview-raw:DCGM_FI_DEV_GPU_UTIL',
        'preview-raw:node_load15',
      ])
    );
    expect(screen.getByLabelText('Sort by')).toHaveValue('outliers');
  });

  it('scores only the currently visible outlier candidates instead of every discovered metric', async () => {
    discoverJobMetrics.mockResolvedValueOnce(
      Array.from({ length: 34 }, (_, index) => ({
        kind: 'raw',
        key: `raw:metric_${String(index).padStart(2, '0')}`,
        title: `metric_${String(index).padStart(2, '0')}`,
        description: '',
        legendFormat: '{{instance}}',
        fieldConfig: { defaults: {}, overrides: [] },
        labelKeys: ['instance'],
        metricName: `metric_${String(index).padStart(2, '0')}`,
      }))
    );
    collectMetricOutlierScores.mockResolvedValue(new Map());

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await waitFor(() => expect(collectMetricOutlierScores).toHaveBeenCalled());
    const firstCallArgs = collectMetricOutlierScores.mock.calls[0][0];

    expect(firstCallArgs.rawEntries).toHaveLength(32);
    expect(firstCallArgs.rawEntries.map((entry: { key: string }) => entry.key)).toEqual(
      Array.from({ length: 32 }, (_, index) => `raw:metric_${String(index).padStart(2, '0')}`)
    );
  });

  it('scores only newly visible outlier candidates after loading more metrics', async () => {
    discoverJobMetrics.mockResolvedValueOnce(
      Array.from({ length: 34 }, (_, index) => ({
        kind: 'raw',
        key: `raw:metric_${String(index).padStart(2, '0')}`,
        title: `metric_${String(index).padStart(2, '0')}`,
        description: '',
        legendFormat: '{{instance}}',
        fieldConfig: { defaults: {}, overrides: [] },
        labelKeys: ['instance'],
        metricName: `metric_${String(index).padStart(2, '0')}`,
      }))
    );
    collectMetricOutlierScores.mockImplementation(({ rawEntries }) =>
      Promise.resolve(new Map(rawEntries.map((entry: { key: string }) => [entry.key, { intervalCount: 0, outlyingSeriesCount: 0 }])))
    );

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await waitFor(() => expect(collectMetricOutlierScores).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Show 2 more (32/34)' }));

    await waitFor(() => expect(collectMetricOutlierScores).toHaveBeenCalledTimes(2));
    expect(collectMetricOutlierScores.mock.calls[1][0].rawEntries.map((entry: { key: string }) => entry.key)).toEqual([
      'raw:metric_32',
      'raw:metric_33',
    ]);
  });

  it('does not retry the same outlier scoring request after a failure', async () => {
    collectMetricOutlierScores.mockRejectedValue(new Error('outlier scoring failed'));

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await screen.findByText('outlier scoring failed');
    expect(collectMetricOutlierScores).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(collectMetricOutlierScores).toHaveBeenCalledTimes(1);
  });

  it('retries outlier scoring after a failure when the user re-selects the outliers sort', async () => {
    collectMetricOutlierScores.mockRejectedValueOnce(new Error('outlier scoring failed'));

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await screen.findByText('outlier scoring failed');
    expect(collectMetricOutlierScores).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'outliers' } });

    await waitFor(() => expect(collectMetricOutlierScores).toHaveBeenCalledTimes(2));
  });

  it('does not score outliers while the saved sort option is name', async () => {
    window.localStorage.setItem('yuuki-slurm-app.metric-explorer-sort-by', JSON.stringify('name'));

    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await screen.findByTestId('preview-raw:DCGM_FI_DEV_GPU_UTIL');
    expect(screen.getByLabelText('Sort by')).toHaveValue('name');
    expect(collectMetricOutlierScores).not.toHaveBeenCalled();
  });

  it('reuses cached outlier scores when returning to the outlier sort for the same request key', async () => {
    render(<JobDashboardPage meta={meta} clusterId="a100" jobId="10001" />);

    await waitFor(() => expect(collectMetricOutlierScores).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'outliers' } });

    await waitFor(() => expect(screen.getByLabelText('Sort by')).toHaveValue('outliers'));
    expect(collectMetricOutlierScores).toHaveBeenCalledTimes(1);
  });
});
