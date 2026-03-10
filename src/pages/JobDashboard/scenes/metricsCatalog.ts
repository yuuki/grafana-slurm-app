import { FieldConfigSource, ThresholdsMode } from '@grafana/data';

export type JobMetricCategory = 'gpu' | 'cpu-memory' | 'network' | 'disk';
type MatcherKind = 'gpu' | 'node';

export interface JobMetricDefinition {
  id: string;
  title: string;
  description: string;
  category: JobMetricCategory;
  matcherKind: MatcherKind;
  legendFormat: string;
  buildExpr: (matcher: string, instanceLabel: string) => string;
  fieldConfig: Pick<FieldConfigSource, 'defaults' | 'overrides'>;
}

export interface JobMetricGroup {
  category: JobMetricCategory;
  title: string;
  metrics: JobMetricDefinition[];
}

const GPU_METRICS: JobMetricDefinition[] = [
  {
    id: 'gpu-utilization',
    title: 'GPU Utilization',
    description: 'Per-GPU utilization by node.',
    category: 'gpu',
    matcherKind: 'gpu',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    buildExpr: (matcher) => `DCGM_FI_DEV_GPU_UTIL{${matcher}}`,
    fieldConfig: { defaults: { unit: 'percent', min: 0, max: 100 }, overrides: [] },
  },
  {
    id: 'gpu-memory-used',
    title: 'GPU Memory Used',
    description: 'Framebuffer memory used per GPU.',
    category: 'gpu',
    matcherKind: 'gpu',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    buildExpr: (matcher) => `DCGM_FI_DEV_FB_USED{${matcher}}`,
    fieldConfig: { defaults: { unit: 'decmbytes' }, overrides: [] },
  },
  {
    id: 'gpu-temperature',
    title: 'GPU Temperature',
    description: 'Temperature trend per GPU.',
    category: 'gpu',
    matcherKind: 'gpu',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    buildExpr: (matcher) => `DCGM_FI_DEV_GPU_TEMP{${matcher}}`,
    fieldConfig: {
      defaults: {
        unit: 'celsius',
        thresholds: {
          mode: ThresholdsMode.Absolute,
          steps: [
            { color: 'green', value: -Infinity },
            { color: 'orange', value: 75 },
            { color: 'red', value: 85 },
          ],
        },
      },
      overrides: [],
    },
  },
  {
    id: 'gpu-power-usage',
    title: 'GPU Power Usage',
    description: 'Power draw per GPU.',
    category: 'gpu',
    matcherKind: 'gpu',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    buildExpr: (matcher) => `DCGM_FI_DEV_POWER_USAGE{${matcher}}`,
    fieldConfig: { defaults: { unit: 'watt' }, overrides: [] },
  },
  {
    id: 'sm-clock',
    title: 'SM Clock',
    description: 'Streaming multiprocessor clock frequency.',
    category: 'gpu',
    matcherKind: 'gpu',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    buildExpr: (matcher) => `DCGM_FI_DEV_SM_CLOCK{${matcher}}`,
    fieldConfig: { defaults: { unit: 'hertz' }, overrides: [] },
  },
  {
    id: 'nvlink-bandwidth',
    title: 'NVLink Bandwidth',
    description: 'Total NVLink bandwidth across devices.',
    category: 'gpu',
    matcherKind: 'gpu',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    buildExpr: (matcher) => `DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL{${matcher}}`,
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
  },
];

const CPU_MEMORY_METRICS: JobMetricDefinition[] = [
  {
    id: 'cpu-utilization',
    title: 'CPU Utilization',
    description: 'Average CPU utilization per node.',
    category: 'cpu-memory',
    matcherKind: 'node',
    legendFormat: '{{instance}}',
    buildExpr: (matcher, instanceLabel) =>
      `100 - (avg by(${instanceLabel})(rate(node_cpu_seconds_total{mode="idle",${matcher}}[5m])) * 100)`,
    fieldConfig: { defaults: { unit: 'percent', min: 0, max: 100 }, overrides: [] },
  },
  {
    id: 'memory-usage',
    title: 'Memory Usage',
    description: 'Used system memory per node.',
    category: 'cpu-memory',
    matcherKind: 'node',
    legendFormat: '{{instance}}',
    buildExpr: (matcher) => `node_memory_MemTotal_bytes{${matcher}} - node_memory_MemAvailable_bytes{${matcher}}`,
    fieldConfig: { defaults: { unit: 'bytes' }, overrides: [] },
  },
  {
    id: 'load-average-15m',
    title: 'Load Average (15m)',
    description: 'Node load average over 15 minutes.',
    category: 'cpu-memory',
    matcherKind: 'node',
    legendFormat: '{{instance}}',
    buildExpr: (matcher) => `node_load15{${matcher}}`,
    fieldConfig: { defaults: {}, overrides: [] },
  },
  {
    id: 'memory-utilization',
    title: 'Memory Utilization %',
    description: 'Memory usage ratio per node.',
    category: 'cpu-memory',
    matcherKind: 'node',
    legendFormat: '{{instance}}',
    buildExpr: (matcher) =>
      `100 * (1 - node_memory_MemAvailable_bytes{${matcher}} / node_memory_MemTotal_bytes{${matcher}})`,
    fieldConfig: { defaults: { unit: 'percent', min: 0, max: 100 }, overrides: [] },
  },
];

