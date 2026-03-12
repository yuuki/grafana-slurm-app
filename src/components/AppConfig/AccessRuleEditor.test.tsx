import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listGrafanaOrgUsers } from '../../api/slurmApi';
import { AccessRuleEditor } from './AccessRuleEditor';

jest.mock('../../api/slurmApi', () => ({
  listGrafanaOrgUsers: jest.fn(),
}));

jest.mock('@grafana/ui', () => {
  const React = require('react');

  type Option = { label?: string; value?: string };

  function Field({ label, children, description }: { label: string; children: React.ReactNode; description?: string }) {
    return (
      <div>
        <span>{label}</span>
        {description ? <span>{description}</span> : null}
        {children}
      </div>
    );
  }

  function Alert({ title }: { title: string }) {
    return <div role="alert">{title}</div>;
  }

  function Input({
    value,
    onChange,
    placeholder,
  }: {
    value?: string;
    onChange?: (event: { currentTarget: { value: string } }) => void;
    placeholder?: string;
  }) {
    return (
      <input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.({ currentTarget: { value: e.currentTarget.value } })}
      />
    );
  }

  function MultiSelect({
    options = [],
    value = [],
    onChange,
    onOpenMenu,
    onFocus,
    onCreateOption,
    isLoading,
    ['aria-label']: ariaLabel,
  }: {
    options?: Option[];
    value?: Option[];
    onChange: (value: Option[]) => void;
    onOpenMenu?: () => void;
    onFocus?: () => void;
    onCreateOption?: (value: string) => void;
    isLoading?: boolean;
    ['aria-label']?: string;
  }) {
    const [customValue, setCustomValue] = React.useState('');
    const selectedValues = new Set((value ?? []).map((item) => item.value));

    return (
      <div>
        <button type="button" onClick={() => { onFocus?.(); onOpenMenu?.(); }}>
          {`open-${ariaLabel}`}
        </button>
        {isLoading ? <div>{`loading-${ariaLabel}`}</div> : null}
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
        {onCreateOption ? (
          <>
            <input
              aria-label={`custom-${ariaLabel}`}
              value={customValue}
              onChange={(e) => setCustomValue(e.currentTarget.value)}
            />
            <button type="button" onClick={() => onCreateOption(customValue)}>
              {`create-${ariaLabel}`}
            </button>
          </>
        ) : null}
      </div>
    );
  }

  return { Field, Alert, Input, MultiSelect };
});

const mockedListGrafanaOrgUsers = listGrafanaOrgUsers as jest.MockedFunction<typeof listGrafanaOrgUsers>;

describe('AccessRuleEditor', () => {
  beforeEach(() => {
    mockedListGrafanaOrgUsers.mockReset();
  });

  it('selects allowed roles from fixed role options', () => {
    const onChange = jest.fn();

    render(<AccessRuleEditor accessRule={{ allowedRoles: ['Editor'], allowedUsers: [] }} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Allowed Roles-Viewer' }));

    expect(onChange).toHaveBeenCalledWith({
      allowedRoles: ['Editor', 'Viewer'],
      allowedUsers: [],
    });
  });

  it('loads Grafana org user candidates and selects a suggested login', async () => {
    const onChange = jest.fn();
    mockedListGrafanaOrgUsers.mockResolvedValue([
      { login: 'alice', displayLabel: 'alice' },
      { login: 'bob', displayLabel: 'bob' },
    ]);

    render(<AccessRuleEditor accessRule={{ allowedRoles: [], allowedUsers: ['alice'] }} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'open-Allowed Users' }));

    await waitFor(() => {
      expect(mockedListGrafanaOrgUsers).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Allowed Users-bob' }));

    expect(onChange).toHaveBeenCalledWith({
      allowedRoles: [],
      allowedUsers: ['alice', 'bob'],
    });
  });

  it('does not fetch Grafana org users twice when focus and menu open fire together', async () => {
    mockedListGrafanaOrgUsers.mockResolvedValue([{ login: 'alice', displayLabel: 'alice' }]);

    render(<AccessRuleEditor accessRule={{ allowedRoles: [], allowedUsers: [] }} onChange={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'open-Allowed Users' }));

    await waitFor(() => {
      expect(mockedListGrafanaOrgUsers).toHaveBeenCalledTimes(1);
    });
  });

  it('shows an error and still allows adding a custom login when loading user candidates fails', async () => {
    const onChange = jest.fn();
    mockedListGrafanaOrgUsers.mockRejectedValue(new Error('failed to load users'));

    render(<AccessRuleEditor accessRule={{ allowedRoles: [], allowedUsers: [] }} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'open-Allowed Users' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('failed to load users');

    fireEvent.change(screen.getByLabelText('custom-Allowed Users'), { target: { value: 'carol' } });
    fireEvent.click(screen.getByRole('button', { name: 'create-Allowed Users' }));

    expect(onChange).toHaveBeenCalledWith({
      allowedRoles: [],
      allowedUsers: ['carol'],
    });
  });
});
