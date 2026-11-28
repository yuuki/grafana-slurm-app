import React from 'react';
import { SelectableValue } from '@grafana/data';
import { Button, Checkbox, CollapsableSection, Field, Input, Select } from '@grafana/ui';
import { ClusterProfile } from './types';
import { AccessRuleEditor } from './AccessRuleEditor';
import { DEFAULT_CPU_EXPR, DEFAULT_GPU_EXPR } from '../../pages/JobSearch/jobMetrics';
import { EFFICIENCY_DEFAULTS, EFFICIENCY_FIELD_LABELS } from '../../pages/JobDashboard/efficiency/settings';
import { EfficiencySettings } from '../../api/types';

const METRICS_TYPE_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'Prometheus', value: 'prometheus' },
  { label: 'VictoriaMetrics', value: 'victoriametrics' },
];

const NODE_MATCHER_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'host:port', value: 'host:port' },
  { label: 'hostname', value: 'hostname' },
];

const EFFICIENCY_NAME_FIELDS = [
  {
    field: 'gpuUtilizationMetric',
    description: 'Per-GPU utilization gauge in percent, used by the job efficiency scorecard. Leave empty for the DCGM exporter default.',
  },
  { field: 'gpuMemoryUsedMetric', description: 'Per-GPU memory in use, in MiB. Leave empty for default.' },
  { field: 'gpuMemoryFreeMetric', description: "Per-GPU free memory, in MiB. A GPU's capacity is used + free. Leave empty for default." },
  { field: 'gpuIdLabel', description: 'Label that tells the GPUs of one node apart. Leave empty for default.' },
] as const;

const EFFICIENCY_PERCENT_FIELDS = [
  {
    field: 'idleGpuUtilizationPercent',
    hint: 'idle baseline',
    description: 'Idle baseline: a GPU counts as active when its utilization exceeds this value. Leave empty for default.',
  },
  {
    field: 'lowGpuMemoryPercent',
    hint: 'low memory',
    description: 'A job whose fullest GPU stayed below this share of its memory is flagged. Leave empty for default.',
  },
] as const;

/** An empty input means "use the default". The range is checked on save. */
function parsePercent(text: string): number | undefined {
  const value = Number(text);
  return text.trim() === '' || Number.isNaN(value) ? undefined : value;
}

/** The fields of a cluster's job efficiency settings; the placeholders show the defaults. */
function EfficiencySettingsFields({ settings, onChange }: { settings: EfficiencySettings; onChange: (settings: EfficiencySettings) => void }) {
  return (
    <>
      <Field
        label="Job Efficiency"
        description="On by default. It adds 2 metrics queries to every page of Job Search results with GPU jobs, and 8 to every opened GPU job. Turn it off for a cluster whose metrics backend should not take these queries, or whose GPU telemetry does not meet the requirements."
      >
        <Checkbox
          label="Turn off job efficiency for this cluster"
          value={settings.disabled === true}
          onChange={(e) => onChange({ ...settings, disabled: e.currentTarget.checked ? true : undefined })}
        />
      </Field>
      {EFFICIENCY_NAME_FIELDS.map(({ field, description }) => (
        <Field key={field} label={EFFICIENCY_FIELD_LABELS[field]} description={description}>
          <Input
            value={settings[field] ?? ''}
            onChange={(e) => onChange({ ...settings, [field]: e.currentTarget.value })}
            placeholder={EFFICIENCY_DEFAULTS[field]}
          />
        </Field>
      ))}
      {EFFICIENCY_PERCENT_FIELDS.map(({ field, hint, description }) => (
        <Field key={field} label={EFFICIENCY_FIELD_LABELS[field]} description={description}>
          <Input
            type="number"
            min={0}
            max={100}
            value={settings[field] === undefined ? '' : String(settings[field])}
            onChange={(e) => onChange({ ...settings, [field]: parsePercent(e.currentTarget.value) })}
            placeholder={`${EFFICIENCY_DEFAULTS[field]} (${hint})`}
          />
        </Field>
      ))}
    </>
  );
}

interface Props {
  cluster: ClusterProfile;
  connectionOptions: Array<SelectableValue<string>>;
  onChange: (updated: ClusterProfile) => void;
  onDelete: () => void;
}

