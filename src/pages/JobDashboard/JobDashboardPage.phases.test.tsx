/**
 * How the Job Dashboard wires the Job phases section: what it passes to the
 * section, and that a stretch reaches the label dialog only as a draft.
 * The section itself is tested in components/JobPhasesSection.test.tsx.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JobDashboardPage } from './JobDashboardPage';
import type { ClusterSummary, JobRecord } from '../../api/types';
import { JobPhasesSection } from './components/JobPhasesSection';
import { LabelWindowModal } from './components/LabelWindowModal';

jest.mock('@grafana/ui', () => {
  const React = require('react');
  const theme = {
    colors: { border: { medium: '#ccc', weak: '#ddd' }, background: { primary: '#fff', secondary: '#f5f5f5' }, text: { primary: '#111', secondary: '#666' } },
  };
  return {
    Alert: ({ title }: { title: string }) => <div role="alert">{title}</div>,
    Button: ({ children, tooltip: _tooltip, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tooltip?: string }) => (
      <button {...props}>{children}</button>
    ),
    LoadingPlaceholder: ({ text }: { text: string }) => <div>{text}</div>,
    useStyles2: (getStyles: (value: typeof theme) => unknown) => getStyles(theme),
    // @grafana/runtime, which the page's modules import, needs these two from @grafana/ui while it loads.
    createLogger: () => ({ debug: () => undefined, error: () => undefined, info: () => undefined, warn: () => undefined }),
    attachDebugger: () => undefined,
  };
});

const listClusters = jest.fn();
const getJob = jest.fn();
const discoverJobMetrics = jest.fn();
const onTimeRangeChange = jest.fn();

jest.mock('../../api/slurmApi', () => ({
  exportDashboard: jest.fn(),
  autoFilterMetrics: jest.fn(),
  listClusters: () => listClusters(),
  getJob: (...args: unknown[]) => getJob(...args),
}));

jest.mock('./scenes/jobDashboardScene', () => ({
  buildJobDashboardScene: jest.fn(() => ({
    Component: () => <div data-testid="pinned-panels" />,
    state: {
      $timeRange: { state: { value: { from: { valueOf: () => 1700000000000 }, to: { valueOf: () => 1700003600000 } } }, onTimeRangeChange },
    },
  })),
}));

jest.mock('./scenes/metricDiscovery', () => ({
  ...jest.requireActual('./scenes/metricDiscovery'),
  discoverJobMetrics: (...args: unknown[]) => discoverJobMetrics(...args),
}));
jest.mock('./scenes/metricAutoFilter', () => ({ collectMetricAutoFilterInput: jest.fn() }));
jest.mock('./scenes/metricOutlierSort', () => ({ collectMetricOutlierScores: jest.fn().mockResolvedValue(new Map()) }));
jest.mock('./scenes/metricPanelsScene', () => ({ buildMetricPreviewScene: jest.fn(), buildExploreMetricQuery: jest.fn(), buildDashboardMetricQuery: jest.fn() }));
jest.mock('./components/MetricExplorer', () => ({ MetricExplorer: () => <div data-testid="metric-explorer" /> }));
jest.mock('./components/ExportDashboardModal', () => ({ ExportDashboardModal: () => null }));
jest.mock('./components/LabelList', () => ({ LabelList: () => <div data-testid="label-list" /> }));
jest.mock('./components/LabelWindowModal', () => ({
  LabelWindowModal: jest.fn(({ isOpen, onDismiss }: { isOpen: boolean; onDismiss: () => void }) =>
    isOpen ? (
      <div role="dialog">
        <button onClick={onDismiss}>Dismiss label dialog</button>
      </div>
    ) : null
  ),
}));

const DRAFT = { fromMs: 1700000600000, toMs: 1700000780000, category: 'phase-checkpoint', note: 'Detected by the job phase segmentation' };

jest.mock('./components/JobPhasesSection', () => ({
  JobPhasesSection: jest.fn(
    ({ onZoom, onDraftLabel }: { onZoom?: (fromMs: number, toMs: number) => void; onDraftLabel?: (draft: unknown) => void }) => (
      <div data-testid="job-phases">
        {onZoom && <button onClick={() => onZoom(1700000600000, 1700000780000)}>Zoom to stretch</button>}
        {onDraftLabel && (
          <button onClick={() => onDraftLabel({ fromMs: 1700000600000, toMs: 1700000780000, category: 'phase-checkpoint', note: 'Detected by the job phase segmentation' })}>
            Label stretch
          </button>
        )}
      </div>
    )
  ),
}));

const sectionMock = JobPhasesSection as unknown as jest.Mock;
const modalMock = LabelWindowModal as unknown as jest.Mock;

const cluster: ClusterSummary = {
  id: 'cluster-a',
  displayName: 'Cluster A',
  slurmClusterName: 'cluster_a',
  metricsDatasourceUid: 'prom-a',
  metricsType: 'prometheus',
  aggregationNodeLabels: ['host.name', 'instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'host:port',
  defaultTemplateId: 'overview',
  metricsFilterLabel: '',
  metricsFilterValue: '',
  phases: { enabled: true },
};

const job: JobRecord = {
  clusterId: 'cluster-a',
  jobId: 4242,
  name: 'train',
  user: 'user-a',
  account: 'account-a',
  partition: 'gpu',
  state: 'COMPLETED',
  nodes: ['node-a001'],
  nodeList: 'node-a001',
  nodeCount: 1,
  gpusTotal: 8,
  submitTime: 1699999900,
  startTime: 1700000000,
  endTime: 1700003600,
  exitCode: 0,
  workDir: '/work',
  tres: '',
  templateId: 'overview',
};

const meta = { jsonData: {} } as any;
const labelingMeta = { jsonData: { annotationLabeling: { enabled: true, categories: ['maintenance'] } } } as any;

function lastModalProps() {
  return modalMock.mock.calls[modalMock.mock.calls.length - 1][0];
}

describe('JobDashboardPage: Job phases', () => {
  beforeEach(() => {
    sectionMock.mockClear();
    modalMock.mockClear();
    onTimeRangeChange.mockReset();
    listClusters.mockReset().mockResolvedValue({ clusters: [cluster] });
    getJob.mockReset().mockResolvedValue(job);
    discoverJobMetrics.mockReset().mockResolvedValue([]);
    window.localStorage.clear();
  });

  it('gives the section the loaded job and cluster, without zoom or label actions when there is no panel and labeling is off', async () => {
    render(<JobDashboardPage meta={meta} clusterId="cluster-a" jobId="4242" />);
    await screen.findByTestId('job-phases');
    const props = sectionMock.mock.calls[sectionMock.mock.calls.length - 1][0];
    expect(props.job).toBe(job);
    expect(props.cluster).toBe(cluster);
    expect(props.onZoom).toBeUndefined();
    expect(props.onDraftLabel).toBeUndefined();
    expect(modalMock).not.toHaveBeenCalled();
  });

  it('does not render the section for a job that does not match the route', async () => {
    getJob.mockResolvedValue({ ...job, jobId: 9999 });
    render(<JobDashboardPage meta={meta} clusterId="cluster-a" jobId="4242" />);
    await screen.findByTestId('metric-explorer');
    expect(screen.queryByTestId('job-phases')).not.toBeInTheDocument();
  });

  it('opens the label dialog with a stretch as a draft, and forgets the draft when the dialog is dismissed', async () => {
    render(<JobDashboardPage meta={labelingMeta} clusterId="cluster-a" jobId="4242" />);
    await screen.findByTestId('job-phases');
    expect(lastModalProps().isOpen).toBe(false);
    expect(lastModalProps().initialCategory).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Label stretch' }));
    await screen.findByRole('dialog');
    expect(lastModalProps()).toMatchObject({
      isOpen: true,
      jobId: '4242',
      clusterId: 'cluster-a',
      initialRange: DRAFT,
      initialCategory: 'phase-checkpoint',
      initialNote: 'Detected by the job phase segmentation',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss label dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(lastModalProps()).toMatchObject({ isOpen: false, initialRange: { fromMs: 0, toMs: 0 } });
    expect(lastModalProps().initialCategory).toBeUndefined();
    expect(lastModalProps().initialNote).toBeUndefined();
  });

  it('zooms the panels to a stretch once a panel is shown', async () => {
    discoverJobMetrics.mockResolvedValue([
      { kind: 'raw', key: 'raw:DCGM_FI_DEV_GPU_UTIL', title: 'DCGM_FI_DEV_GPU_UTIL', description: '', legendFormat: '', fieldConfig: { defaults: {}, overrides: [] }, labelKeys: [], metricName: 'DCGM_FI_DEV_GPU_UTIL', metricType: 'gauge' },
    ]);
    window.localStorage.setItem('yuuki-slurm-app.job-dashboard-panels:cluster-a:4242', JSON.stringify(['raw:DCGM_FI_DEV_GPU_UTIL']));
    render(<JobDashboardPage meta={meta} clusterId="cluster-a" jobId="4242" />);
    await screen.findByTestId('pinned-panels');
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: 'Zoom to stretch' }));
    expect(onTimeRangeChange).toHaveBeenCalledTimes(1);
    const range = onTimeRangeChange.mock.calls[0][0];
    expect(range.from.valueOf()).toBe(1700000600000);
    expect(range.to.valueOf()).toBe(1700000780000);
  });
});
