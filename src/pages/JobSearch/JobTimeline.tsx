import React, { useState } from 'react';
import { SelectableValue } from '@grafana/data';
import { LoadingPlaceholder, RadioButtonGroup, useTheme2 } from '@grafana/ui';
import { JobRecord } from '../../api/types';
import { formatDuration, formatTimestamp } from './jobTime';
import { getJobStateTimelineColor, jobTimelineLegend } from './jobStateStyles';

interface Props {
  jobs: JobRecord[];
  loading: boolean;
  onOpenJob: (clusterId: string, jobId: number) => void;
}

interface TimelineJob extends JobRecord {
  effectiveEndTime: number;
}

const TIMELINE_HEIGHT = 360;
const TIMELINE_LABEL_COLUMN_WIDTH = 220;
const TIMELINE_MIN_WIDTH = 640;
const TIMELINE_MIN_RANGE_SECONDS = 60;

type TimelineRangeKey = 'auto' | '1h' | '6h' | '24h' | '7d' | '30d';

const TIMELINE_RANGE_OPTIONS: Array<SelectableValue<TimelineRangeKey>> = [
  { label: 'Auto', value: 'auto' },
  { label: '1h', value: '1h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
];

const RANGE_SECONDS: Record<Exclude<TimelineRangeKey, 'auto'>, number> = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
};

function buildBarLabel(job: TimelineJob, widthPct: number): string {
  const nodeLabel = `${job.nodeCount} node${job.nodeCount === 1 ? '' : 's'}`;
  if (widthPct >= 50) {
    return `${job.partition} / ${job.user} / ${nodeLabel}`;
  }
  if (widthPct >= 15) {
    return `${job.partition} / ${job.user}`;
  }
  if (widthPct >= 5) {
    return job.partition;
  }
  return '';
}

function buildBarTitle(job: TimelineJob): string {
  return [
    `Job ID: ${job.jobId}`,
    `Name: ${job.name}`,
    `State: ${job.state}`,
    `Partition: ${job.partition}`,
    `User: ${job.user}`,
    `Nodes: ${job.nodeCount}`,
    `Start: ${formatTimestamp(job.startTime)}`,
    `End: ${job.endTime > 0 ? formatTimestamp(job.endTime) : 'In progress'}`,
    `Elapsed: ${formatDuration(job.effectiveEndTime - job.startTime)}`,
  ].join('\n');
}

function buildTicks(start: number, end: number): number[] {
  const range = end - start;
  return Array.from({ length: 5 }, (_, index) => start + Math.round((range * index) / 4));
}

export function JobTimeline({ jobs, loading, onOpenJob }: Props) {
  const theme = useTheme2();
  const [rangeKey, setRangeKey] = useState<TimelineRangeKey>('auto');

  if (loading) {
    return <LoadingPlaceholder text="Loading job timeline..." />;
  }

  const now = Math.floor(Date.now() / 1000);
  const timelineJobs: TimelineJob[] = jobs
    .filter((job) => job.startTime > 0)
    .map((job) => ({
      ...job,
      effectiveEndTime: job.endTime > 0 ? job.endTime : now,
    }));

  const fixedRange = rangeKey !== 'auto' ? { start: now - RANGE_SECONDS[rangeKey], end: now } : undefined;

  return (
    <section style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <h2 style={{ fontSize: 18, margin: 0, color: theme.colors.text.primary }}>Job Timeline</h2>
        <RadioButtonGroup
          size="sm"
          options={TIMELINE_RANGE_OPTIONS}
          value={rangeKey}
          onChange={(value) => setRangeKey(value)}
        />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        {jobTimelineLegend.map((item) => (
          <div
            key={item.label}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.colors.text.secondary }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: theme.shape.radius.pill,
                background: item.color,
                flexShrink: 0,
              }}
            />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      {timelineJobs.length === 0 ? (
        <div>No chartable jobs found.</div>
      ) : (
        <div
          style={{
            border: `1px solid ${theme.colors.border.weak}`,
            borderRadius: theme.shape.radius.default,
            padding: 12,
            maxHeight: TIMELINE_HEIGHT,
            overflowY: 'auto',
            overflowX: 'auto',
            background: theme.colors.background.secondary,
          }}
        >
          <TimelineGrid jobs={timelineJobs} onOpenJob={onOpenJob} fixedRange={fixedRange} />
        </div>
      )}
    </section>
  );
}

