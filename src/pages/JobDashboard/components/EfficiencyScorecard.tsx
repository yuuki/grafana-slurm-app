import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Badge, BadgeColor, Button, IconName, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { ClusterSummary, JobRecord } from '../../../api/types';
import {
  buildFindings,
  buildTiles,
  buildWindowNotes,
  describeNotComputed,
  Finding,
  FindingSeverity,
  formatGiB,
  formatPercent,
  formatShare,
  ScoredEfficiency,
} from '../efficiency/findings';
import { GpuActivity, GpuEvidence } from '../efficiency/score';
import { efficiencyDisabled } from '../efficiency/settings';
import { EfficiencyState, useJobEfficiency } from '../efficiency/useJobEfficiency';

/** GPU rows shown before "Show all": enough for a few nodes, short enough to scan. */
const GPU_ROW_LIMIT = 32;

export const SEVERITY_BADGE: Record<FindingSeverity, { color: BadgeColor; icon: IconName }> = {
  warning: { color: 'orange', icon: 'exclamation-triangle' },
  ok: { color: 'green', icon: 'check-circle' },
  unknown: { color: 'blue', icon: 'question-circle' },
};

type ActivityBadge = { text: string; color: BadgeColor; icon: IconName };

const ACTIVITY_BADGE: Record<GpuActivity, ActivityBadge> = {
  idle: { text: 'Idle', color: 'orange', icon: 'exclamation-triangle' },
  partial: { text: 'Gaps in telemetry', color: 'blue', icon: 'question-circle' },
  active: { text: 'Active', color: 'green', icon: 'check-circle' },
};

/**
 * An idle GPU is a warning only when it is the job's. On nodes whose GPUs
 * cannot be matched to the job it may be another job's, or nobody's.
 */
const UNATTRIBUTED_IDLE_BADGE: ActivityBadge = { text: 'Idle', color: 'blue', icon: 'info-circle' };

export function activityBadge(activity: GpuActivity, attributed: boolean): ActivityBadge {
  return activity === 'idle' && !attributed ? UNATTRIBUTED_IDLE_BADGE : ACTIVITY_BADGE[activity];
}

function getStyles(theme: GrafanaTheme2) {
  return {
    container: css({
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: 8,
      background: theme.colors.background.secondary,
      padding: 12,
      marginBottom: 20,
    }),
    header: css({
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      marginBottom: 12,
    }),
    title: css({
      fontSize: 16,
      fontWeight: 600,
      margin: 0,
    }),
    subtitle: css({
      fontSize: 13,
      color: theme.colors.text.secondary,
    }),
    message: css({
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      fontSize: 13,
    }),
    tiles: css({
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: 8,
      marginBottom: 12,
    }),
    tile: css({
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: 6,
      background: theme.colors.background.primary,
      padding: '8px 10px',
      minWidth: 0,
    }),
    tileLabel: css({
      fontSize: 11,
      color: theme.colors.text.secondary,
    }),
    tileValue: css({
      fontSize: 20,
      fontWeight: 600,
      lineHeight: 1.3,
      fontVariantNumeric: 'tabular-nums',
    }),
    tileDetail: css({
      fontSize: 12,
      color: theme.colors.text.secondary,
    }),
    findings: css({
      listStyle: 'none',
      margin: 0,
      padding: 0,
    }),
    finding: css({
      display: 'grid',
      gridTemplateColumns: '120px minmax(0, 1fr)',
      gap: 12,
      padding: '8px 0',
      borderTop: `1px solid ${theme.colors.border.weak}`,
      fontSize: 13,
    }),
    findingTitle: css({
      fontWeight: 600,
      marginBottom: 2,
    }),
    advice: css({
      marginTop: 4,
      color: theme.colors.text.primary,
    }),
    adviceLabel: css({
      fontWeight: 600,
    }),
    notes: css({
      margin: '8px 0 0 0',
      paddingLeft: 18,
      fontSize: 12,
      color: theme.colors.text.secondary,
    }),
    details: css({
      marginTop: 8,
    }),
    tableWrapper: css({
      overflowX: 'auto',
      marginTop: 8,
    }),
    tableNote: css({
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginBottom: 6,
    }),
    table: css({
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 13,
    }),
    th: css({
      textAlign: 'left',
      padding: '6px 10px',
      borderBottom: `2px solid ${theme.colors.border.medium}`,
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }),
    td: css({
      padding: '6px 10px',
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
    }),
    meter: css({
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }),
    meterTrack: css({
      width: 80,
      height: 6,
      overflow: 'hidden',
      borderRadius: 3,
      background: theme.colors.background.canvas,
      border: `1px solid ${theme.colors.border.weak}`,
    }),
    meterFill: css({
      height: '100%',
      background: theme.colors.primary.main,
    }),
  };
}

