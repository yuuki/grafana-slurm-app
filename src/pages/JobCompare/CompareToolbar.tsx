import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { Button, InlineField, RadioButtonGroup, Select, useStyles2 } from '@grafana/ui';
import {
  CompareColumns,
  CompareLayout,
  CompareReduce,
  CompareSort,
  CompareViewState,
  CompareXAxis,
  CompareYScale,
} from './model';

interface Props {
  state: CompareViewState;
  onChange: (patch: Partial<CompareViewState>) => void;
  selectedCount: number;
  onOverlaySelected: () => void;
  onClearSelection: () => void;
}

const LAYOUT_OPTIONS: Array<SelectableValue<CompareLayout>> = [
  { label: 'Grid', value: 'grid' },
  { label: 'Overlay', value: 'overlay' },
];
const X_AXIS_OPTIONS: Array<SelectableValue<CompareXAxis>> = [
  { label: 'Elapsed', value: 'elapsed' },
  { label: 'Progress', value: 'progress' },
  { label: 'Absolute', value: 'absolute' },
];
const Y_SCALE_OPTIONS: Array<SelectableValue<CompareYScale>> = [
  { label: 'Shared', value: 'shared' },
  { label: 'Independent', value: 'independent' },
];
const REDUCE_OPTIONS: Array<SelectableValue<CompareReduce>> = [
  { label: 'Mean + min/max band', value: 'band' },
  { label: 'Mean', value: 'mean' },
  { label: 'Max', value: 'max' },
  { label: 'Min', value: 'min' },
];
const SORT_OPTIONS: Array<SelectableValue<CompareSort>> = [
  { label: 'Deviation from median', value: 'deviation' },
  { label: 'Mean (high to low)', value: 'mean-desc' },
  { label: 'Mean (low to high)', value: 'mean-asc' },
  { label: 'Start time', value: 'start' },
  { label: 'Duration', value: 'duration' },
  { label: 'Job ID', value: 'job-id' },
];
const COLUMN_OPTIONS: Array<SelectableValue<CompareColumns>> = [
  { label: 'Auto', value: 'auto' },
  { label: '2', value: '2' },
  { label: '3', value: '3' },
  { label: '4', value: '4' },
  { label: '6', value: '6' },
];
const ELAPSED_LIMIT_OPTIONS: Array<SelectableValue<number>> = [
  { label: 'Whole job', value: 0 },
  { label: 'First 1h', value: 1 },
  { label: 'First 6h', value: 6 },
  { label: 'First 24h', value: 24 },
];

function getStyles(theme: GrafanaTheme2) {
  return {
    toolbar: css({
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.spacing(1),
      padding: theme.spacing(1, 0),
      marginBottom: theme.spacing(1),
      borderTop: `1px solid ${theme.colors.border.weak}`,
      borderBottom: `1px solid ${theme.colors.border.weak}`,
    }),
  };
}

export function CompareToolbar({ state, onChange, selectedCount, onOverlaySelected, onClearSelection }: Props) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.toolbar}>
      <InlineField label="Layout">
        <RadioButtonGroup size="sm" options={LAYOUT_OPTIONS} value={state.layout} onChange={(layout) => onChange({ layout })} />
      </InlineField>
      <InlineField label="X axis">
        <RadioButtonGroup size="sm" options={X_AXIS_OPTIONS} value={state.xAxis} onChange={(xAxis) => onChange({ xAxis })} />
      </InlineField>
      {state.xAxis === 'elapsed' && (
        <InlineField label="Elapsed range">
          <Select
            aria-label="Elapsed range"
            width={14}
            options={ELAPSED_LIMIT_OPTIONS}
            value={state.elapsedLimitHours}
            onChange={(option) => onChange({ elapsedLimitHours: option.value ?? 0 })}
          />
        </InlineField>
      )}
      <InlineField label="Reduce">
        <Select
          aria-label="Reduce"
          width={24}
          options={REDUCE_OPTIONS}
          value={state.reduce}
          onChange={(option) => option.value && onChange({ reduce: option.value })}
        />
      </InlineField>
      <InlineField label="Y">
        <RadioButtonGroup size="sm" options={Y_SCALE_OPTIONS} value={state.yScale} onChange={(yScale) => onChange({ yScale })} />
      </InlineField>
      <InlineField label="Sort">
        <Select
          aria-label="Sort"
          width={26}
          options={SORT_OPTIONS}
          value={state.sort}
          onChange={(option) => option.value && onChange({ sort: option.value })}
        />
      </InlineField>
      {state.layout === 'grid' && (
        <InlineField label="Columns">
          <Select
            aria-label="Columns"
            width={10}
            options={COLUMN_OPTIONS}
            value={state.columns}
            onChange={(option) => option.value && onChange({ columns: option.value })}
          />
        </InlineField>
      )}
      {selectedCount > 0 && (
        <>
          <Button size="sm" variant="secondary" onClick={onOverlaySelected}>
            {`Overlay selected (${selectedCount})`}
          </Button>
          <Button size="sm" variant="secondary" fill="text" onClick={onClearSelection}>
            Clear selection
          </Button>
        </>
      )}
    </div>
  );
}
