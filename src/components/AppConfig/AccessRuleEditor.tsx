import React from 'react';
import { Field, Input } from '@grafana/ui';
import { AccessRule } from './types';

interface Props {
  accessRule: AccessRule;
  onChange: (updated: AccessRule) => void;
}

export function AccessRuleEditor({ accessRule, onChange }: Props) {
  const rolesText = (accessRule.allowedRoles ?? []).join(', ');
  const usersText = (accessRule.allowedUsers ?? []).join(', ');

  const parseList = (text: string): string[] => {
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };

  return (
    <>
      <Field label="Allowed Roles" description="Comma-separated list of Grafana roles (e.g. Viewer, Editor, Admin). Leave empty to allow all.">
        <Input
          value={rolesText}
          onChange={(e) =>
            onChange({ ...accessRule, allowedRoles: parseList(e.currentTarget.value) })
          }
          placeholder="Viewer, Editor, Admin"
        />
      </Field>
      <Field label="Allowed Users" description="Comma-separated list of user logins. Leave empty to allow all.">
        <Input
          value={usersText}
          onChange={(e) =>
            onChange({ ...accessRule, allowedUsers: parseList(e.currentTarget.value) })
          }
          placeholder=""
        />
      </Field>
    </>
  );
}
