import { dateMath, dateTime, TimeRange } from '@grafana/data';
import { loadTimelineTimeRange, saveTimelineTimeRange } from '../../storage/userPreferences';

export const DEFAULT_TIMELINE_RAW_FROM = 'now-24h';
export const DEFAULT_TIMELINE_RAW_TO = 'now';

export interface ResolvedTimelineRange {
  from: number;
  to: number;
}

export function makeRelativeTimeRange(rawFrom: string, rawTo: string): TimeRange {
  return {
    from: dateMath.parse(rawFrom, false)!,
    to: dateMath.parse(rawTo, true)!,
    raw: { from: rawFrom, to: rawTo },
  };
}

export function makeAbsoluteTimeRange(fromMs: number, toMs: number): TimeRange {
  const from = dateTime(fromMs);
  const to = dateTime(toMs);
  return { from, to, raw: { from, to } };
}

export function loadInitialTimelineTimeRange(): TimeRange {
  const saved = loadTimelineTimeRange();
  return makeRelativeTimeRange(saved?.from ?? DEFAULT_TIMELINE_RAW_FROM, saved?.to ?? DEFAULT_TIMELINE_RAW_TO);
}

export function persistTimelineTimeRange(range: TimeRange): void {
  const rawFrom = typeof range.raw.from === 'string' ? range.raw.from : range.raw.from.toISOString();
  const rawTo = typeof range.raw.to === 'string' ? range.raw.to : range.raw.to.toISOString();
  saveTimelineTimeRange(rawFrom, rawTo);
}

export function resolveTimelineRange(range: TimeRange): ResolvedTimelineRange {
  const from = dateMath.parse(range.raw.from, false);
  const to = dateMath.parse(range.raw.to, true);
  return {
    from: (from ?? range.from).unix(),
    to: (to ?? range.to).unix(),
  };
}
