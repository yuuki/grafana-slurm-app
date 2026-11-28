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
  buildTimelineMarks,
  describeIdleRun,
  describeMixedMark,
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
  TIMELINE_RESOLUTION,
  TimelineMark,
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

/** The most stretches the table lists. The timeline covers the whole window whatever their number. */
export const MAX_STRETCH_ROWS = 100;
/** The most idle-node findings the section spells out. */
const MAX_NODE_FINDINGS_SHOWN = 5;

function getStyles(theme: GrafanaTheme2) {
  return {
    section: css({
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: 8,
      background: theme.colors.background.secondary,
      padding: '12px 14px',
      marginBottom: 20,
      // The section never grows past its container: a wide table scrolls inside it (tableScroll).
      minWidth: 0,
      maxWidth: '100%',
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
    // Each stretch starts at its true position in time and reaches to the right end of the strip; the
    // next stretch is drawn over it. So every boundary is exact at every width, neighbours never leave a
    // gap, and the strip always spans exactly the analysed window, however many stretches there are.
    // (A row of blocks with a smallest width pushed the last stretches out of the strip; a flex row
    // without one drifted by a few pixels over a thousand stretches.)
    timeline: css({
      position: 'relative',
      height: 24,
      borderRadius: 4,
      overflow: 'hidden',
      background: theme.colors.background.canvas,
    }),
    timelineSegment: css({ position: 'absolute', top: 0, bottom: 0, right: 0 }),
    // Every block has an opaque ground, also under the hatch of "no data": the block before it lies underneath.
    timelineGround: css({ backgroundColor: theme.colors.background.canvas }),
    timelineHighlight: css({
      position: 'absolute',
      top: 0,
      bottom: 0,
      outline: `2px solid ${theme.colors.text.primary}`,
      outlineOffset: -2,
      pointerEvents: 'none',
    }),
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
    tableScroll: css({ overflowX: 'auto', maxWidth: '100%' }),
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
  const base = `${formatTime(segment.fromSec)} to ${formatTime(segment.toSec)} · ${formatSeconds(segment.toSec - segment.fromSec)} · ${segmentName(segment)}`;
  return segment.idleRun ? `${base} · ${describeIdleRun(segment.idleRun)}` : base;
}

/**
 * Where a stretch lies on the timeline, in percent of the analysed window:
 * its true position in time and nothing else. There is no smallest width, so
 * a stretch narrower than a pixel takes less than a pixel.
 */
export function timelinePosition(segment: { fromSec: number; toSec: number }, startSec: number, endSec: number): { leftPercent: number; widthPercent: number } {
  const span = endSec - startSec;
  return { leftPercent: (100 * (segment.fromSec - startSec)) / span, widthPercent: (100 * (segment.toSec - segment.fromSec)) / span };
}

/** A table that scrolls sideways inside the section when the section is narrower than the table. */
function ScrollTable({ label, styles, className, children }: { label: string; styles: Styles; className?: string; children: React.ReactNode }) {
  return (
    <div className={`${styles.tableScroll} ${className ?? ''}`} role="region" aria-label={label} tabIndex={0}>
      <table className={styles.table}>{children}</table>
    </div>
  );
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

/** The fill of a timeline block: the colour of its label, or bands from bottom to top by the shares of its labels. */
function markBackground(mark: TimelineMark, isDark: boolean): React.CSSProperties {
  if (mark.shares.length === 1) {
    const phase = mark.shares[0].phase;
    return phase === 'no-data' ? { backgroundImage: phaseBackground(phase, isDark) } : { background: phaseBackground(phase, isDark) };
  }
  let from = 0;
  const stops = mark.shares.map(({ phase, share }) => {
    const to = from + 100 * share;
    // "No data" stays transparent in the bands, so that the hatch below shows through.
    const stop = `${phase === 'no-data' ? 'transparent' : phaseBackground(phase, isDark)} ${from}% ${to}%`;
    from = to;
    return stop;
  });
  return { backgroundImage: `linear-gradient(to top, ${stops.join(', ')}), ${phaseBackground('no-data', isDark)}` };
}

function describeMark(mark: TimelineMark): string {
  if (mark.segments.length === 1) {
    return describeSegment(mark.segments[0]);
  }
  return `${formatTime(mark.fromSec)} to ${formatTime(mark.toSec)} · ${formatSeconds(mark.toSec - mark.fromSec)} · ${describeMixedMark(mark)}`;
}

/**
 * The phases in time order. Hovering a block names it below the strip;
 * clicking zooms the panels to it. A block is one stretch, or a run of
 * stretches that are too short to draw one by one (buildTimelineMarks).
 */
function Timeline({ analysis, styles, isDark, onZoom }: ViewProps & { onZoom?: (fromMs: number, toMs: number) => void }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const { window, result } = analysis;
  const marks = useMemo(() => buildTimelineMarks(result.segments, window.startSec, window.endSec), [result.segments, window.startSec, window.endSec]);
  const hoveredMark = hovered === null ? undefined : marks[hovered];
  const merged = marks.some((mark) => mark.segments.length > 1);
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
        {marks.map((mark, index) => (
          <div
            key={mark.fromSec}
            className={`${styles.timelineSegment} ${styles.timelineGround} ${onZoom ? styles.clickable : ''}`}
            style={{ left: `${timelinePosition(mark, window.startSec, window.endSec).leftPercent}%`, ...markBackground(mark, isDark) }}
            data-testid="phase-segment"
            data-phase={mark.shares.map((item) => item.phase).join(' ')}
            data-stretches={mark.segments.length}
            onMouseEnter={() => setHovered(index)}
            onClick={onZoom ? () => onZoom(mark.fromSec * 1000, mark.toSec * 1000) : undefined}
          />
        ))}
        {hoveredMark && (
          <div
            className={styles.timelineHighlight}
            style={{
              left: `${timelinePosition(hoveredMark, window.startSec, window.endSec).leftPercent}%`,
              width: `${timelinePosition(hoveredMark, window.startSec, window.endSec).widthPercent}%`,
            }}
          />
        )}
      </div>
      <div className={`${styles.axis} ${styles.secondary}`}>
        <span>{formatTime(window.startSec)}</span>
        <span>{formatTime(window.endSec)}</span>
      </div>
      <div className={hoveredMark ? styles.readout : `${styles.readout} ${styles.secondary}`} data-testid="phase-readout">
        {hoveredMark ? describeMark(hoveredMark) : hint}
      </div>
      {merged && (
        <div className={styles.secondary} data-testid="phase-merged-note">
          Neighbouring stretches that are each shorter than 1/{TIMELINE_RESOLUTION} of the window are drawn as one block. Its bands show the
          shares of the phases in it, from bottom to top; they are not stretches. The Stretches table lists the single stretches.
        </div>
      )}
    </div>
  );
}

function evidenceCells(total: PhaseTotal): string[] {
  const { evidence } = total;
  return [
    // No unit: the power metric is configurable and only its ratio to the working level is used.
    formatNumber(evidence.gpuPowerWatts, ''),
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
      <ScrollTable label="Phases with their telemetry" styles={styles}>
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
      </ScrollTable>
      <div className={styles.secondary} style={{ marginTop: 6 }}>
        The telemetry columns are medians over the buckets of a phase: GPU power (in the unit of the power metric) and utilization per GPU, CPU load as the share of CPU time
        that is neither idle nor waiting for I/O, storage write and network added over the job&apos;s nodes. They are node-wide values and
        include other jobs on the same nodes. Network is shown as evidence and decides no phase.
      </div>
      {analysis.result.unclassifiedReasons.length > 0 && (
        <ScrollTable label="Reasons for unclassified time" styles={styles} className={styles.block}>
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
        </ScrollTable>
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
      <ScrollTable label="Stretches" styles={styles}>
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
                {segment.idleRun && <div className={styles.secondary}>{describeIdleRun(segment.idleRun)}</div>}
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
      </ScrollTable>
      {segments.length > rows.length && (
        <div className={styles.secondary} style={{ marginTop: 6 }}>
          The table lists the first {rows.length} of {segments.length} stretches. The timeline covers the whole window in proportion to the
          time. Zoom the panels to a part of the job to read its stretches.
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
      ? 'none: the GPU activity in this window gives no level that can be told from idle'
      : [level.gpuPowerWatts === null ? null : `power ${level.gpuPowerWatts.toFixed(0)} (in the unit of the power metric)`, level.gpuUtilPercent === null ? null : `${level.gpuUtilPercent.toFixed(0)}% utilization`]
          .filter((text) => text !== null)
          .join(', ');
  return (
    <>
      <ScrollTable label="Signals the result is based on" styles={styles}>
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
      </ScrollTable>
      <ul className={styles.notes}>
        <li>
          Working level of this job&apos;s GPUs (90th percentile of the node buckets with GPU activity): {levelText}. A node works in a bucket
          when its GPUs reach half of it.
        </li>
        <li>
          A GPU is idle in a bucket when none of its utilization samples exceeds {thresholds.idleGpuUtilizationPercent}%. A stall needs every
          GPU idle for {formatSeconds(thresholds.stallMinSeconds)} and idle CPUs on every node: the CPU load of the busiest node (its median
          over the stretch) below {formatCpu(result.baselines.cpuIdleLimit)} (
          {result.baselines.cpuBusy === null
            ? 'the compute buckets have no CPU sample'
            : `a quarter of the ${formatCpu(result.baselines.cpuBusy)} of the compute buckets, at least 1% and at most 5%`}
          ).
        </li>
        <li>
          A write burst needs {formatByteRate(result.baselines.writeBurstNodeBytesPerSecond)} on at least one node (the configured minimum)
          and, over the job&apos;s nodes, three times the median of the compute buckets ({formatByteRate(result.baselines.storageWriteBytesPerSecond)}
          ). An idle stretch of the stall time is never a checkpoint when the CPUs are idle: it is stalled, and its writes are stated with the
          stretch.
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
  const lastIdleRun = analysis.result.segments[analysis.result.segments.length - 1]?.idleRun;
  const notes = useMemo(() => [...buildCoverageNotes(analysis), ...buildLimitNotes(analysis)], [analysis]);
  const findings = nodeFindingLines(analysis);
  return (
    <>
      {stalledNow !== null && (
        <Alert severity="warning" title={`Stalled now: every GPU of the job has been idle for ${formatSeconds(stalledNow)}`}>
          Slurm records the job as running. {lastIdleRun ? `${describeIdleRun(lastIdleRun)} ` : ''}See the CPU load and the rates of the
          Stalled row below before you conclude that it hangs.
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
        <LoadingPlaceholder text={`Reading the job's telemetry (query ${state.queriesSent + 1})...`} />
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

/** Shown instead of the analysis when the cluster asked for the phases with settings that the plugin cannot use. */
function InvalidSettingsNotice({ error }: { error: string }) {
  const styles = useStyles2(getStyles);
  return (
    <section className={styles.section} aria-label="Job phases">
      <div className={styles.title}>Job phases</div>
      <Alert severity="warning" title="Job phases are off for this cluster: its phase settings are not valid. No query was sent.">
        {error}. An administrator can correct the Job Phases settings of the cluster on the plugin&apos;s configuration page.
      </Alert>
    </section>
  );
}

/**
 * The Job phases section of the Job Dashboard. It renders nothing, and sends
 * nothing, unless the cluster's settings turn the phase segmentation on.
 * When the stored settings ask for it but are invalid, the backend drops
 * them and gives the reason; the section then shows that reason only.
 */
export function JobPhasesSection(props: JobPhasesSectionProps) {
  if (props.cluster.phases?.enabled !== true) {
    return props.cluster.phasesError ? <InvalidSettingsNotice error={props.cluster.phasesError} /> : null;
  }
  return <PhasesFrame {...props} />;
}
