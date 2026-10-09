import React from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { IconButton, useStyles2, useTheme2 } from '@grafana/ui';
import { getJobStateTimelineColor } from '../JobSearch/jobStateStyles';
import { formatDuration } from '../JobSearch/jobTime';
import { ChartMarker, ChartSeries, CompareChart } from './CompareChart';
import { formatValue, formatXValue } from './chartScale';
import { ChartLineData, CompareCellModel, computeYDomain } from './compareView';
import { CompareXAxis } from './model';
import { valueAt } from './seriesTransform';

export interface CompareCellProps {
  cell: CompareCellModel;
  xAxis: CompareXAxis;
  xDomain: [number, number];
  yDomain: [number, number] | null;
  baselineLine: ChartLineData | null;
  height: number;
  showDeviation: boolean;
  selected: boolean;
  cursorX: number | null;
  onCursorChange: (x: number | null) => void;
  onOpen: (cell: CompareCellModel) => void;
  onToggleSelect: (cell: CompareCellModel) => void;
  onSetBaseline: (cell: CompareCellModel) => void;
  onOpenDashboard: (cell: CompareCellModel) => void;
}

export type CompareCellActions = Pick<CompareCellProps, 'onOpen' | 'onToggleSelect' | 'onSetBaseline' | 'onOpenDashboard'>;

function getStyles(theme: GrafanaTheme2) {
  return {
    cell: css({
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      padding: theme.spacing(0.75, 1),
      background: theme.colors.background.primary,
      minWidth: 0,
    }),
    flagged: css({ borderColor: theme.colors.error.border }),
    selected: css({ outline: `2px solid ${theme.colors.primary.border}` }),
    header: css({
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: theme.spacing(1),
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    title: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
    dot: css({ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6 }),
    tag: css({ marginLeft: 6, color: theme.colors.text.secondary }),
    actions: css({ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, color: theme.colors.text.secondary }),
    placeholder: css({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: theme.colors.text.secondary,
      background: theme.colors.background.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    footer: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }),
  };
}

function cursorLabel(cursorX: number, xAxis: CompareXAxis, durationSec: number): string {
  if (xAxis === 'progress') {
    return `${formatXValue(cursorX, 'progress')} (${formatDuration(Math.round((cursorX / 100) * durationSec))} elapsed)`;
  }
  return formatXValue(cursorX, xAxis);
}

export function CompareCell({
  cell,
  xAxis,
  xDomain,
  yDomain,
  baselineLine,
  height,
  showDeviation,
  selected,
  cursorX,
  onCursorChange,
  onOpen,
  onToggleSelect,
  onSetBaseline,
  onOpenDashboard,
}: CompareCellProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const { job, line, stats, deviation } = cell;
  const flagged = showDeviation && Boolean(deviation?.flagged);

  const renderBody = () => {
    if (cell.status === 'loading') {
      return <div className={styles.placeholder} style={{ height }} aria-label="Loading series" />;
    }
    if (cell.status === 'error') {
      return (
        <div className={styles.placeholder} style={{ height }}>
          Couldn&apos;t load this job&apos;s series.
        </div>
      );
    }
    if (cell.status === 'no-data' || !line) {
      return (
        <div className={styles.placeholder} style={{ height }}>
          No data for this metric
        </div>
      );
    }
    const series: ChartSeries[] = [];
    if (baselineLine && !cell.isBaseline) {
      series.push({ id: 'baseline', x: baselineLine.x, y: baselineLine.y, color: theme.colors.text.secondary, width: 1, dashed: true });
    }
    series.push({ id: 'job', x: line.x, y: line.y, band: line.band, color: theme.colors.primary.main });
    const lastX = line.x[line.x.length - 1];
    const markers: ChartMarker[] = [];
    if (cell.isRunning && lastX !== undefined) {
      markers.push({ x: lastX, kind: 'running' });
    }
    if (cell.endedAbnormally && lastX !== undefined) {
      markers.push({ x: lastX, kind: 'abnormal-end' });
    }
    return (
      <CompareChart
        series={series}
        xDomain={xDomain}
        yDomain={yDomain ?? computeYDomain([line, baselineLine]) ?? [0, 1]}
        height={height}
        ariaLabel={`Series for job ${job.jobId}`}
        cursorX={cursorX}
        cursorColor={theme.colors.text.secondary}
        markers={markers}
        markerColor={theme.colors.error.text}
        onCursorChange={onCursorChange}
        onClick={(event) => (event.shiftKey || event.metaKey || event.ctrlKey ? onToggleSelect(cell) : onOpen(cell))}
      />
    );
  };

  const readout =
    cursorX !== null && line
      ? `${cursorLabel(cursorX, xAxis, stats.durationSec)}: ${formatValue(valueAt(line.x, line.y, cursorX))}`
      : [
          `mean ${formatValue(stats.mean)}`,
          `p95 ${formatValue(stats.p95)}`,
          formatDuration(stats.durationSec),
          job.gpusTotal > 0 ? `${job.gpusTotal} GPU` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <div
      role="group"
      aria-label={`Job ${job.jobId}`}
      data-flagged={flagged ? 'true' : undefined}
      className={cx(styles.cell, flagged && styles.flagged, selected && styles.selected)}
    >
      <div className={styles.header}>
        <span className={styles.title}>
          <span className={styles.dot} style={{ background: getJobStateTimelineColor(job.state) }} />
          {`#${job.jobId} ${job.name}`}
          {cell.isBaseline && <span className={styles.tag}>baseline</span>}
        </span>
        <span className={styles.actions}>
          <span>{job.state.toLowerCase()}</span>
          <IconButton
            name="anchor"
            size="sm"
            tooltip={cell.isBaseline ? 'Clear baseline' : 'Set as baseline'}
            onClick={() => onSetBaseline(cell)}
          />
          <IconButton name="external-link-alt" size="sm" tooltip="Open job dashboard" onClick={() => onOpenDashboard(cell)} />
        </span>
      </div>
      {renderBody()}
      <div className={styles.footer}>{readout}</div>
      {showDeviation && deviation && (
        <div className={styles.footer}>
          {`${deviation.signedMean >= 0 ? '+' : ''}${formatValue(deviation.signedMean)} vs. median`}
        </div>
      )}
      {xAxis === 'progress' && cell.isRunning && <div className={styles.footer}>running: progress relative to now</div>}
    </div>
  );
}
