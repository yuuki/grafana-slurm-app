import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, CollapsableSection, LoadingPlaceholder, useStyles2, useTheme2 } from '@grafana/ui';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { JobPhasesAnalysis } from '../phases/collect';
import {
  buildBasis,
  buildCoverageNotes,
  buildLimitNotes,
  describeNotComputed,
  describeWindow,
  draftLabel,
  formatByteRate,
  formatCpu,
  formatNumber,
  formatSeconds,
  formatShares,
  orderedTotals,
  PHASE_DEFINITIONS,
  PHASE_LABELS,
  phaseBackground,
  REASON_TEXT,
  stalledNowSeconds,
} from '../phases/present';
import { PhaseId, PhaseSegment, PhaseTotal } from '../phases/types';
import { useJobPhases, UseJobPhasesOptions } from '../phases/useJobPhases';

/** A stretch that the user asked to save as a label; nothing is written before the label dialog is confirmed. */
export interface PhaseLabelDraft {
  fromMs: number;
  toMs: number;
  category: string;
  note: string;
}

export interface JobPhasesSectionProps {
  job: JobRecord;
  cluster: ClusterSummary;
  /** Zooms the metric panels to a window. Absent while no panel is shown. */
  onZoom?: (fromMs: number, toMs: number) => void;
  /** Opens the label dialog for a stretch. Absent when annotation labeling is off. */
  onDraftLabel?: (draft: PhaseLabelDraft) => void;
  /** For tests. */
  hookOptions?: UseJobPhasesOptions;
}

/** The most stretches the table lists; the timeline always shows all of them. */
const MAX_STRETCH_ROWS = 100;
/** The most idle-node findings the section spells out. */
const MAX_NODE_FINDINGS_SHOWN = 5;
/** The largest number of queries one analysis sends. */
const MAX_QUERIES = 8;

function getStyles(theme: GrafanaTheme2) {
  return {
    section: css({
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: 8,
      background: theme.colors.background.secondary,
      padding: '12px 14px',
      marginBottom: 20,
    }),
    header: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }),
    title: css({ fontSize: 16, fontWeight: 600 }),
    secondary: css({ color: theme.colors.text.secondary, fontSize: 12 }),
    summaryBar: css({ display: 'flex', gap: 2, height: 8, marginBottom: 8 }),
    summaryBlock: css({ height: '100%', minWidth: 2, borderRadius: 4 }),
    legend: css({ display: 'flex', flexWrap: 'wrap', columnGap: 18, rowGap: 4, marginBottom: 12, fontSize: 13, listStyle: 'none', padding: 0, margin: '0 0 12px 0' }),
    legendItem: css({ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }),
    swatch: css({ display: 'inline-block', width: 10, height: 10, borderRadius: 2, flex: 'none' }),
    strong: css({ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }),
    // A flex row, so that neighbouring stretches share an edge at every width; absolute positions leave hairline gaps.
    timeline: css({
      display: 'flex',
      height: 24,
      borderRadius: 4,
      overflow: 'hidden',
      background: theme.colors.background.canvas,
    }),
    timelineSegment: css({ height: '100%', minWidth: 1 }),
    timelineSegmentHovered: css({ outline: `2px solid ${theme.colors.text.primary}`, outlineOffset: -2, zIndex: 1 }),
    clickable: css({ cursor: 'pointer' }),
    axis: css({ display: 'flex', justifyContent: 'space-between', marginTop: 2 }),
    readout: css({ minHeight: 20, marginTop: 4, fontSize: 13 }),
    notes: css({ margin: '8px 0 0 0', paddingLeft: 18, fontSize: 12, color: theme.colors.text.secondary }),
    table: css({
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 13,
      'th, td': { textAlign: 'left', padding: '4px 10px 4px 0', borderBottom: `1px solid ${theme.colors.border.weak}`, verticalAlign: 'top' },
      th: { color: theme.colors.text.secondary, fontWeight: 500, whiteSpace: 'nowrap' },
      'td.number, th.number': { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      'td.nowrap': { whiteSpace: 'nowrap' },
    }),
    block: css({ marginTop: 12 }),
    actions: css({ display: 'flex', gap: 6 }),
  };
}