const NETWORK_METRICS: JobMetricDefinition[] = [
  {
    id: 'network-receive',
    title: 'Network Receive',
    description: 'Ingress throughput by node and device.',
    category: 'network',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    buildExpr: (matcher) => `rate(node_network_receive_bytes_total{device!="lo",${matcher}}[5m])`,
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
  },
  {
    id: 'network-transmit',
    title: 'Network Transmit',
    description: 'Egress throughput by node and device.',
    category: 'network',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    buildExpr: (matcher) => `rate(node_network_transmit_bytes_total{device!="lo",${matcher}}[5m])`,
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
  },
  {
    id: 'infiniband-receive',
    title: 'InfiniBand Receive',
    description: 'InfiniBand ingress throughput.',
    category: 'network',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    buildExpr: (matcher) => `rate(node_infiniband_port_data_received_bytes_total{${matcher}}[5m])`,
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
  },
  {
    id: 'infiniband-transmit',
    title: 'InfiniBand Transmit',
    description: 'InfiniBand egress throughput.',
    category: 'network',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    buildExpr: (matcher) => `rate(node_infiniband_port_data_transmitted_bytes_total{${matcher}}[5m])`,
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
  },
];

const DISK_METRICS: JobMetricDefinition[] = [
  {
    id: 'disk-read',
    title: 'Disk Read',
    description: 'Disk read throughput by node and device.',
    category: 'disk',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    buildExpr: (matcher) => `rate(node_disk_read_bytes_total{${matcher}}[5m])`,
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
  },
  {
    id: 'disk-write',
    title: 'Disk Write',
    description: 'Disk write throughput by node and device.',
    category: 'disk',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    buildExpr: (matcher) => `rate(node_disk_written_bytes_total{${matcher}}[5m])`,
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
  },
  {
    id: 'disk-read-iops',
    title: 'Disk Read IOPS',
    description: 'Read IOPS by node and device.',
    category: 'disk',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    buildExpr: (matcher) => `rate(node_disk_reads_completed_total{${matcher}}[5m])`,
    fieldConfig: { defaults: { unit: 'iops' }, overrides: [] },
  },
  {
    id: 'disk-write-iops',
    title: 'Disk Write IOPS',
    description: 'Write IOPS by node and device.',
    category: 'disk',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    buildExpr: (matcher) => `rate(node_disk_writes_completed_total{${matcher}}[5m])`,
    fieldConfig: { defaults: { unit: 'iops' }, overrides: [] },
  },
];

const JOB_METRICS_CATALOG: JobMetricGroup[] = [
  { category: 'gpu', title: 'GPU', metrics: GPU_METRICS },
  { category: 'cpu-memory', title: 'CPU / Memory', metrics: CPU_MEMORY_METRICS },
  { category: 'network', title: 'Network / InfiniBand', metrics: NETWORK_METRICS },
  { category: 'disk', title: 'Disk I/O', metrics: DISK_METRICS },
];

export function getJobMetricsCatalog(): JobMetricGroup[] {
  return JOB_METRICS_CATALOG;
}

export function getJobMetricDefinition(id: string): JobMetricDefinition | undefined {
  return JOB_METRICS_CATALOG.flatMap((group) => group.metrics).find((metric) => metric.id === id);
}

export function filterKnownJobMetricIds(metricIds: string[]): string[] {
  return metricIds.filter((id, index) => index === metricIds.indexOf(id) && Boolean(getJobMetricDefinition(id)));
}
