import React, { useCallback, useMemo, useState } from 'react';
import { SelectableValue } from '@grafana/data';
import { Alert, Field, MultiSelect } from '@grafana/ui';
import { listGrafanaOrgUsers } from '../../api/slurmApi';
import { AccessRule } from './types';

interface Props {
  accessRule: AccessRule;
  onChange: (updated: AccessRule) => void;
}

const ROLE_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'Viewer', value: 'Viewer' },
  { label: 'Editor', value: 'Editor' },
  { label: 'Admin', value: 'Admin' },
];

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function toSelectedOptions(values: string[], options: Array<SelectableValue<string>>): Array<SelectableValue<string>> {
  const optionMap = new Map(options.map((option) => [option.value, option]));

  return dedupeStrings(values).map((value) => optionMap.get(value) ?? { label: value, value });
}

function mergeUserOptions(
  options: Array<SelectableValue<string>>,
  values: string[]
): Array<SelectableValue<string>> {
  const merged = new Map<string, SelectableValue<string>>();

  for (const option of options) {
    if (!option.value) {
      continue;
    }
    merged.set(option.value, option);
  }

  for (const value of dedupeStrings(values)) {
    if (!merged.has(value)) {
      merged.set(value, { label: value, value });
    }
  }

  return [...merged.values()].sort((left, right) => (left.label ?? '').localeCompare(right.label ?? ''));
}

export function AccessRuleEditor({ accessRule, onChange }: Props) {
  const [userOptions, setUserOptions] = useState<Array<SelectableValue<string>>>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersLoaded, setUsersLoaded] = useState(false);

  const selectedRoles = useMemo(() => toSelectedOptions(accessRule.allowedRoles ?? [], ROLE_OPTIONS), [accessRule.allowedRoles]);
  const availableUserOptions = useMemo(
    () => mergeUserOptions(userOptions, accessRule.allowedUsers ?? []),
    [accessRule.allowedUsers, userOptions]
  );
  const selectedUsers = useMemo(
    () => toSelectedOptions(accessRule.allowedUsers ?? [], availableUserOptions),
    [accessRule.allowedUsers, availableUserOptions]
  );

  const handleRolesChange = useCallback(
    (options: Array<SelectableValue<string>>) => {
      onChange({ ...accessRule, allowedRoles: dedupeStrings(options.map((option) => option.value ?? '')) });
    },
    [accessRule, onChange]
  );

  const handleUsersChange = useCallback(
    (options: Array<SelectableValue<string>>) => {
      onChange({ ...accessRule, allowedUsers: dedupeStrings(options.map((option) => option.value ?? '')) });
    },
    [accessRule, onChange]
  );

  const loadUsers = useCallback(async () => {
    if (usersLoaded || loadingUsers) {
      return;
    }

    setLoadingUsers(true);
    setUsersError(null);
    try {
      const users = await listGrafanaOrgUsers();
      setUserOptions(users.map((user) => ({ label: user.displayLabel, value: user.login })));
      setUsersLoaded(true);
    } catch (error) {
      setUsersError(error instanceof Error ? error.message : 'Failed to load Grafana users');
    } finally {
      setLoadingUsers(false);
    }
  }, [loadingUsers, usersLoaded]);

  const handleCreateUserOption = useCallback(
    (value: string) => {
      const normalized = dedupeStrings([value])[0];
      if (!normalized) {
        return;
      }

      if (!availableUserOptions.some((option) => option.value === normalized)) {
        setUserOptions((current) => mergeUserOptions(current, [normalized]));
      }

      onChange({
        ...accessRule,
        allowedUsers: dedupeStrings([...(accessRule.allowedUsers ?? []), normalized]),
      });
    },
    [accessRule, availableUserOptions, onChange]
  );

  return (
    <>
      <Field label="Allowed Roles" description="Select one or more Grafana roles. Leave empty to allow all.">
        <MultiSelect
          aria-label="Allowed Roles"
          options={ROLE_OPTIONS}
          value={selectedRoles}
          onChange={handleRolesChange}
          placeholder="Select roles"
        />
      </Field>
      <Field label="Allowed Users" description="Select Grafana user logins for the current org. Leave empty to allow all.">
        <MultiSelect
          aria-label="Allowed Users"
          options={availableUserOptions}
          value={selectedUsers}
          onChange={handleUsersChange}
          onFocus={loadUsers}
          onOpenMenu={loadUsers}
          allowCustomValue={true}
          onCreateOption={handleCreateUserOption}
          isLoading={loadingUsers}
          placeholder="Search or enter a login"
        />
      </Field>
      {usersError && <Alert severity="error" title={usersError} />}
    </>
  );
}
