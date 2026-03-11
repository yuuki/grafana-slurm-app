export type JobStateBadgeColor = 'green' | 'red' | 'orange' | 'blue';

interface JobStateLegendItem {
  color: string;
  label: string;
}

const RUNNING_COLOR = '#56A64B';
const COMPLETED_COLOR = '#3274D9';
const FAILED_COLOR = '#E24D42';
const WAITING_COLOR = '#FF9830';
const STOPPED_COLOR = '#8E8E96';

export const jobTimelineLegend: JobStateLegendItem[] = [
  { color: RUNNING_COLOR, label: 'Running' },
  { color: COMPLETED_COLOR, label: 'Completed' },
  { color: FAILED_COLOR, label: 'Failed' },
  { color: WAITING_COLOR, label: 'Pending / Suspended / Timeout' },
  { color: STOPPED_COLOR, label: 'Cancelled / Preempted' },
];

export function getJobStateBadgeColor(state: string): JobStateBadgeColor {
  switch (state) {
    case 'RUNNING':
      return 'green';
    case 'FAILED':
    case 'NODE_FAIL':
      return 'red';
    case 'PENDING':
    case 'SUSPENDED':
    case 'TIMEOUT':
      return 'orange';
    default:
      return 'blue';
  }
}

export function getJobStateTimelineColor(state: string): string {
  switch (state) {
    case 'RUNNING':
      return RUNNING_COLOR;
    case 'COMPLETED':
      return COMPLETED_COLOR;
    case 'FAILED':
    case 'NODE_FAIL':
      return FAILED_COLOR;
    case 'PENDING':
    case 'SUSPENDED':
    case 'TIMEOUT':
      return WAITING_COLOR;
    case 'CANCELLED':
    case 'PREEMPTED':
      return STOPPED_COLOR;
    default:
      return COMPLETED_COLOR;
  }
}
