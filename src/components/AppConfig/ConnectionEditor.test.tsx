import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionEditor } from './ConnectionEditor';
import { ConnectionFormState } from './types';

const mockGet = jest.fn();
const mockGetList = jest.fn();
const mockGetInstanceSettings = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    get: mockGet,
  }),
  getDataSourceSrv: () => ({
    getList: mockGetList,
    getInstanceSettings: mockGetInstanceSettings,
  }),
}));

jest.mock('@grafana/ui', () => {
  const React = require('react');

  type Option = { label?: string; value?: string; description?: string };

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

  function Button({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) {
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

  function SecretInput({
    isConfigured,
    value,
    onChange,
    onReset,
  }: {
    isConfigured?: boolean;
    value?: string;
    onChange?: (event: { currentTarget: { value: string } }) => void;
    onReset?: () => void;
  }) {
    if (isConfigured) {
      return (
        <div>
          <span>configured</span>
          <button type="button" onClick={onReset}>
            Reset
          </button>
        </div>
      );
    }
    return (
      <input
        aria-label="Password"
        value={value}
        onChange={(e) => onChange?.({ currentTarget: { value: e.currentTarget.value } })}
      />
    );
  }

  function Select({
    options = [],
    onChange,
    placeholder,
  }: {
    options?: Option[];
    value?: Option | null;
    onChange: (option: Option) => void;
    placeholder?: string;
  }) {
    return (
      <div>
        {placeholder ? <span>{placeholder}</span> : null}
        {options.map((option) => (
          <button key={option.value} type="button" onClick={() => onChange(option)}>
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  return { CollapsableSection, Button, Field, Input, SecretInput, Select };
});

function makeConnection(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    id: 'default',
    dbHost: 'mysql:3306',
    dbName: 'slurm_acct_db',
    dbUser: 'slurm',
    securePasswordRef: 'password-default',
    password: '',
    isPasswordConfigured: false,
    ...overrides,
  };
}

// The outer CollapsableSection is collapsed by default whenever the
// connection already has a dbHost, so open it before asserting on the
// fields nested inside.
function openSection(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('ConnectionEditor', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGetList.mockReset();
    mockGetInstanceSettings.mockReset();
    mockGetList.mockReturnValue([]);
  });

  it('renders initial connection values', () => {
    render(<ConnectionEditor connection={makeConnection()} onChange={jest.fn()} onDelete={jest.fn()} />);
    openSection('default — mysql:3306');

    expect(screen.getByDisplayValue('default')).toBeInTheDocument();
    expect(screen.getByDisplayValue('mysql:3306')).toBeInTheDocument();
    expect(screen.getByDisplayValue('slurm_acct_db')).toBeInTheDocument();
    expect(screen.getByDisplayValue('slurm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'default — mysql:3306' })).toBeInTheDocument();
  });

  it('propagates DB Host, DB Name, and DB User edits via onChange', () => {
    const onChange = jest.fn();
    const connection = makeConnection();
    render(<ConnectionEditor connection={connection} onChange={onChange} onDelete={jest.fn()} />);
    openSection('default — mysql:3306');

    fireEvent.change(screen.getByPlaceholderText('mysql:3306'), { target: { value: 'mysql2:3306' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...connection, dbHost: 'mysql2:3306' });

    fireEvent.change(screen.getByPlaceholderText('slurm_acct_db'), { target: { value: 'other_db' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...connection, dbName: 'other_db' });

    fireEvent.change(screen.getByPlaceholderText('slurm'), { target: { value: 'other_user' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...connection, dbUser: 'other_user' });
  });

  it('propagates password edits and reset via onChange', () => {
    const onChange = jest.fn();
    const connection = makeConnection({ isPasswordConfigured: true });
    render(<ConnectionEditor connection={connection} onChange={onChange} onDelete={jest.fn()} />);
    openSection('default — mysql:3306');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...connection, password: '', isPasswordConfigured: false });
  });

  it('allows entering a new password when not yet configured', () => {
    const onChange = jest.fn();
    const connection = makeConnection({ isPasswordConfigured: false });
    render(<ConnectionEditor connection={connection} onChange={onChange} onDelete={jest.fn()} />);
    openSection('default — mysql:3306');

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...connection, password: 'secret' });
  });

  it('calls onDelete when the delete button is clicked', () => {
    const onDelete = jest.fn();
    render(<ConnectionEditor connection={makeConnection()} onChange={jest.fn()} onDelete={onDelete} />);
    openSection('default — mysql:3306');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not render the "Import from Datasource" field when no MySQL datasources exist', () => {
    mockGetList.mockReturnValue([]);
    render(<ConnectionEditor connection={makeConnection()} onChange={jest.fn()} onDelete={jest.fn()} />);

    expect(screen.queryByText('Import from Datasource')).not.toBeInTheDocument();
  });

  it('auto-fills dbHost, dbName, and dbUser from the admin API when importing from a datasource', async () => {
    mockGetList.mockReturnValue([{ name: 'MySQL Main', uid: 'ds-1', url: 'proxy/ds-1' }]);
    mockGet.mockResolvedValue({
      url: 'mysql-real-host:3306',
      database: 'real_db',
      user: 'real_user',
    });
    const onChange = jest.fn();
    const connection = makeConnection();
    render(<ConnectionEditor connection={connection} onChange={onChange} onDelete={jest.fn()} />);
    openSection('default — mysql:3306');

    fireEvent.click(screen.getByRole('button', { name: 'MySQL Main' }));

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/datasources/uid/ds-1'));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        ...connection,
        dbHost: 'mysql-real-host:3306',
        dbName: 'real_db',
        dbUser: 'real_user',
        password: '',
        isPasswordConfigured: false,
      })
    );
  });

  it('falls back to (ds as any) instance settings fields when the admin API call fails', async () => {
    mockGetList.mockReturnValue([{ name: 'MySQL Main', uid: 'ds-1', url: 'proxy/ds-1' }]);
    mockGet.mockRejectedValue(new Error('forbidden'));
    mockGetInstanceSettings.mockReturnValue({
      url: 'proxy/ds-1',
      // These are not part of the typed DataSourceInstanceSettings shape; the
      // component reads them via an `any` cast as a best-effort fallback.
      database: 'fallback_db',
      username: 'fallback_user',
      jsonData: {},
    });
    const onChange = jest.fn();
    const connection = makeConnection();
    render(<ConnectionEditor connection={connection} onChange={onChange} onDelete={jest.fn()} />);
    openSection('default — mysql:3306');

    fireEvent.click(screen.getByRole('button', { name: 'MySQL Main' }));

    await waitFor(() => expect(mockGetInstanceSettings).toHaveBeenCalledWith('ds-1'));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        ...connection,
        dbHost: 'proxy/ds-1',
        dbName: 'fallback_db',
        dbUser: 'fallback_user',
        password: '',
        isPasswordConfigured: false,
      })
    );
  });

  it('falls back to jsonData database/user fields and existing values when instance settings lack them', async () => {
    mockGetList.mockReturnValue([{ name: 'MySQL Main', uid: 'ds-1', url: 'proxy/ds-1' }]);
    mockGet.mockRejectedValue(new Error('forbidden'));
    mockGetInstanceSettings.mockReturnValue({
      url: '',
      jsonData: { database: 'json_db', user: 'json_user' },
    });
    const onChange = jest.fn();
    const connection = makeConnection();
    render(<ConnectionEditor connection={connection} onChange={onChange} onDelete={jest.fn()} />);
    openSection('default — mysql:3306');

    fireEvent.click(screen.getByRole('button', { name: 'MySQL Main' }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        ...connection,
        dbHost: '',
        dbName: 'json_db',
        dbUser: 'json_user',
        password: '',
        isPasswordConfigured: false,
      })
    );
  });

  it('does nothing when the datasource instance cannot be found in the fallback path', async () => {
    mockGetList.mockReturnValue([{ name: 'MySQL Main', uid: 'ds-1', url: 'proxy/ds-1' }]);
    mockGet.mockRejectedValue(new Error('forbidden'));
    mockGetInstanceSettings.mockReturnValue(undefined);
    const onChange = jest.fn();
    render(<ConnectionEditor connection={makeConnection()} onChange={onChange} onDelete={jest.fn()} />);
    openSection('default — mysql:3306');

    fireEvent.click(screen.getByRole('button', { name: 'MySQL Main' }));

    await waitFor(() => expect(mockGetInstanceSettings).toHaveBeenCalledWith('ds-1'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
