import React, { useMemo } from 'react';
import { Badge, InlineField, Select } from '@grafana/ui';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { buildMetricOptions } from './metricCatalog';
import { RATE_WINDOW } from './metricQuery';
import { isValidMetricName } from './model';

interface Props {
  names: string[];
  loading: boolean;
  value: string;
  metricType: PrometheusMetricType | null;
  onChange: (name: string) => void;
}

export function MetricPicker({ names, loading, value, metricType, onChange }: Props) {
  const options = useMemo(() => buildMetricOptions(names), [names]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <InlineField label="Metric">
        <Select
          aria-label="Metric"
          width={50}
          options={options}
          value={value ? { label: value, value } : null}
          isLoading={loading}
          placeholder="Select a metric"
          allowCustomValue
          onChange={(option) => {
            const name = option?.value;
            if (name && isValidMetricName(name)) {
              onChange(name);
            }
          }}
        />
      </InlineField>
      {value && metricType && <Badge text={metricType} color="blue" />}
      {value && metricType === 'counter' && (
        <Badge text="rate() applied" color="orange" tooltip={`Counters are shown as rate(...[${RATE_WINDOW}])`} />
      )}
    </div>
  );
}