export function ClusterEditor({ cluster, connectionOptions, onChange, onDelete }: Props) {
  const update = (patch: Partial<ClusterProfile>) => {
    onChange({ ...cluster, ...patch });
  };

  const label = cluster.displayName
    ? `${cluster.displayName} (${cluster.id})`
    : cluster.id;

  return (
    <CollapsableSection label={label} isOpen={!cluster.displayName}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Button variant="destructive" size="sm" icon="trash-alt" onClick={onDelete}>
          Delete
        </Button>
      </div>

      <Field label="ID" description="Unique identifier for this cluster.">
        <Input value={cluster.id} readOnly />
      </Field>
      <Field label="Display Name">
        <Input
          value={cluster.displayName}
          onChange={(e) => update({ displayName: e.currentTarget.value })}
        />
      </Field>
      <Field label="Connection" description="Select the database connection for this cluster.">
        <Select
          options={connectionOptions}
          value={connectionOptions.find((o) => o.value === cluster.connectionId) ?? null}
          onChange={(v) => update({ connectionId: v.value ?? '' })}
        />
      </Field>
      <Field label="Slurm Cluster Name" description="Cluster name as registered in slurmdbd.">
        <Input
          value={cluster.slurmClusterName}
          onChange={(e) => update({ slurmClusterName: e.currentTarget.value })}
        />
      </Field>
      <Field label="Metrics Datasource UID" description="Grafana datasource UID for Prometheus/VictoriaMetrics.">
        <Input
          value={cluster.metricsDatasourceUid}
          onChange={(e) => update({ metricsDatasourceUid: e.currentTarget.value })}
        />
      </Field>
      <CollapsableSection label="Metrics Settings" isOpen={false}>
        <Field label="Metrics Type">
          <Select
            options={METRICS_TYPE_OPTIONS}
            value={METRICS_TYPE_OPTIONS.find((o) => o.value === (cluster.metricsType ?? 'prometheus')) ?? null}
            onChange={(v) => update({ metricsType: (v.value as ClusterProfile['metricsType']) ?? 'prometheus' })}
          />
        </Field>
        <Field label="Metrics Filter Label" description="Label name for cluster identification in PromQL (e.g. zone). Leave empty for no filter.">
          <Input
            value={cluster.metricsFilterLabel ?? ''}
            onChange={(e) => update({ metricsFilterLabel: e.currentTarget.value })}
            placeholder="zone"
          />
        </Field>
        <Field label="Metrics Filter Value" description="Label value for cluster identification (e.g. gpu-cluster-a).">
          <Input
            value={cluster.metricsFilterValue ?? ''}
            onChange={(e) => update({ metricsFilterValue: e.currentTarget.value })}
            placeholder="gpu-cluster-a"
          />
        </Field>
        <Field label="Instance Label">
          <Input
            value={cluster.instanceLabel ?? 'instance'}
            onChange={(e) => update({ instanceLabel: e.currentTarget.value })}
          />
        </Field>
        <Field
          label="Aggregation Node Labels"
          description="Comma-separated node label candidates for aggregated GPU metrics (e.g. host.name,instance)."
        >
          <Input
            value={(cluster.aggregationNodeLabels ?? ['host.name', cluster.instanceLabel ?? 'instance']).join(',')}
            onChange={(e) =>
              update({
                aggregationNodeLabels: e.currentTarget.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field
          label="CPU Utilization Expression"
          description="PromQL template for CPU utilization. Use ${matcher} for node/filter labels and ${formattedLabel} for the instance label. Leave empty for default."
        >
          <Input
            value={cluster.cpuUtilizationExpr ?? ''}
            onChange={(e) => update({ cpuUtilizationExpr: e.currentTarget.value })}
            placeholder={DEFAULT_CPU_EXPR}
          />
        </Field>
        <Field
          label="GPU Utilization Expression"
          description="PromQL template for GPU utilization. Use ${matcher} and ${formattedLabel} placeholders. Leave empty for default."
        >
          <Input
            value={cluster.gpuUtilizationExpr ?? ''}
            onChange={(e) => update({ gpuUtilizationExpr: e.currentTarget.value })}
            placeholder={DEFAULT_GPU_EXPR}
          />
        </Field>
        <Field label="Node Matcher Mode">
          <Select
            options={NODE_MATCHER_OPTIONS}
            value={NODE_MATCHER_OPTIONS.find((o) => o.value === (cluster.nodeMatcherMode ?? 'host:port')) ?? null}
            onChange={(v) => update({ nodeMatcherMode: (v.value as ClusterProfile['nodeMatcherMode']) ?? 'host:port' })}
          />
        </Field>
      </CollapsableSection>

      <CollapsableSection label="Efficiency Settings" isOpen={false}>
        <EfficiencySettingsFields settings={cluster.efficiency ?? {}} onChange={(efficiency) => update({ efficiency })} />
      </CollapsableSection>

      <CollapsableSection label="Other Settings" isOpen={false}>
        <Field label="Default Template ID">
          <Input
            value={cluster.defaultTemplateId ?? 'overview'}
            onChange={(e) => update({ defaultTemplateId: e.currentTarget.value })}
          />
        </Field>
        <AccessRuleEditor
          accessRule={cluster.accessRule ?? {}}
          onChange={(accessRule) => update({ accessRule })}
        />
      </CollapsableSection>
    </CollapsableSection>
  );
}
