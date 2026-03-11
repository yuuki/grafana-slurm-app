import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { JobDashboardPage } from './JobDashboardPage';
import type { ClusterSummary, JobRecord } from '../../api/types';

const listClusters = jest.fn();
const getJob = jest.fn();
const discoverJobMetrics = jest.fn();

jest.mock('../../api/slurmApi', () => ({
  exportDashboard: jest.fn(),
  listClusters: () => listClusters(),
  getJob: (...args: unknown[]) => getJob(...args),
}));

jest.mock('./scenes/jobDashboardScene', () => ({
  buildJobDashboardScene: jest.fn(() => ({
    Component: ({ model }: { model: { marker: string } }) => <div data-testid="pinned-panels">{model.marker}</div>,
    marker: 'Pinned Panels',
  })),
}));

jest.mock('./scenes/metricPanelsScene', () => ({
  buildMetricPreviewScene: jest.fn((_job: unknown, _cluster: unknown, metricKey: string) => ({
    Component: ({ model }: { model: { metricKey: string } }) => <div data-testid={`preview-${model.metricKey}`}>preview</div>,
    metricKey,
  })),
  buildMetricQuery: jest.fn(() => ({
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

describe('JobDashboardPage', () => {
  const cluster: ClusterSummary = {
    id: 'a100',
    displayName: 'A100 Cluster',
    slurmClusterName: 'slurm-a100',
    metricsDatasourceUid: 'prom-main',
    metricsType: 'prometheus',
    instanceLabel: 'instance',
    nodeExporterPort: '9100',
    dcgmExporterPort: '9400',
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
    listClusters.mockResolvedValue({ clusters: [cluster] });
    getJob.mockResolvedValue(job);
    discoverJobMetrics.mockResolvedValue({
      entries: [
        {
          kind: 'raw',
          key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
          matcherKind: 'gpu',
          title: 'GPU Utilization',
          description: 'Per-GPU utilization by node.',
          legendFormat: '{{instance}} / GPU {{gpu}}',
          fieldConfig: { defaults: {}, overrides: [] },
          labelKeys: ['instance', 'gpu'],
          metricName: 'DCGM_FI_DEV_GPU_UTIL',
        },
      ],
      recommended: [
        {
          kind: 'view',
          key: 'view:disk-read',
          matcherKind: 'node',
          title: 'Disk Read',
          description: 'Disk read throughput by node and device.',
          legendFormat: '{{instance}} {{device}}',
          fieldConfig: { defaults: {}, overrides: [] },
          labelKeys: [],
          viewId: 'disk-read',
        },
      ],
    });
    window.localStorage.clear();
  });

  it('renders job metadata above the metric explorer and shows preview panels', async () => {
    render(<JobDashboardPage meta={{} as any} clusterId="a100" jobId="10001" />);

    const metadataTitle = await screen.findByText('Job metadata');
    const explorerTitle = await screen.findByText('Metric Explorer');

    await waitFor(() => expect(screen.getByText('train_llm')).toBeInTheDocument());
    expect(screen.getByTestId('preview-raw:gpu:DCGM_FI_DEV_GPU_UTIL')).toBeInTheDocument();
    expect(screen.getByTestId('pinned-panels')).toHaveTextContent('Pinned Panels');
    expect(metadataTitle.compareDocumentPosition(explorerTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
