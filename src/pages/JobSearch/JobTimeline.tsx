import React from 'react';
import { LoadingPlaceholder } from '@grafana/ui';
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

  return (
    <section style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Job Timeline</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        {jobTimelineLegend.map((item) => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#D8D9DA' }}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
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
            border: '1px solid rgba(204, 204, 220, 0.16)',
            borderRadius: 6,
            padding: 12,
            maxHeight: TIMELINE_HEIGHT,
            overflowY: 'auto',
            overflowX: 'auto',
            background: 'rgba(17, 18, 23, 0.2)',
          }}
        >
          <TimelineGrid jobs={timelineJobs} onOpenJob={onOpenJob} />
        </div>
      )}
    </section>
  );
}

function TimelineGrid({ jobs, onOpenJob }: { jobs: TimelineJob[]; onOpenJob: (clusterId: string, jobId: number) => void }) {
  const minStart = Math.min(...jobs.map((job) => job.startTime));
  const rawMaxEnd = Math.max(...jobs.map((job) => job.effectiveEndTime));
  const maxEnd = rawMaxEnd <= minStart ? minStart + TIMELINE_MIN_RANGE_SECONDS : rawMaxEnd;
  const range = Math.max(TIMELINE_MIN_RANGE_SECONDS, maxEnd - minStart);
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#D8D9DA', paddingBottom: 4 }}>
        {ticks.map((tick) => (
          <span key={tick}>{formatTimestamp(tick)}</span>
        ))}
      </div>
      {jobs.map((job) => {
        const leftPct = ((job.startTime - minStart) / range) * 100;
        const widthPct = Math.max(((job.effectiveEndTime - job.startTime) / range) * 100, 1);
        const label = buildBarLabel(job, widthPct);
        return (
          <React.Fragment key={`${job.clusterId}-${job.jobId}`}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.jobId}</div>
              <div style={{ fontSize: 12, color: '#D8D9DA', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.name}</div>
            </div>
            <div style={{ position: 'relative', height: 28, borderRadius: 4, background: 'rgba(204, 204, 220, 0.08)' }}>
              <div
                data-testid="job-timeline-bar"
                style={{
                  position: 'absolute',
                  top: 2,
                  bottom: 2,
                  left: `${leftPct}%`,
                  width: `min(${widthPct}%, calc(100% - ${leftPct}%))`,
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
                    borderRadius: 4,
                    background: getJobStateTimelineColor(job.state),
                    color: '#FFFFFF',
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