type Styles = ReturnType<typeof getStyles>;

function FindingRow({ finding, styles }: { finding: Finding; styles: Styles }) {
  const badge = SEVERITY_BADGE[finding.severity];
  return (
    <li className={styles.finding} data-testid={`efficiency-finding-${finding.id}`}>
      <div>
        <Badge text={finding.label} color={badge.color} icon={badge.icon} />
      </div>
      <div>
        <div className={styles.findingTitle}>{finding.title}</div>
        <div>{finding.evidence}</div>
        {finding.advice && (
          <div className={styles.advice}>
            <span className={styles.adviceLabel}>Advice: </span>
            {finding.advice}
          </div>
        )}
      </div>
    </li>
  );
}

function GpuRow({ gpu, attributed, styles }: { gpu: GpuEvidence; attributed: boolean; styles: Styles }) {
  const badge = activityBadge(gpu.activity, attributed);
  const activeShare = gpu.observedBuckets > 0 ? gpu.activeBuckets / gpu.observedBuckets : 0;
  return (
    <tr>
      <td className={styles.td}>{gpu.node}</td>
      <td className={styles.td}>{gpu.gpu}</td>
      <td className={styles.td}>
        <Badge text={badge.text} color={badge.color} icon={badge.icon} />
      </td>
      <td className={styles.td}>{formatPercent(gpu.peakUtilization)}</td>
      <td className={styles.td}>{gpu.meanUtilization === undefined ? 'No data' : formatPercent(gpu.meanUtilization)}</td>
      <td className={styles.td}>
        <div className={styles.meter}>
          <div className={styles.meterTrack} aria-hidden="true">
            <div className={styles.meterFill} style={{ width: `${Math.round(activeShare * 100)}%` }} />
          </div>
          <span>{formatShare(activeShare)}</span>
        </div>
      </td>
      <td className={styles.td}>{formatGpuMemory(gpu)}</td>
    </tr>
  );
}

function formatGpuMemory(gpu: GpuEvidence): string {
  if (gpu.memoryPeakMiB === undefined) {
    return 'No data';
  }
  if (gpu.memoryCapacityMiB === undefined) {
    return `${formatGiB(gpu.memoryPeakMiB)} (capacity unknown)`;
  }
  return `${formatGiB(gpu.memoryPeakMiB)} of ${formatGiB(gpu.memoryCapacityMiB)} (${formatShare(gpu.memoryPeakMiB / gpu.memoryCapacityMiB)})`;
}

