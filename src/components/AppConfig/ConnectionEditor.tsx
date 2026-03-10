import React from 'react';
import { Button, CollapsableSection, Field, Input, SecretInput } from '@grafana/ui';
import { ConnectionFormState } from './types';

interface Props {
  connection: ConnectionFormState;
  onChange: (updated: ConnectionFormState) => void;
  onDelete: () => void;
}

export function ConnectionEditor({ connection, onChange, onDelete }: Props) {
  const update = (patch: Partial<ConnectionFormState>) => {
    onChange({ ...connection, ...patch });
  };

  const label = `${connection.id}${connection.dbHost ? ` — ${connection.dbHost}` : ''}`;

  return (
    <CollapsableSection label={label} isOpen={!connection.dbHost}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Button variant="destructive" size="sm" icon="trash-alt" onClick={onDelete}>
          Delete
        </Button>
      </div>
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
