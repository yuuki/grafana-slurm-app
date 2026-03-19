import React, { FormEvent } from 'react';
import { SelectableValue } from '@grafana/data';
import { Button, Field, Input, Select } from '@grafana/ui';
import { ClusterSummary } from '../../api/types';
import { MetadataAutocompleteField } from './MetadataAutocompleteField';
import { applyFilterValue, canLookupJob, durationToSeconds, MetadataField, SearchFilters, secondsToDuration } from './model';

type FilterState = SearchFilters;

const stateOptions: Array<SelectableValue<string>> = [
  { label: 'All', value: '' },
  { label: 'Running', value: 'RUNNING' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Failed', value: 'FAILED' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Cancelled', value: 'CANCELLED' },
  { label: 'Timeout', value: 'TIMEOUT' },
];

interface Props {
  clusters: ClusterSummary[];
  filters: FilterState;
  loadingClusters: boolean;
  onChange: (filters: FilterState) => void;
  onSelectMetadata: (field: MetadataField, value: string) => void;
  onSearch: () => void;
  onOpenJob: (clusterId: string, jobId: string) => void;
}

export function JobFilters({ clusters, filters, loadingClusters, onChange, onSelectMetadata, onSearch, onOpenJob }: Props) {
  const clusterOptions: Array<SelectableValue<string>> = clusters.map((cluster) => ({
    label: cluster.displayName,
    value: cluster.id,
  }));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canLookupJob(filters)) {
      onOpenJob(filters.clusterId, filters.jobId || '');
      return;
    }
    onSearch();
  };

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
      <Field label="Cluster" description="Select the Slurm cluster before searching or direct lookup">
        <Select
          options={clusterOptions}
          value={clusterOptions.find((option) => option.value === filters.clusterId) || null}
          onChange={(value: SelectableValue<string>) => onChange({ ...filters, clusterId: value.value || '' })}
          width={24}
          isLoading={loadingClusters}
          placeholder="Choose cluster..."
        />
      </Field>
      <Field label="Job ID">
        <Input
          value={filters.jobId || ''}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...filters, jobId: event.currentTarget.value })}
          placeholder="Direct lookup..."
          width={16}
        />
      </Field>
      <Field label="Job Name">
        <MetadataAutocompleteField
          field="name"
          filters={filters}
          value={filters.name || ''}
          placeholder="Search..."
          width={20}
          onChange={(value) => onChange(applyFilterValue(filters, 'name', value))}
          onSelect={(value) => onSelectMetadata('name', value)}
        />
      </Field>
      <Field label="User">
        <MetadataAutocompleteField
          field="user"
          filters={filters}
          value={filters.user || ''}
          placeholder="Username"
          width={16}
          onChange={(value) => onChange(applyFilterValue(filters, 'user', value))}
          onSelect={(value) => onSelectMetadata('user', value)}
        />
      </Field>
      <Field label="Account">
        <MetadataAutocompleteField
          field="account"
          filters={filters}
          value={filters.account || ''}
          placeholder="Account"
          width={16}
          onChange={(value) => onChange(applyFilterValue(filters, 'account', value))}
          onSelect={(value) => onSelectMetadata('account', value)}
        />
      </Field>
      <Field label="Partition">
        <MetadataAutocompleteField
          field="partition"
          filters={filters}
          value={filters.partition || ''}
          placeholder="Partition"
          width={16}
          onChange={(value) => onChange(applyFilterValue(filters, 'partition', value))}
          onSelect={(value) => onSelectMetadata('partition', value)}
        />
      </Field>
      <Field label="State">
        <Select
          options={stateOptions}
          value={stateOptions.find((option) => option.value === (filters.state || '')) || stateOptions[0]}
          onChange={(value: SelectableValue<string>) => onChange(applyFilterValue(filters, 'state', value.value || ''))}
          width={16}
        />
      </Field>
      <Field label="Nodes (min)">
        <Input
          type="number"
          value={filters.nodesMin || ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onChange(applyFilterValue(filters, 'nodesMin', e.currentTarget.value))
          }
          placeholder="Min"
          width={10}
          min={0}
        />
      </Field>
      <Field label="Nodes (max)">
        <Input
          type="number"
          value={filters.nodesMax || ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onChange(applyFilterValue(filters, 'nodesMax', e.currentTarget.value))
          }
          placeholder="Max"
          width={10}
          min={0}
        />
      </Field>
      <DurationField
        label="Elapsed (min)"
        seconds={filters.elapsedMin || ''}
        onChange={(s) => onChange(applyFilterValue(filters, 'elapsedMin', s))}
      />
      <DurationField
        label="Elapsed (max)"
        seconds={filters.elapsedMax || ''}
        onChange={(s) => onChange(applyFilterValue(filters, 'elapsedMax', s))}
      />
      <div style={{ display: 'flex', alignItems: 'flex-end' }}>
        <Button type="submit" icon={canLookupJob(filters) ? 'external-link-alt' : 'search'} disabled={!filters.clusterId}>
          {canLookupJob(filters) ? 'Open job' : 'Search'}
        </Button>
      </div>
    </form>
  );
}

function DurationField({ label, seconds, onChange }: { label: string; seconds: string; onChange: (s: string) => void }) {
  const { hours, minutes } = secondsToDuration(seconds);
  return (
    <Field label={label}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <Input
          type="number"
          placeholder="h"
          width={6}
          min={0}
          value={hours}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(durationToSeconds(e.currentTarget.value, minutes))}
        />
        <span>h</span>
        <Input
          type="number"
          placeholder="m"
          width={6}
          min={0}
          max={59}
          value={minutes}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(durationToSeconds(hours, e.currentTarget.value))}
        />
        <span>m</span>
      </div>
    </Field>
  );
}