type Styles = ReturnType<typeof getStyles>;

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function segmentName(segment: PhaseSegment): string {
  return segment.reason ? `${PHASE_LABELS[segment.phase]}: ${REASON_TEXT[segment.reason]}` : PHASE_LABELS[segment.phase];
}

function describeSegment(segment: PhaseSegment): string {
  return `${formatTime(segment.fromSec)} to ${formatTime(segment.toSec)} · ${formatSeconds(segment.toSec - segment.fromSec)} · ${segmentName(segment)}`;
}

function Swatch({ phase, styles, isDark }: { phase: PhaseId; styles: Styles; isDark: boolean }) {
  return <span className={styles.swatch} style={{ background: phaseBackground(phase, isDark) }} aria-hidden="true" />;
}

interface ViewProps {
  analysis: JobPhasesAnalysis;
  styles: Styles;
  isDark: boolean;
}

/** The breakdown: one block per label, widths by share, and a legend that carries every name and number. */
function Breakdown({ analysis, styles, isDark }: ViewProps) {
  const totals = orderedTotals(analysis);
  const shares = formatShares(totals);
  const sentence = totals.map((total) => `${shares.get(total.phase)} ${PHASE_LABELS[total.phase]}`).join(', ');
  return (
    <>
      <div className={styles.summaryBar} role="img" aria-label={`Share of the analysed window: ${sentence}`}>
        {totals.map((total) => (
          <div
            key={total.phase}
            className={styles.summaryBlock}
            style={{ flex: `${total.seconds} 1 0`, background: phaseBackground(total.phase, isDark) }}
            data-phase={total.phase}
          />
        ))}
      </div>
      <ul className={styles.legend} aria-label="Time per phase">
        {totals.map((total) => (
          <li key={total.phase} className={styles.legendItem} title={PHASE_DEFINITIONS[total.phase]}>
            <Swatch phase={total.phase} styles={styles} isDark={isDark} />
            <span className={styles.strong}>{shares.get(total.phase)}</span>
            <span>{PHASE_LABELS[total.phase]}</span>
            <span className={styles.secondary}>{formatSeconds(total.seconds)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The phases in time order. Hovering a stretch names it below the strip; clicking zooms the panels to it. */
function Timeline({ analysis, styles, isDark, onZoom }: ViewProps & { onZoom?: (fromMs: number, toMs: number) => void }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const { window, result } = analysis;
  const hoveredSegment = hovered === null ? undefined : result.segments[hovered];
  const hint = onZoom
    ? 'Hover the timeline to read a stretch. Click a stretch to zoom the panels to it.'
    : 'Hover the timeline to read a stretch. Pin a metric to zoom its panel to a stretch.';
  return (
    <div className={styles.block}>
      <div
        className={styles.timeline}
        role="img"
        aria-label={`Timeline of ${result.segments.length} stretches from ${formatTime(window.startSec)} to ${formatTime(window.endSec)}; the Stretches table lists them`}
        onMouseLeave={() => setHovered(null)}
      >
        {result.segments.map((segment, index) => (
          <div
            key={segment.fromSec}
            className={`${styles.timelineSegment} ${index === hovered ? styles.timelineSegmentHovered : ''} ${onZoom ? styles.clickable : ''}`}
            style={{ flex: `${segment.toSec - segment.fromSec} 1 0`, background: phaseBackground(segment.phase, isDark) }}
            data-testid="phase-segment"
            data-phase={segment.phase}
            onMouseEnter={() => setHovered(index)}
            onClick={onZoom ? () => onZoom(segment.fromSec * 1000, segment.toSec * 1000) : undefined}
          />
        ))}
      </div>
      <div className={`${styles.axis} ${styles.secondary}`}>
        <span>{formatTime(window.startSec)}</span>
        <span>{formatTime(window.endSec)}</span>
      </div>
      <div className={hoveredSegment ? styles.readout : `${styles.readout} ${styles.secondary}`} data-testid="phase-readout">
        {hoveredSegment ? describeSegment(hoveredSegment) : hint}
      </div>
    </div>
  );
}

function evidenceCells(total: PhaseTotal): string[] {
  const { evidence } = total;
  return [
    formatNumber(evidence.gpuPowerWatts, ' W'),
    formatNumber(evidence.gpuUtilPercent, '%'),
    formatCpu(evidence.cpuBusy),
    formatByteRate(evidence.storageWriteBytesPerSecond),
    formatByteRate(evidence.networkBytesPerSecond),
  ];
}

/** Per label: time, share, number of stretches and the typical telemetry, so the reader can check the label. */
function PhaseTable({ analysis, styles, isDark }: ViewProps) {
  const totals = orderedTotals(analysis);
  const shares = formatShares(totals);
  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Phase</th>
            <th className="number">Time</th>
            <th className="number">Share</th>
            <th className="number">Stretches</th>
            <th className="number">GPU power</th>
            <th className="number">GPU utilization</th>
            <th className="number">CPU load</th>
            <th className="number">Storage write</th>
            <th className="number">Network</th>
          </tr>
        </thead>
        <tbody>
          {totals.map((total) => (
            <tr key={total.phase}>
              <td>
                <span className={styles.legendItem}>
                  <Swatch phase={total.phase} styles={styles} isDark={isDark} />
                  {PHASE_LABELS[total.phase]}
                </span>
                <div className={styles.secondary}>{PHASE_DEFINITIONS[total.phase]}</div>
              </td>
              <td className="number">{formatSeconds(total.seconds)}</td>
              <td className="number">{shares.get(total.phase)}</td>
              <td className="number">{total.segmentCount}</td>
              {evidenceCells(total).map((cell, index) => (
                <td key={index} className="number">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.secondary} style={{ marginTop: 6 }}>
        The telemetry columns are medians over the buckets of a phase: GPU power and utilization per GPU, CPU load as the share of CPU time
        that is neither idle nor waiting for I/O, storage write and network added over the job&apos;s nodes. They are node-wide values and
        include other jobs on the same nodes. Network is shown as evidence and decides no phase.
      </div>
      {analysis.result.unclassifiedReasons.length > 0 && (
        <table className={`${styles.table} ${styles.block}`}>
          <thead>
            <tr>
              <th>Why unclassified</th>
              <th className="number">Time</th>
              <th className="number">Stretches</th>
            </tr>
          </thead>
          <tbody>
            {analysis.result.unclassifiedReasons.map((total) => (
              <tr key={total.reason}>
                <td>{REASON_TEXT[total.reason]}</td>
                <td className="number">{formatSeconds(total.seconds)}</td>
                <td className="number">{total.segmentCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

interface StretchTableProps extends ViewProps {
  onZoom?: (fromMs: number, toMs: number) => void;
  onDraftLabel?: (draft: PhaseLabelDraft) => void;
}

/** Every stretch as a row: the table view of the timeline, with the actions on a stretch. */
function StretchTable({ analysis, styles, isDark, onZoom, onDraftLabel }: StretchTableProps) {
  const { segments } = analysis.result;
  const rows = segments.slice(0, MAX_STRETCH_ROWS);
  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th className="number">Length</th>
            <th>Phase</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((segment) => (
            <tr key={segment.fromSec}>
              <td>{formatTime(segment.fromSec)}</td>
              <td>{formatTime(segment.toSec)}</td>
              <td className="number">{formatSeconds(segment.toSec - segment.fromSec)}</td>
              <td>
                <span className={styles.legendItem}>
                  <Swatch phase={segment.phase} styles={styles} isDark={isDark} />
                  {PHASE_LABELS[segment.phase]}
                </span>
                {segment.reason && <div className={styles.secondary}>{REASON_TEXT[segment.reason]}</div>}
              </td>
              <td>
                <div className={styles.actions}>
                  <Button
                    size="sm"
                    variant="secondary"
                    fill="text"
                    disabled={!onZoom}
                    tooltip={onZoom ? undefined : 'Pin a metric to zoom its panel'}
                    onClick={() => onZoom?.(segment.fromSec * 1000, segment.toSec * 1000)}
                  >
                    Zoom
                  </Button>
                  {onDraftLabel && segment.phase !== 'no-data' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      fill="text"
                      tooltip="Opens the label dialog with this window. Nothing is saved until you confirm there."
                      onClick={() => onDraftLabel({ fromMs: segment.fromSec * 1000, toMs: segment.toSec * 1000, ...draftLabel(segment.phase, segment.reason) })}
                    >
                      Label…
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {segments.length > rows.length && (
        <div className={styles.secondary} style={{ marginTop: 6 }}>
          The table lists the first {rows.length} of {segments.length} stretches. The timeline shows all of them.
        </div>
      )}
    </>
  );
}

function nodeFindingLines(analysis: JobPhasesAnalysis): string[] {
  const { nodeFindings, nodeFindingCount } = analysis.result;
  const lines = nodeFindings
    .slice(0, MAX_NODE_FINDINGS_SHOWN)
    .map(
      (finding) =>
        `${analysis.nodes[finding.nodeIndex]}: GPUs idle for ${formatSeconds(finding.toSec - finding.fromSec)} from ${formatTime(finding.fromSec)}, while other nodes of the job worked`
    );
  if (nodeFindingCount > lines.length) {
    lines.push(`and ${nodeFindingCount - lines.length} more such stretches`);
  }
  return lines;
}

function BasisList({ analysis, styles }: { analysis: JobPhasesAnalysis; styles: Styles }) {
  const { thresholds, result } = analysis;
  const level = result.workingLevel;
  const levelText =
    level.gpuPowerWatts === null && level.gpuUtilPercent === null
      ? 'none: the GPUs never reached one in this window'
      : [formatNumber(level.gpuPowerWatts, ' W'), formatNumber(level.gpuUtilPercent, '% utilization')].filter((text) => text !== 'no data').join(', ');
  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Signal</th>
            <th>Metrics</th>
            <th>In this job</th>
          </tr>
        </thead>
        <tbody>
          {buildBasis(analysis).map((line) => (
            <tr key={line.signal}>
              <td className="nowrap">{line.label}</td>
              <td>{line.metrics}</td>
              <td className="nowrap">{line.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className={styles.notes}>
        <li>
          Working level of this job&apos;s GPUs (90th percentile of the node buckets with GPU activity): {levelText}. A node works in a bucket
          when its GPUs reach half of it.
        </li>
        <li>
          A GPU is idle in a bucket when none of its utilization samples exceeds {thresholds.idleGpuUtilizationPercent}%. A stall needs every
          GPU idle for {formatSeconds(thresholds.stallMinSeconds)} and idle CPUs: a median CPU load of the stretch below{' '}
          {formatCpu(result.baselines.cpuIdleLimit)} (
          {result.baselines.cpuBusy === null
            ? 'the compute buckets have no CPU sample'
            : `a quarter of the ${formatCpu(result.baselines.cpuBusy)} of the compute buckets, at least 1% and at most 5%`}
          ).
        </li>
        <li>
          A write burst needs {formatByteRate(result.baselines.writeBurstBytesPerSecond)} over the job&apos;s nodes: the larger of the configured
          minimum ({formatByteRate(thresholds.checkpointMinWriteBytesPerSecond)}) and three times the median of the compute buckets (
          {formatByteRate(result.baselines.storageWriteBytesPerSecond)}).
        </li>
      </ul>
    </>
  );
}

function PhaseResult({ analysis, onZoom, onDraftLabel }: { analysis: JobPhasesAnalysis } & Pick<JobPhasesSectionProps, 'onZoom' | 'onDraftLabel'>) {
  const styles = useStyles2(getStyles);
  const isDark = useTheme2().isDark;
  const view: ViewProps = { analysis, styles, isDark };
  const window = describeWindow(analysis);
  const stalledNow = stalledNowSeconds(analysis);
  const notes = useMemo(() => [...buildCoverageNotes(analysis), ...buildLimitNotes(analysis)], [analysis]);
  const findings = nodeFindingLines(analysis);
  return (
    <>
      {stalledNow !== null && (
        <Alert severity="warning" title={`Stalled now: every GPU of the job has been idle for ${formatSeconds(stalledNow)}`}>
          The job is recorded as running. See the CPU load and the rates of the Stalled row below before you conclude that it hangs.
        </Alert>
      )}
      <Breakdown {...view} />
      <Timeline {...view} onZoom={onZoom} />
      <ul className={styles.notes} aria-label="What the result covers">
        <li>
          Analysed {formatTime(analysis.window.startSec)} to {formatTime(analysis.window.endSec)} in {window.resolution}
        </li>
        {window.edges && <li>{window.edges}</li>}
        {analysis.window.running && <li>The job is running: the result covers it up to {formatTime(analysis.window.endSec)}.</li>}
        {findings.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <CollapsableSection label="Phase details and telemetry" isOpen={false}>
        <PhaseTable {...view} />
      </CollapsableSection>
      <CollapsableSection label={`Stretches (${analysis.result.segments.length})`} isOpen={false}>
        <StretchTable {...view} onZoom={onZoom} onDraftLabel={onDraftLabel} />
      </CollapsableSection>
      <CollapsableSection label="What the phases are based on" isOpen={false}>
        <BasisList analysis={analysis} styles={styles} />
      </CollapsableSection>
    </>
  );
}

function PhasesFrame({ job, cluster, onZoom, onDraftLabel, hookOptions }: JobPhasesSectionProps) {
  const styles = useStyles2(getStyles);
  const { state, reload } = useJobPhases(job, cluster, hookOptions);
  return (
    <section className={styles.section} aria-label="Job phases">
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Job phases</div>
          <div className={styles.secondary}>Startup, compute, checkpoint and stall, read from the telemetry of the job&apos;s nodes.</div>
        </div>
        <Button variant="secondary" size="sm" onClick={reload} disabled={state.status === 'loading'}>
          {state.status === 'error' ? 'Retry' : 'Refresh'}
        </Button>
      </div>
      {state.status === 'invalid' && (
        <Alert severity="warning" title="The phase settings of this cluster are not valid. No query was sent.">
          {state.errors.join('; ')}
        </Alert>
      )}
      {state.status === 'loading' && (
        <LoadingPlaceholder text={`Reading the job's telemetry (query ${state.queriesSent + 1} of at most ${MAX_QUERIES})...`} />
      )}
      {state.status === 'error' && (
        <Alert severity="error" title="The job phases could not be analysed">
          {state.message}
        </Alert>
      )}
      {state.status === 'done' && state.outcome.state === 'not-computed' && <div>No phases for this job. {describeNotComputed(state.outcome)}</div>}
      {state.status === 'done' && state.outcome.state === 'ready' && (
        <PhaseResult analysis={state.outcome.analysis} onZoom={onZoom} onDraftLabel={onDraftLabel} />
      )}
    </section>
  );
}

/**
 * The Job phases section of the Job Dashboard. It renders nothing, and sends
 * nothing, unless the cluster's settings turn the phase segmentation on.
 */
export function JobPhasesSection(props: JobPhasesSectionProps) {
  if (props.cluster.phases?.enabled !== true) {
    return null;
  }
  return <PhasesFrame {...props} />;
}
