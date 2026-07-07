import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SelectableValue } from '@grafana/data';
import { ClusterEditor } from './ClusterEditor';
import { ClusterProfile } from './types';

jest.mock('../../api/slurmApi', () => ({
  listGrafanaOrgUsers: jest.fn().mockResolvedValue([]),
}));

// ClusterEditor pulls DEFAULT_CPU_EXPR/DEFAULT_GPU_EXPR from
// '../../pages/JobSearch/jobMetrics', which in turn imports '@grafana/runtime'
// for unrelated query helpers. That import chain breaks under the Jest/jsdom
// environment used here, so stub the two placeholder constants directly.
jest.mock('../../pages/JobSearch/jobMetrics', () => ({
  DEFAULT_CPU_EXPR: 'DEFAULT_CPU_EXPR',
  DEFAULT_GPU_EXPR: 'DEFAULT_GPU_EXPR',
}));

jest.mock('@grafana/ui', () => {
  const React = require('react');

  type Option = { label?: string; value?: string };

  function CollapsableSection({
    label,
    isOpen: initialOpen,
    children,
  }: {
    label: string;
    isOpen?: boolean;
    children: React.ReactNode;
  }) {
    const [open, setOpen] = React.useState(!!initialOpen);
    return (
      <div>
        <button type="button" onClick={() => setOpen((current: boolean) => !current)}>
          {label}
        </button>
        {open ? children : null}
      </div>
    );
  }

  function Button({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
    return (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    );
  }

  function Field({
    label,
    children,
    description,
  }: {
    label: string;
    children: React.ReactNode;
    description?: string;
  }) {
    return (
      <div>
        <span>{label}</span>
        {description ? <span>{description}</span> : null}
        {children}
      </div>
    );
  }

  function Input({
    value,
    onChange,
    placeholder,
    readOnly,
  }: {
    value?: string;
    onChange?: (event: { currentTarget: { value: string } }) => void;
    placeholder?: string;
    readOnly?: boolean;
  }) {
    return (
      <input
        placeholder={placeholder}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange?.({ currentTarget: { value: e.currentTarget.value } })}
      />
    );
  }

  function Select({
    options = [],
    onChange,
  }: {
    options?: Option[];
    value?: Option | null;
    onChange: (option: Option) => void;
  }) {
    return (
      <div>
        {options.map((option) => (
          <button key={option.value} type="button" onClick={() => onChange(option)}>
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  function MultiSelect({
    options = [],
    value = [],
    onChange,
    ['aria-label']: ariaLabel,
  }: {
    options?: Option[];
    value?: Option[];
    onChange: (value: Option[]) => void;
    ['aria-label']?: string;
  }) {
    const selectedValues = new Set((value ?? []).map((item) => item.value));
    return (
      <div>
        <div>{`selected-${ariaLabel}:${(value ?? []).map((item) => item.value).join(',')}`}</div>
        {(options ?? []).map((option) => {
          const selected = option.value ? selectedValues.has(option.value) : false;
          return (
            <button
              key={`${ariaLabel}-${option.value}`}
              type="button"
              onClick={() => {
                if (!option.value) {
                  return;
                }
                if (selected) {
                  onChange((value ?? []).filter((item) => item.value !== option.value));
                  return;
                }
                onChange([...(value ?? []), option]);
              }}
            >
              {`${ariaLabel}-${option.label}`}
            </button>
          );
        })}
      </div>
    );
  }

  function Alert({ title }: { title: string }) {
    return <div role="alert">{title}</div>;
  }

  return { CollapsableSection, Button, Field, Input, Select, MultiSelect, Alert };
});

const connectionOptions: Array<SelectableValue<string>> = [
  { label: 'default', value: 'default' },
  { label: 'secondary', value: 'secondary' },
];

function makeCluster(overrides: Partial<ClusterProfile> = {}): ClusterProfile {
  return {
    id: 'a100',
    displayName: 'A100 Cluster',
    connectionId: 'default',
    slurmClusterName: 'gpu_cluster',
    metricsDatasourceUid: 'prom-main',
    metricsType: 'prometheus',
    aggregationNodeLabels: ['host.name', 'instance'],
    instanceLabel: 'instance',
    nodeMatcherMode: 'host:port',
    defaultTemplateId: 'overview',
    metricsFilterLabel: '',
    metricsFilterValue: '',
    cpuUtilizationExpr: '',
    gpuUtilizationExpr: '',
    accessRule: {},
    ...overrides,
  };
}

// The outer CollapsableSection is collapsed by default whenever the cluster
// already has a displayName, so open it before asserting on nested fields.
function openSection(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('ClusterEditor', () => {
  it('renders initial cluster values', () => {
    render(
      <ClusterEditor
        cluster={makeCluster()}
        connectionOptions={connectionOptions}
        onChange={jest.fn()}
        onDelete={jest.fn()}
      />
    );
    openSection('A100 Cluster (a100)');

    expect(screen.getByRole('button', { name: 'A100 Cluster (a100)' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('a100')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A100 Cluster')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gpu_cluster')).toBeInTheDocument();
    expect(screen.getByDisplayValue('prom-main')).toBeInTheDocument();
  });

  it('propagates Display Name, Slurm Cluster Name, and Metrics Datasource UID edits via onChange', () => {
    const onChange = jest.fn();
    const cluster = makeCluster();
    render(
      <ClusterEditor
        cluster={cluster}
        connectionOptions={connectionOptions}
        onChange={onChange}
        onDelete={jest.fn()}
      />
    );
    openSection('A100 Cluster (a100)');

    fireEvent.change(screen.getByDisplayValue('A100 Cluster'), { target: { value: 'A100 Renamed' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...cluster, displayName: 'A100 Renamed' });

    fireEvent.change(screen.getByDisplayValue('gpu_cluster'), { target: { value: 'gpu_cluster_2' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...cluster, slurmClusterName: 'gpu_cluster_2' });

    fireEvent.change(screen.getByDisplayValue('prom-main'), { target: { value: 'prom-alt' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...cluster, metricsDatasourceUid: 'prom-alt' });
  });

  it('propagates a connection selection via onChange', () => {
    const onChange = jest.fn();
    const cluster = makeCluster();
    render(
      <ClusterEditor
        cluster={cluster}
        connectionOptions={connectionOptions}
        onChange={onChange}
        onDelete={jest.fn()}
      />
    );
    openSection('A100 Cluster (a100)');

    fireEvent.click(screen.getByRole('button', { name: 'secondary' }));
    expect(onChange).toHaveBeenCalledWith({ ...cluster, connectionId: 'secondary' });
  });

  it('calls onDelete when the delete button is clicked', () => {
    const onDelete = jest.fn();
    render(
      <ClusterEditor
        cluster={makeCluster()}
        connectionOptions={connectionOptions}
        onChange={jest.fn()}
        onDelete={onDelete}
      />
    );
    openSection('A100 Cluster (a100)');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('edits metrics settings fields inside the collapsed Metrics Settings section', () => {
    const onChange = jest.fn();
    const cluster = makeCluster();
    render(
      <ClusterEditor
        cluster={cluster}
        connectionOptions={connectionOptions}
        onChange={onChange}
        onDelete={jest.fn()}
      />
    );
    openSection('A100 Cluster (a100)');

    fireEvent.click(screen.getByRole('button', { name: 'Metrics Settings' }));

    fireEvent.click(screen.getByRole('button', { name: 'VictoriaMetrics' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...cluster, metricsType: 'victoriametrics' });

    fireEvent.click(screen.getByRole('button', { name: 'hostname' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...cluster, nodeMatcherMode: 'hostname' });

    fireEvent.change(screen.getByPlaceholderText('gpu-cluster-a'), { target: { value: 'zone-b' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...cluster, metricsFilterValue: 'zone-b' });

    fireEvent.change(screen.getByDisplayValue('host.name,instance'), {
      target: { value: 'host.name, instance , custom.label' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...cluster,
      aggregationNodeLabels: ['host.name', 'instance', 'custom.label'],
    });
  });

  it('edits the Default Template ID inside the Other Settings section', () => {
    const onChange = jest.fn();
    const cluster = makeCluster();
    render(
      <ClusterEditor
        cluster={cluster}
        connectionOptions={connectionOptions}
        onChange={onChange}
        onDelete={jest.fn()}
      />
    );
    openSection('A100 Cluster (a100)');

    fireEvent.click(screen.getByRole('button', { name: 'Other Settings' }));

    fireEvent.change(screen.getByDisplayValue('overview'), { target: { value: 'gpu-overview' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...cluster, defaultTemplateId: 'gpu-overview' });
  });

  it('edits allowed roles and allowed users via the nested AccessRuleEditor', () => {
    const onChange = jest.fn();
    const cluster = makeCluster({ accessRule: { allowedRoles: [], allowedUsers: [] } });
    render(
      <ClusterEditor
        cluster={cluster}
        connectionOptions={connectionOptions}
        onChange={onChange}
        onDelete={jest.fn()}
      />
    );
    openSection('A100 Cluster (a100)');

    fireEvent.click(screen.getByRole('button', { name: 'Other Settings' }));

    fireEvent.click(screen.getByRole('button', { name: 'Allowed Roles-Editor' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...cluster,
      accessRule: { allowedRoles: ['Editor'], allowedUsers: [] },
    });
  });
});
