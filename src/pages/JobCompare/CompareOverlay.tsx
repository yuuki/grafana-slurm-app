import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, useStyles2, useTheme2 } from '@grafana/ui';
import { formatDuration } from '../JobSearch/jobTime';
import { ChartSeries, CompareChart } from './CompareChart';
import { formatValue, formatXValue } from './chartScale';
import { CompareCellModel, CompareViewModel, computeYDomain, selectOverlayCells } from './compareView';
import { CompareViewState, OVERLAY_LINE_LIMIT } from './model';

interface Props {
  model: CompareViewModel;
  state: CompareViewState;
  height?: number;
}

const BASELINE_ID = 'baseline';

function getStyles(theme: GrafanaTheme2) {
  return {
    axisNote: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      margin: theme.spacing(0.5, 0, 1),
    }),
    legend: css({
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: theme.typography.bodySmall.fontSize,
      'th, td': { textAlign: 'left', padding: theme.spacing(0.5, 1), borderBottom: `1px solid ${theme.colors.border.weak}` },
      'tbody tr:hover': { background: theme.colors.action.hover },
    }),
    swatch: css({ display: 'inline-block', width: 12, height: 3, verticalAlign: 'middle' }),
    empty: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
  };
}

export function CompareOverlay({ model, state, height = 360 }: Props) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const { cells, truncated } = useMemo(
    () => selectOverlayCells(model.cells, state.selectedJobIds),
    [model.cells, state.selectedJobIds]
  );
  const lineCells = cells.filter((cell) => !cell.isBaseline);
  const baselineCell = model.baselineLine ? model.cells.find((cell) => cell.isBaseline) ?? null : null;
  const palette = theme.visualization.palette;
  const colorFor = (index: number) => theme.visualization.getColorByName(palette[index % palette.length]);
  const opacityFor = (id: string) => (highlighted && highlighted !== id ? 0.2 : 1);

  const series: ChartSeries[] = [];
  if (model.baselineLine) {
    series.push({
      id: BASELINE_ID,
      x: model.baselineLine.x,
      y: model.baselineLine.y,
      color: theme.colors.text.secondary,
      width: 3,
      opacity: opacityFor(BASELINE_ID),
    });
  }
  lineCells.forEach((cell, index) => {
    series.push({ id: cell.key, x: cell.line!.x, y: cell.line!.y, color: colorFor(index), opacity: opacityFor(cell.key) });
  });
  const yDomain = model.yDomain ?? computeYDomain([...lineCells.map((c) => c.line), model.baselineLine]) ?? [0, 1];

  const renderRow = (cell: CompareCellModel, id: string, color: string, testId: string) => (
    <tr key={id} data-testid={testId} onMouseEnter={() => setHighlighted(id)} onMouseLeave={() => setHighlighted(null)}>
      <td>
        <span className={styles.swatch} style={{ background: color }} />
      </td>
      <td>{`#${cell.job.jobId}${cell.isBaseline ? ' (baseline)' : ''}`}</td>
      <td>{cell.job.name}</td>
      <td>{formatValue(cell.stats.mean)}</td>
      <td>{formatValue(cell.stats.p95)}</td>
      <td>{formatDuration(cell.stats.durationSec)}</td>
    </tr>
  );

  return (
    <div>
      {truncated && (
        <Alert severity="info" title={`Overlay shows up to ${OVERLAY_LINE_LIMIT} jobs`}>
          Shift-click cells in grid view to choose which jobs to overlay.
        </Alert>
      )}
      {series.length === 0 ? (
        <div className={styles.empty}>No loaded series to overlay yet.</div>
      ) : (
        <CompareChart series={series} xDomain={model.xDomain} yDomain={yDomain} height={height} ariaLabel="Overlay of job series" />
      )}
      <div className={styles.axisNote}>
        {`X: ${formatXValue(model.xDomain[0], state.xAxis)} – ${formatXValue(model.xDomain[1], state.xAxis)} · Y: ${formatValue(yDomain[0])} – ${formatValue(yDomain[1])}`}
      </div>
      <table className={styles.legend}>
        <thead>
          <tr>
            <th aria-label="Color" />
            <th>Job</th>
            <th>Name</th>
            <th>Mean</th>
            <th>P95</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {baselineCell && renderRow(baselineCell, BASELINE_ID, theme.colors.text.secondary, 'legend-baseline')}
          {lineCells.map((cell, index) => renderRow(cell, cell.key, colorFor(index), `legend-${cell.job.jobId}`))}
        </tbody>
      </table>
    </div>
  );
}
