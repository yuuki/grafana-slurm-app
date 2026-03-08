import React, { FormEvent } from 'react';
import { SelectableValue } from '@grafana/data';
import { Button, Field, Input, Select } from '@grafana/ui';
import { ClusterSummary } from '../../api/types';
import { canLookupJob, SearchFilters } from './model';

export type FilterState = SearchFilters;

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
  onSearch: () => void;
  onOpenJob: (clusterId: string, jobId: string) => void;
}

export function JobFilters({ clusters, filters, loadingClusters, onChange, onSearch, onOpenJob }: Props) {
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
        <Input
          value={filters.name || ''}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...filters, name: event.currentTarget.value })}
          placeholder="Search..."
          width={20}
        />
      </Field>
      <Field label="User">
        <Input
          value={filters.user || ''}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...filters, user: event.currentTarget.value })}
          placeholder="Username"
          width={16}
        />
      </Field>
      <Field label="Account">
        <Input
          value={filters.account || ''}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...filters, account: event.currentTarget.value })}
          placeholder="Account"
          width={16}
        />
      </Field>
      <Field label="Partition">
        <Input
          value={filters.partition || ''}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...filters, partition: event.currentTarget.value })}
          placeholder="Partition"
          width={16}
        />
      </Field>
      <Field label="State">
        <Select
          options={stateOptions}
          value={stateOptions.find((option) => option.value === (filters.state || '')) || stateOptions[0]}
          onChange={(value: SelectableValue<string>) => onChange({ ...filters, state: value.value })}
          width={16}
        />
      </Field>
      <div style={{ display: 'flex', alignItems: 'flex-end' }}>
        <Button type="submit" icon={canLookupJob(filters) ? 'external-link-alt' : 'search'} disabled={!filters.clusterId}>
          {canLookupJob(filters) ? 'Open job' : 'Search'}
        </Button>
      </div>
    </form>
  );
}