function GpuTable({ result, styles }: { result: ScoredEfficiency; styles: Styles }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { gpus } = result.gpu;
  const rows = showAll ? gpus : gpus.slice(0, GPU_ROW_LIMIT);
  // Only with "exact" attribution is every row a GPU of the job.
  const attributed = result.gpu.attribution === 'exact';

  return (
    <div className={styles.details}>
      <Button
        variant="secondary"
        fill="text"
        size="sm"
        icon={open ? 'angle-down' : 'angle-right'}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {attributed ? `Per-GPU evidence (${gpus.length})` : `GPUs reporting on the job's nodes (${gpus.length})`}
      </Button>
      {open && (
        <div className={styles.tableWrapper}>
          {!attributed && (
            <div className={styles.tableNote}>
              These are all GPUs that report on the job&apos;s nodes. The telemetry cannot tell which of them belong to the job, so a row
              may describe another job&apos;s GPU.
            </div>
          )}
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Node</th>
                <th className={styles.th}>GPU</th>
                <th className={styles.th}>Activity</th>
                <th className={styles.th}>Peak utilization</th>
                <th className={styles.th}>Mean utilization</th>
                <th className={styles.th}>Active time</th>
                <th className={styles.th}>Peak memory</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((gpu) => (
                <GpuRow key={`${gpu.instance}/${gpu.gpu}`} gpu={gpu} attributed={attributed} styles={styles} />
              ))}
            </tbody>
          </table>
          {gpus.length > rows.length && (
            <Button variant="secondary" fill="text" size="sm" onClick={() => setShowAll(true)}>
              {`Show all ${gpus.length} GPUs`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Notes({ notes, styles }: { notes: string[]; styles: Styles }) {
  return (
    <ul className={styles.notes}>
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

function ScoredBody({ result, styles }: { result: ScoredEfficiency; styles: Styles }) {
  return (
    <>
      <div className={styles.tiles}>
        {buildTiles(result).map((tile) => (
          <div key={tile.id} className={styles.tile} data-testid={`efficiency-tile-${tile.id}`}>
            <div className={styles.tileLabel}>{tile.label}</div>
            <div className={styles.tileValue}>{tile.value}</div>
            <div className={styles.tileDetail}>{tile.detail}</div>
          </div>
        ))}
      </div>
      <ul className={styles.findings}>
        {buildFindings(result).map((finding) => (
          <FindingRow key={finding.id} finding={finding} styles={styles} />
        ))}
      </ul>
      <Notes notes={buildWindowNotes(result)} styles={styles} />
      <GpuTable result={result} styles={styles} />
    </>
  );
}

function Body({ state, onRetry, styles }: { state: EfficiencyState; onRetry: () => void; styles: Styles }) {
  if (state.status === 'loading') {
    return <LoadingPlaceholder text="Scoring job efficiency..." />;
  }
  if (state.status === 'error') {
    return (
      <Alert severity="warning" title="Job efficiency could not be scored">
        <div>{state.message}</div>
        <Button variant="secondary" size="sm" onClick={onRetry} style={{ marginTop: 8 }}>
          Retry
        </Button>
      </Alert>
    );
  }

  const { result } = state;
  if (result.kind === 'not-computed') {
    return (
      <div className={styles.message}>
        <Badge text="Not scored" color="blue" icon="info-circle" />
        <span>{describeNotComputed(result)}</span>
      </div>
    );
  }
  if (result.kind === 'no-telemetry') {
    return (
      <>
        <div className={styles.message}>
          <Badge text="No data" color="blue" icon="question-circle" />
          <span>
            {`${result.settings.gpuUtilizationMetric} has no series for the job's nodes in the scored window, so nothing was scored. Missing telemetry does not mean that the GPUs were idle.`}
          </span>
        </div>
        <Notes notes={buildWindowNotes(result)} styles={styles} />
      </>
    );
  }
  return <ScoredBody result={result} styles={styles} />;
}

interface ScorecardProps {
  state: EfficiencyState;
  onRetry: () => void;
}

/** The efficiency section of the job dashboard, for a given scoring state. */
export function EfficiencyScorecard({ state, onRetry }: ScorecardProps) {
  const styles = useStyles2(getStyles);
  const running = state.status === 'done' && state.result.kind !== 'not-computed' && state.result.window.running;

  return (
    <section className={styles.container} aria-label="Job efficiency">
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Efficiency</h2>
          <div className={styles.subtitle}>The job&apos;s allocation compared with its GPU and CPU telemetry.</div>
        </div>
        {running && (
          <Button variant="secondary" size="sm" icon="sync" onClick={onRetry}>
            Score again
          </Button>
        )}
      </div>
      <Body state={state} onRetry={onRetry} styles={styles} />
    </section>
  );
}

/** Scores a job and shows its efficiency scorecard. */
function ScoredJobEfficiencySection({ job, cluster }: { job: JobRecord; cluster: ClusterSummary }) {
  const { state, reload } = useJobEfficiency(job, cluster);
  return <EfficiencyScorecard state={state} onRetry={reload} />;
}

/** The Efficiency section of a job. It renders nothing, and queries nothing, for a cluster that turned job efficiency off. */
export function JobEfficiencySection({ job, cluster }: { job: JobRecord; cluster: ClusterSummary }) {
  return efficiencyDisabled(cluster.efficiency) ? null : <ScoredJobEfficiencySection job={job} cluster={cluster} />;
}
