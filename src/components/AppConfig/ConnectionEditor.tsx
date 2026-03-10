import React, { useMemo } from 'react';
import { SelectableValue } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { Button, CollapsableSection, Field, Input, SecretInput, Select } from '@grafana/ui';
import { ConnectionFormState } from './types';

interface Props {
  connection: ConnectionFormState;
  onChange: (updated: ConnectionFormState) => void;
  onDelete: () => void;
}

function getMysqlDatasourceOptions(): Array<SelectableValue<string>> {
  try {
    const datasources = getDataSourceSrv().getList({ pluginId: 'mysql' });
    return datasources.map((ds) => ({
      label: ds.name,
      value: ds.uid,
      description: ds.url ? `${ds.url}` : undefined,
    }));
  } catch {
    return [];
  }
}

export function ConnectionEditor({ connection, onChange, onDelete }: Props) {
  const dsOptions = useMemo(() => getMysqlDatasourceOptions(), []);

  const update = (patch: Partial<ConnectionFormState>) => {
    onChange({ ...connection, ...patch });
  };

  const handleImportFromDatasource = (selected: SelectableValue<string>) => {
    if (!selected.value) {
      return;
    }
    const ds = getDataSourceSrv().getInstanceSettings(selected.value);
    if (!ds) {
      return;
    }
    // MySQL datasource: url contains "host:port", database is in the database field or jsonData
    const dbHost = ds.url || '';
    const dbName = (ds as any).database || (ds.jsonData as any)?.database || connection.dbName || 'slurm_acct_db';
    const dbUser = (ds as any).username || (ds.jsonData as any)?.user || connection.dbUser || '';

    update({ dbHost, dbName, dbUser });
  };

  const label = `${connection.id}${connection.dbHost ? ` — ${connection.dbHost}` : ''}`;

  return (
    <CollapsableSection label={label} isOpen={!connection.dbHost}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Button variant="destructive" size="sm" icon="trash-alt" onClick={onDelete}>
          Delete
        </Button>
      </div>

      {dsOptions.length > 0 && (
        <Field label="Import from Datasource" description="Select an existing MySQL datasource to auto-fill host, database, and user. Password must be entered separately.">
          <Select
            options={dsOptions}
            value={null}
            onChange={handleImportFromDatasource}
            placeholder="Select a MySQL datasource..."
            isClearable
          />
        </Field>
      )}

      <Field label="ID" description="Unique identifier for this connection.">
        <Input value={connection.id} readOnly />
      </Field>
      <Field label="DB Host" description='Database host in "host:port" format.'>
        <Input
          value={connection.dbHost}
          onChange={(e) => update({ dbHost: e.currentTarget.value })}
          placeholder="mysql:3306"
        />
      </Field>
      <Field label="DB Name">
        <Input
          value={connection.dbName ?? ''}
          onChange={(e) => update({ dbName: e.currentTarget.value })}
          placeholder="slurm_acct_db"
        />
      </Field>
      <Field label="DB User">
        <Input
          value={connection.dbUser}
          onChange={(e) => update({ dbUser: e.currentTarget.value })}
          placeholder="slurm"
        />
      </Field>
      <Field label="Password">
        <SecretInput
          isConfigured={connection.isPasswordConfigured}
          value={connection.password}
          onChange={(e) => update({ password: e.currentTarget.value })}
          onReset={() => update({ password: '', isPasswordConfigured: false })}
        />
      </Field>
    </CollapsableSection>
  );
}
