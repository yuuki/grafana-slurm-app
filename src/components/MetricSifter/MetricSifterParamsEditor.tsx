import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { Checkbox, Field, Input, RadioButtonGroup, Select, useStyles2 } from '@grafana/ui';
import type { MetricSifterParams } from '../../api/types';
import {
  metricSifterCostModelOptions,
  metricSifterSearchMethodOptions,
  metricSifterSegmentSelectionOptions,
} from './params';

interface Props {
  params: MetricSifterParams;
  onChange: (next: MetricSifterParams) => void;
  idPrefix?: string;
}

const searchMethodSelectOptions: Array<SelectableValue<string>> = metricSifterSearchMethodOptions.map((v) => ({
  label: v,
  value: v,
}));

const costModelSelectOptions: Array<SelectableValue<string>> = metricSifterCostModelOptions.map((v) => ({
  label: v,
  value: v,
}));

const segmentSelectionSelectOptions: Array<SelectableValue<string>> = metricSifterSegmentSelectionOptions.map((v) => ({
  label: v,
  value: v,
}));

const penaltyModeOptions: Array<SelectableValue<string>> = [
  { label: 'AIC', value: 'aic' },
  { label: 'BIC', value: 'bic' },
  { label: 'Numeric', value: 'numeric' },
];

function getStyles(theme: GrafanaTheme2) {
  return {
    row: css({
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: theme.spacing(1.5),
      marginTop: theme.spacing(1.5),
    }),
    field: css({
      marginBottom: 0,
    }),
    hint: css({
      fontSize: theme.typography.bodySmall.fontSize,
      marginTop: theme.spacing(0.5),
      display: 'block',
    }),
  };
}

function parseNumberInput(value: string, fallback: number): number {
  if (value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntegerInput(value: string, fallback: number): number {
  if (value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function NumericField({
  id,
  ariaLabel,
  step,
  value,
  disabled,
  onChange,
  parse,
}: {
  id?: string;
  ariaLabel: string;
  step: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  parse: (raw: string, fallback: number) => number;
}) {
  const [draft, setDraft] = React.useState(String(value));

  React.useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      type="number"
      step={step}
      disabled={disabled}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        const parsed = parse(draft, value);
        onChange(parsed);
        setDraft(String(parsed));
      }}
    />
  );
}

export function MetricSifterParamsEditor({ params, onChange, idPrefix = 'metricsifter' }: Props) {
  const styles = useStyles2(getStyles);

  const update = <K extends keyof MetricSifterParams>(key: K, value: MetricSifterParams[K]) => {
    onChange({
      ...params,
      [key]: value,
    });
  };

  const usesNumericPenalty = typeof params.penalty === 'number';
  const penaltyModeValue = usesNumericPenalty ? 'numeric' : (params.penalty as string);

  return (
    <div>
      <div className={styles.row}>
        <Field label="Search method" className={styles.field}>
          <Select
            inputId={`${idPrefix}-search-method`}
            aria-label="Search method"
            options={searchMethodSelectOptions}
            value={searchMethodSelectOptions.find((o) => o.value === params.searchMethod)}
            onChange={(v) => update('searchMethod', v.value as MetricSifterParams['searchMethod'])}
          />
        </Field>
        <div>
          <Field label="Cost model" className={styles.field}>
            <Select
              inputId={`${idPrefix}-cost-model`}
              aria-label="Cost model"
              options={costModelSelectOptions}
              value={costModelSelectOptions.find((o) => o.value === params.costModel)}
              disabled={params.searchMethod === 'pelt'}
              onChange={(v) => update('costModel', v.value as MetricSifterParams['costModel'])}
            />
          </Field>
          {params.searchMethod === 'pelt' && (
            <span className={styles.hint}>pelt ignores the cost model setting.</span>
          )}
        </div>
      </div>

      <div className={styles.row}>
        <Field label="Penalty" className={styles.field}>
          <RadioButtonGroup
            options={penaltyModeOptions}
            value={penaltyModeValue}
            onChange={(v) => {
              if (v === 'numeric') {
                update('penalty', usesNumericPenalty ? (params.penalty as number) : 1);
              } else {
                update('penalty', v as 'aic' | 'bic');
              }
            }}
          />
        </Field>
        <Field label="Penalty value" className={styles.field}>
          <NumericField
            id={`${idPrefix}-penalty-value`}
            ariaLabel="Penalty value"
            step="0.1"
            disabled={!usesNumericPenalty}
            value={usesNumericPenalty ? (params.penalty as number) : 1}
            onChange={(v) => update('penalty', v)}
            parse={parseNumberInput}
          />
        </Field>
      </div>

      <div className={styles.row}>
        <Field label="Penalty adjust" className={styles.field}>
          <NumericField
            id={`${idPrefix}-penalty-adjust`}
            ariaLabel="Penalty adjust"
            step="0.1"
            value={params.penaltyAdjust}
            onChange={(v) => update('penaltyAdjust', v)}
            parse={parseNumberInput}
          />
        </Field>
        <Field label="Bandwidth" className={styles.field}>
          <NumericField
            id={`${idPrefix}-bandwidth`}
            ariaLabel="Bandwidth"
            step="0.1"
            value={params.bandwidth}
            onChange={(v) => update('bandwidth', v)}
            parse={parseNumberInput}
          />
        </Field>
        <Field label="Segment selection method" className={styles.field}>
          <Select
            inputId={`${idPrefix}-segment-selection-method`}
            aria-label="Segment selection method"
            options={segmentSelectionSelectOptions}
            value={segmentSelectionSelectOptions.find((o) => o.value === params.segmentSelectionMethod)}
            onChange={(v) =>
              update('segmentSelectionMethod', v.value as MetricSifterParams['segmentSelectionMethod'])
            }
          />
        </Field>
        <Field label="Parallel jobs" className={styles.field}>
          <NumericField
            id={`${idPrefix}-parallel-jobs`}
            ariaLabel="Parallel jobs"
            step="1"
            value={params.nJobs}
            onChange={(v) => update('nJobs', v)}
            parse={parseIntegerInput}
          />
        </Field>
      </div>

      <div style={{ marginTop: 12 }}>
        <Checkbox
          aria-label="Skip simple filter"
          label="Skip simple filter"
          value={params.withoutSimpleFilter}
          onChange={(event) => update('withoutSimpleFilter', event.currentTarget.checked)}
        />
      </div>
    </div>
  );
}
