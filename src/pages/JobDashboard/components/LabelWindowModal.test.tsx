import React, { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAnnotation } from '../../../api/annotationsApi';
import { isRangeFarOutsideJob, LabelWindowModal } from './LabelWindowModal';

jest.mock('../../../api/annotationsApi', () => ({
  createAnnotation: jest.fn(),
  isForbiddenError: (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { status?: number }).status === 403,
}));

jest.mock('@grafana/ui', () => {
  const React = require('react');
  function Modal({ isOpen, title, children }: any) {
    return isOpen ? <div role="dialog" aria-label={title}>{children}</div> : null;
  }
  function ButtonRow({ children }: any) {
    return <div>{children}</div>;
  }
  Modal.ButtonRow = ButtonRow;
  return {
    Alert: ({ title }: any) => <div role="alert">{title}</div>,
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Field: ({ label, children }: any) => <label>{label}{children}</label>,
    Modal,
    Select: ({ inputId, onChange, onCreateOption, options, placeholder }: any) => (
      <input
        id={inputId}
        aria-label="Category"
        data-options={JSON.stringify(options)}
        placeholder={placeholder}
        onChange={(event) => onChange({ value: event.target.value, label: event.target.value })}
        onBlur={(event) => onCreateOption?.(event.target.value)}
      />
    ),
    TextArea: (props: any) => <textarea aria-label="Note" {...props} />,
    TimeRangeInput: ({ value, onChange }: any) => (
      <button type="button" aria-label="Time range" onClick={() => onChange(value)}>range</button>
    ),
  };
});

const createMock = createAnnotation as jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const baseProps = {
  isOpen: true,
  jobId: '12345',
  clusterId: 'gpu-a',
  categories: ['maintenance', 'incident'],
  initialRange: { fromMs: 1000, toMs: 2000 },
  jobWindow: { startMs: 1000, endMs: 2000 },
  onCreated: jest.fn(),
  onDismiss: jest.fn(),
};

describe('LabelWindowModal', () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue({ id: 1 });
    baseProps.onCreated.mockReset();
    baseProps.onDismiss.mockReset();
  });

  it('requires a category and creates generic versioned tags with trimmed note fallback', async () => {
    render(<LabelWindowModal {...baseProps} />);
    expect(screen.getByRole('button', { name: 'Save label' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'custom-category' } });
    fireEvent.blur(screen.getByLabelText('Category'));
    expect(screen.queryByText(['Qual', 'ity'].join(''))).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tags preview')).toHaveTextContent('slurm-app:schema=1');
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith({
      time: 1000,
      timeEnd: 2000,
      tags: [
        'slurm-app:annotation',
        'slurm-app:schema=1',
        'slurm-app:job=12345',
        'slurm-app:cluster=gpu-a',
        'slurm-app:category=custom-category',
      ],
      text: 'custom-category',
    }));
    expect(baseProps.onCreated).toHaveBeenCalledTimes(1);
    expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('stores a trimmed nonempty note instead of the category fallback', async () => {
    render(<LabelWindowModal {...baseProps} />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'maintenance' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '  scheduled work  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      text: 'scheduled work',
    })));
  });

  it.each([
    [{ status: 403 }, 'permission to create annotations'],
    [new Error('create failed'), 'create failed'],
  ])('shows create errors and re-enables submission', async (error, message) => {
    createMock.mockRejectedValue(error);
    render(<LabelWindowModal {...baseProps} />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'maintenance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Save label' })).not.toBeDisabled();
  });

  it('allows a custom category when no suggestions are configured', async () => {
    render(<LabelWindowModal {...baseProps} categories={[]} />);

    const categoryInput = screen.getByLabelText('Category');
    expect(categoryInput).toHaveAttribute('data-options', '[]');

    fireEvent.change(categoryInput, { target: { value: 'maintenance' } });
    fireEvent.blur(categoryInput);
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      tags: expect.arrayContaining(['slurm-app:category=maintenance']),
      text: 'maintenance',
    })));
  });

  it('ignores a stale create after an A-B-A context round trip', async () => {
    const oldCreate = deferred<{ id: number }>();
    createMock.mockReturnValueOnce(oldCreate.promise).mockResolvedValueOnce({ id: 2 });
    const { rerender } = render(<LabelWindowModal {...baseProps} jobId="10001" />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'maintenance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
    rerender(<LabelWindowModal {...baseProps} jobId="20002" />);
    rerender(<LabelWindowModal {...baseProps} jobId="10001" />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'incident' } });
    await act(async () => oldCreate.resolve({ id: 1 }));
    expect(baseProps.onCreated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
    await waitFor(() => expect(baseProps.onCreated).toHaveBeenCalledTimes(1));
  });

  it('does not update callbacks after StrictMode unmount', async () => {
    const pending = deferred<{ id: number }>();
    createMock.mockReturnValue(pending.promise);
    const { unmount } = render(<StrictMode><LabelWindowModal {...baseProps} /></StrictMode>);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'maintenance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
    unmount();
    await act(async () => pending.resolve({ id: 1 }));
    expect(baseProps.onCreated).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<LabelWindowModal {...baseProps} isOpen={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the advisory warning for a range far outside a finished job', () => {
    render(
      <LabelWindowModal
        {...baseProps}
        initialRange={{ fromMs: 1000, toMs: 100_000 }}
        jobWindow={{ startMs: 1000, endMs: 2000 }}
      />
    );
    expect(screen.getByText(/well outside/)).toBeInTheDocument();
  });
});

describe('isRangeFarOutsideJob', () => {
  const job = { startMs: 1_000_000, endMs: 2_000_000 };
  it('accepts a window inside the job period', () => {
    expect(isRangeFarOutsideJob({ fromMs: 1_100_000, toMs: 1_900_000 }, job)).toBe(false);
  });
  it('flags a distant window and ignores the upper bound for running jobs', () => {
    expect(isRangeFarOutsideJob({ fromMs: 100_000, toMs: 1_500_000 }, job)).toBe(true);
    expect(isRangeFarOutsideJob({ fromMs: 1_500_000, toMs: 9_000_000 }, { ...job, endMs: null })).toBe(false);
  });
  it('uses the exact one-minute boundary for zero-duration and running jobs', () => {
    expect(isRangeFarOutsideJob({ fromMs: 940_000, toMs: 1_000_000 }, { startMs: 1_000_000, endMs: 1_000_000 })).toBe(false);
    expect(isRangeFarOutsideJob({ fromMs: 939_999, toMs: 1_000_000 }, { startMs: 1_000_000, endMs: null })).toBe(true);
  });
});
