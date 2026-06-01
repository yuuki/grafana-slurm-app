import { dateMath, dateTime, TimeRange } from '@grafana/data';
import { loadTimelineTimeRange, saveTimelineTimeRange } from '../../storage/userPreferences';
import { timelineRangeFromURLParams, TimelineRangeURLParams } from './model';

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

export function loadInitialTimelineTimeRange(params = new URLSearchParams(window.location.search)): TimeRange {
  const timelineRange = timelineRangeFromURLParams(params);
  if (timelineRange && canParseTimeRange(timelineRange.from, timelineRange.to)) {
    return makeRelativeTimeRange(timelineRange.from, timelineRange.to);
  }

  const saved = loadTimelineTimeRange();
  return makeRelativeTimeRange(saved?.from ?? DEFAULT_TIMELINE_RAW_FROM, saved?.to ?? DEFAULT_TIMELINE_RAW_TO);
}

function canParseTimeRange(rawFrom: string, rawTo: string): boolean {
  return dateMath.isValid(rawFrom) && dateMath.isValid(rawTo);
}

export function timelineRangeToRawValues(range: TimeRange): TimelineRangeURLParams {
  return {
    from: typeof range.raw.from === 'string' ? range.raw.from : range.raw.from.toISOString(),
    to: typeof range.raw.to === 'string' ? range.raw.to : range.raw.to.toISOString(),
  };
}

export function persistTimelineTimeRange(range: TimeRange): void {
  const rawValues = timelineRangeToRawValues(range);
  saveTimelineTimeRange(rawValues.from, rawValues.to);
}

export function resolveTimelineRange(range: TimeRange): ResolvedTimelineRange {
  const from = dateMath.parse(range.raw.from, false);
  const to = dateMath.parse(range.raw.to, true);
  return {
    from: (from ?? range.from).unix(),
    to: (to ?? range.to).unix(),
  };
}