interface TimelineGridProps {
  jobs: TimelineJob[];
  onOpenJob: (clusterId: string, jobId: number) => void;
  fixedRange?: { start: number; end: number };
}

function TimelineGrid({ jobs, onOpenJob, fixedRange }: TimelineGridProps) {
  const theme = useTheme2();

  let minStart: number;
  let range: number;

  if (fixedRange) {
    minStart = fixedRange.start;
    range = Math.max(TIMELINE_MIN_RANGE_SECONDS, fixedRange.end - fixedRange.start);
  } else {
    const { autoMin, autoMaxEnd } = jobs.reduce(
      (acc, job) => ({
        autoMin: Math.min(acc.autoMin, job.startTime),
        autoMaxEnd: Math.max(acc.autoMaxEnd, job.effectiveEndTime),
      }),
      { autoMin: Infinity, autoMaxEnd: 0 }
    );
    const maxEnd = autoMaxEnd <= autoMin ? autoMin + TIMELINE_MIN_RANGE_SECONDS : autoMaxEnd;
    minStart = autoMin;
    range = Math.max(TIMELINE_MIN_RANGE_SECONDS, maxEnd - autoMin);
  }

  const ticks = buildTicks(minStart, minStart + range);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${TIMELINE_LABEL_COLUMN_WIDTH}px minmax(${TIMELINE_MIN_WIDTH}px, 1fr)`,
        gap: '8px 12px',
        minWidth: TIMELINE_LABEL_COLUMN_WIDTH + TIMELINE_MIN_WIDTH + 12,
        alignItems: 'center',
      }}
    >
      <div />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 12,
          color: theme.colors.text.secondary,
          paddingBottom: 4,
        }}
      >
        {ticks.map((tick, index) => (
          <span key={`${tick}-${index}`}>{formatTimestamp(tick)}</span>
        ))}
      </div>
      {jobs.map((job) => {
        const rawLeftPct = ((job.startTime - minStart) / range) * 100;
        const leftPct = Math.max(0, rawLeftPct);
        const rawWidthPct = ((job.effectiveEndTime - job.startTime) / range) * 100;
        const widthPct = Math.max(rawWidthPct - Math.max(0, -rawLeftPct), 1);
        const clampedWidthPct = Math.max(1, Math.min(widthPct, 100 - leftPct));
        const label = buildBarLabel(job, widthPct);
        return (
          <React.Fragment key={`${job.clusterId}-${job.jobId}`}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.jobId}</div>
              <div
                style={{
                  fontSize: 12,
                  color: theme.colors.text.secondary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {job.name}
              </div>
            </div>
            <div
              style={{
                position: 'relative',
                height: 28,
                borderRadius: theme.shape.radius.default,
                background: theme.colors.action.hover,
              }}
            >
              <div
                data-testid="job-timeline-bar"
                style={{
                  position: 'absolute',
                  top: 2,
                  bottom: 2,
                  left: `${leftPct}%`,
                  width: `${clampedWidthPct}%`,
                  minWidth: 8,
                }}
              >
                <div
                  data-testid={`job-timeline-bar-${job.jobId}`}
                  data-state={job.state}
                  data-width-pct={widthPct.toFixed(2)}
                  data-label={label}
                  role="button"
                  tabIndex={0}
                  title={buildBarTitle(job)}
                  onClick={() => onOpenJob(job.clusterId, job.jobId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenJob(job.clusterId, job.jobId);
                    }
                  }}
                  style={{
                    height: '100%',
                    borderRadius: theme.shape.radius.default,
                    background: getJobStateTimelineColor(job.state),
                    color: theme.colors.getContrastText(getJobStateTimelineColor(job.state)),
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 8px',
                    fontSize: 12,
                    fontWeight: 500,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    boxSizing: 'border-box',
                  }}
                >
                  {label}
                </div>
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
