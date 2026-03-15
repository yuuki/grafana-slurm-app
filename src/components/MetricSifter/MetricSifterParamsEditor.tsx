import React from 'react';
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

function rowStyle(): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 12,
    marginTop: 12,
  };
}

function fieldStyle(): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 13,
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
    <input
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
  const update = <K extends keyof MetricSifterParams>(key: K, value: MetricSifterParams[K]) => {
    onChange({
      ...params,
      [key]: value,
    });
  };

  const usesNumericPenalty = typeof params.penalty === 'number';

  return (
    <div>
      <div style={rowStyle()}>
        <label htmlFor={`${idPrefix}-search-method`} style={fieldStyle()}>
          <span>Search method</span>
          <select
            id={`${idPrefix}-search-method`}
            aria-label="Search method"
            value={params.searchMethod}
            onChange={(event) => update('searchMethod', event.currentTarget.value as MetricSifterParams['searchMethod'])}
          >
            {metricSifterSearchMethodOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-cost-model`} style={fieldStyle()}>
          <span>Cost model</span>
          <select
            id={`${idPrefix}-cost-model`}
            aria-label="Cost model"
            value={params.costModel}
            disabled={params.searchMethod === 'pelt'}
            onChange={(event) => update('costModel', event.currentTarget.value as MetricSifterParams['costModel'])}
          >
            {metricSifterCostModelOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {params.searchMethod === 'pelt' && <span>pelt ignores the cost model setting.</span>}
        </label>
      </div>

      <fieldset style={{ ...fieldStyle(), marginTop: 12, border: 0, padding: 0 }}>
        <legend style={{ marginBottom: 6 }}>Penalty</legend>
        <label>
          <input
            type="radio"
            name={`${idPrefix}-penalty-mode`}
            checked={params.penalty === 'aic'}
            onChange={() => update('penalty', 'aic')}
          />{' '}
          AIC
        </label>
        <label>
          <input
            type="radio"
            name={`${idPrefix}-penalty-mode`}
            checked={params.penalty === 'bic'}
            onChange={() => update('penalty', 'bic')}
          />{' '}
          BIC
        </label>
        <label>
          <input
            type="radio"
            name={`${idPrefix}-penalty-mode`}
            aria-label="Use numeric penalty"
            checked={usesNumericPenalty}
            onChange={() => update('penalty', usesNumericPenalty ? params.penalty : 1)}
          />{' '}
          Use numeric penalty
        </label>
        <label htmlFor={`${idPrefix}-penalty-value`} style={fieldStyle()}>
          <span>Penalty value</span>
          <NumericField
            id={`${idPrefix}-penalty-value`}
            ariaLabel="Penalty value"
            step="0.1"
            disabled={!usesNumericPenalty}
            value={usesNumericPenalty ? (params.penalty as number) : 1}
            onChange={(v) => update('penalty', v)}
            parse={parseNumberInput}
          />
        </label>
      </fieldset>

      <div style={rowStyle()}>
        <label htmlFor={`${idPrefix}-penalty-adjust`} style={fieldStyle()}>
          <span>Penalty adjust</span>
          <NumericField
            id={`${idPrefix}-penalty-adjust`}
            ariaLabel="Penalty adjust"
            step="0.1"
            value={params.penaltyAdjust}
            onChange={(v) => update('penaltyAdjust', v)}
            parse={parseNumberInput}
          />
        </label>
        <label htmlFor={`${idPrefix}-bandwidth`} style={fieldStyle()}>
          <span>Bandwidth</span>
          <NumericField
            id={`${idPrefix}-bandwidth`}
            ariaLabel="Bandwidth"
            step="0.1"
            value={params.bandwidth}
            onChange={(v) => update('bandwidth', v)}
            parse={parseNumberInput}
          />
        </label>
        <label htmlFor={`${idPrefix}-segment-selection-method`} style={fieldStyle()}>
          <span>Segment selection method</span>
          <select
            id={`${idPrefix}-segment-selection-method`}
            aria-label="Segment selection method"
            value={params.segmentSelectionMethod}
            onChange={(event) =>
              update('segmentSelectionMethod', event.currentTarget.value as MetricSifterParams['segmentSelectionMethod'])
            }
          >
            {metricSifterSegmentSelectionOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-parallel-jobs`} style={fieldStyle()}>
          <span>Parallel jobs</span>
          <NumericField
            id={`${idPrefix}-parallel-jobs`}
            ariaLabel="Parallel jobs"
            step="1"
            value={params.nJobs}
            onChange={(v) => update('nJobs', v)}
            parse={parseIntegerInput}
          />
        </label>
      </div>

      <label style={{ ...fieldStyle(), marginTop: 12 }}>
        <span>
          <input
            type="checkbox"
            aria-label="Skip simple filter"
            checked={params.withoutSimpleFilter}
            onChange={(event) => update('withoutSimpleFilter', event.currentTarget.checked)}
          />{' '}
          Skip simple filter
        </span>
      </label>
    </div>
  );
}
