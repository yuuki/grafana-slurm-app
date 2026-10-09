import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { CompareCell, CompareCellActions } from './CompareCell';
import { formatValue, formatXValue } from './chartScale';
import { CompareViewModel } from './compareView';
import { CompareViewState } from './model';

interface Props extends CompareCellActions {
  model: CompareViewModel;
  state: CompareViewState;
}

function getStyles(theme: GrafanaTheme2) {
  return {
    axisNote: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      marginBottom: theme.spacing(1),
    }),
    grid: css({ display: 'grid', gap: theme.spacing(1) }),
  };
}

export function CompareGrid({ model, state, onOpen, onToggleSelect, onSetBaseline, onOpenDashboard }: Props) {
  const styles = useStyles2(getStyles);
  const [cursorX, setCursorX] = useState<number | null>(null);
  const height = state.columns === '6' ? 72 : 96;
  const template =
    state.columns === 'auto' ? 'repeat(auto-fill, minmax(260px, 1fr))' : `repeat(${state.columns}, minmax(0, 1fr))`;
  const xNote = `X: ${formatXValue(model.xDomain[0], state.xAxis)} – ${formatXValue(model.xDomain[1], state.xAxis)}`;
  const yNote = model.yDomain ? ` · Y: ${formatValue(model.yDomain[0])} – ${formatValue(model.yDomain[1])}` : '';

  return (
    <div>
      <div className={styles.axisNote}>{xNote + yNote}</div>
      <div className={styles.grid} style={{ gridTemplateColumns: template }}>
        {model.cells.map((cell) => (
          <CompareCell
            key={cell.key}
            cell={cell}
            xAxis={state.xAxis}
            xDomain={model.xDomain}
            yDomain={model.yDomain}
            baselineLine={model.baselineLine}
            height={height}
            showDeviation={state.sort === 'deviation'}
            selected={state.selectedJobIds.includes(String(cell.job.jobId))}
            cursorX={cursorX}
            onCursorChange={setCursorX}
            onOpen={onOpen}
            onToggleSelect={onToggleSelect}
            onSetBaseline={onSetBaseline}
            onOpenDashboard={onOpenDashboard}
          />
        ))}
      </div>
    </div>
  );
}
