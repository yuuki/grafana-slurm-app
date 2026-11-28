import React from 'react';
import { Checkbox, Field, Input } from '@grafana/ui';
import type { PhaseSettings } from '../../api/types';
import { PHASE_FIELD_LABELS, PHASE_SETTING_DEFAULTS, PHASE_SETTING_LIMITS } from '../../pages/JobDashboard/phases/settings';

interface Props {
  settings: PhaseSettings;
  onChange: (settings: PhaseSettings) => void;
}

const NAME_FIELDS = [
  {
    field: 'gpuPowerMetric',
    description: 'Per-GPU power gauge. Only its level relative to the job matters, so any unit works. Leave empty for the DCGM exporter default.',
  },
  {
    field: 'gpuUtilizationMetric',
    description: 'Per-GPU utilization gauge in percent (0 to 100, not a ratio). Idle GPUs, and so stalls, are recognised by it. Leave empty for the DCGM exporter default.',
  },
] as const;

const NUMBER_FIELDS = [
  {
    field: 'idleGpuUtilizationPercent',
    description: 'A GPU is idle in a time bucket when none of its utilization samples exceeds this value. Leave empty for default.',
  },
  {
    field: 'stallMinutes',
    description: 'Every GPU of a job idle for this long, after the job computed, is reported as stalled. Shorter idle stretches stay unclassified. Leave empty for default.',
  },
  {
    field: 'checkpointMinWriteMibPerSecond',
    description: 'Smallest write rate of one node that counts as a write burst of a checkpoint. Leave empty for default.',
  },
] as const;

/** An empty input means "use the default". The range is checked on save. */
function parseNumber(text: string): number | undefined {
  const value = Number(text);
  return text.trim() === '' || Number.isNaN(value) ? undefined : value;
}

/** The job phase settings of a cluster. The placeholders show the defaults that apply while a field is empty. */
export function PhaseSettingsEditor({ settings, onChange }: Props) {
  return (
    <>
      <Field
        label="Job Phases"
        description="Off by default. When on, the Job Dashboard shows the phases of a job (startup, compute, checkpoint, stalled). Opening a job then sends up to 4 instant queries and 6 range queries to the metrics datasource, one after another; a job with hundreds of nodes needs more requests, because a long query is sent in parts."
      >
        <Checkbox
          label="Analyse job phases for this cluster"
          value={settings.enabled === true}
          onChange={(event) => onChange({ ...settings, enabled: event.currentTarget.checked ? true : undefined })}
        />
      </Field>
      {NAME_FIELDS.map(({ field, description }) => (
        <Field key={field} label={PHASE_FIELD_LABELS[field]} description={description}>
          <Input
            value={settings[field] ?? ''}
            onChange={(event) => onChange({ ...settings, [field]: event.currentTarget.value })}
            placeholder={PHASE_SETTING_DEFAULTS[field]}
          />
        </Field>
      ))}
      <Field
        label={PHASE_FIELD_LABELS.storageWriteMetrics}
        description={`Comma-separated counters of bytes written, at most ${PHASE_SETTING_LIMITS.maxStorageWriteMetrics}; their rates are added. A checkpoint is reported only where they show a write burst, so name the storage that jobs write checkpoints to (for a network file system, a client-side counter). Leave empty for the node_exporter default, which covers local disks only.`}
      >
        <Input
          value={(settings.storageWriteMetrics ?? []).join(',')}
          onChange={(event) => {
            const text = event.currentTarget.value;
            onChange({ ...settings, storageWriteMetrics: text === '' ? undefined : text.split(',').map((name) => name.trim()) });
          }}
          placeholder={PHASE_SETTING_DEFAULTS.storageWriteMetrics.join(',')}
        />
      </Field>
      {NUMBER_FIELDS.map(({ field, description }) => (
        <Field key={field} label={PHASE_FIELD_LABELS[field]} description={description}>
          <Input
            type="number"
            min={PHASE_SETTING_LIMITS[field].min}
            max={PHASE_SETTING_LIMITS[field].max}
            value={settings[field] === undefined ? '' : String(settings[field])}
            onChange={(event) => onChange({ ...settings, [field]: parseNumber(event.currentTarget.value) })}
            placeholder={String(PHASE_SETTING_DEFAULTS[field])}
          />
        </Field>
      ))}
    </>
  );
}
