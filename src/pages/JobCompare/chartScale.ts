import { formatDuration } from '../JobSearch/jobTime';
import { CompareXAxis } from './model';

export const CHART_VIEWBOX_WIDTH = 1000;

export function scaleValue(value: number, domain: [number, number], range: [number, number]): number {
  const span = domain[1] - domain[0];
  if (span === 0) {
    return range[0];
  }
  return range[0] + ((value - domain[0]) / span) * (range[1] - range[0]);
}

function fmt(n: number): string {
  return String(Number(n.toFixed(2)));
}

function point(
  x: number,
  y: number,
  xDomain: [number, number],
  yDomain: [number, number],
  width: number,
  height: number
): string {
  return `${fmt(scaleValue(x, xDomain, [0, width]))} ${fmt(scaleValue(y, yDomain, [height, 0]))}`;
}

export function buildLinePath(
  x: number[],
  y: number[],
  xDomain: [number, number],
  yDomain: [number, number],
  width: number,
  height: number
): string {
  const parts: string[] = [];
  let penDown = false;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(y[i])) {
      penDown = false;
      continue;
    }
    parts.push(`${penDown ? 'L' : 'M'}${point(x[i], y[i], xDomain, yDomain, width, height)}`);
    penDown = true;
  }
  return parts.join(' ');
}

export function buildBandPath(
  x: number[],
  min: number[],
  max: number[],
  xDomain: [number, number],
  yDomain: [number, number],
  width: number,
  height: number
): string {
  const segments: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(min[i]) && Number.isFinite(max[i])) {
      current.push(i);
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments
    .filter((segment) => segment.length > 1)
    .map((segment) => {
      const top = segment.map((i) => point(x[i], max[i], xDomain, yDomain, width, height));
      const bottom = [...segment].reverse().map((i) => point(x[i], min[i], xDomain, yDomain, width, height));
      return `M${top.join(' L')} L${bottom.join(' L')} Z`;
    })
    .join(' ');
}

export function formatXValue(x: number, axis: CompareXAxis): string {
  switch (axis) {
    case 'progress':
      return `${Math.round(x)}%`;
    case 'absolute':
      return new Date(x * 1000).toISOString().slice(0, 16).replace('T', ' ');
    default:
      return formatDuration(Math.round(x));
  }
}

export function formatValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  const abs = Math.abs(value);
  if (abs >= 1e9) {
    return `${(value / 1e9).toFixed(1)}G`;
  }
  if (abs >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (abs >= 1e3) {
    return `${(value / 1e3).toFixed(1)}k`;
  }
  if (abs >= 100) {
    return value.toFixed(0);
  }
  if (abs >= 1) {
    return value.toFixed(1);
  }
  return value.toFixed(3);
}
