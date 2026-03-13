import React from 'react';
import { SelectableValue } from '@grafana/data';
import { Button, CollapsableSection, Field, Input, Select } from '@grafana/ui';
import { ClusterProfile } from './types';
import { AccessRuleEditor } from './AccessRuleEditor';

const METRICS_TYPE_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'Prometheus', value: 'prometheus' },
  { label: 'VictoriaMetrics', value: 'victoriametrics' },
];

const NODE_MATCHER_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'host:port', value: 'host:port' },
  { label: 'hostname', value: 'hostname' },
];

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
        <Field label="Node Matcher Mode">
          <Select
            options={NODE_MATCHER_OPTIONS}
            value={NODE_MATCHER_OPTIONS.find((o) => o.value === (cluster.nodeMatcherMode ?? 'host:port')) ?? null}
            onChange={(v) => update({ nodeMatcherMode: (v.value as ClusterProfile['nodeMatcherMode']) ?? 'host:port' })}
          />
        </Field>
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
