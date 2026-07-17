import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { isRangeFarOutsideJob, LabelWindowModal } from './LabelWindowModal';
import { createAnnotation } from '../../../api/annotationsApi';

jest.mock('../../../api/annotationsApi', () => ({
  createAnnotation: jest.fn(),
  isForbiddenError: (error: unknown) => typeof error === 'object' && error !== null && (error as { status?: number }).status === 403,
}));

jest.mock('@grafana/ui', () => {
  const React = require('react');
  const Modal = ({ title, isOpen, children }: { title: string; isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? (
      <div>
        <h1>{title}</h1>
        {children}
      </div>
    ) : null;
  Modal.ButtonRow = function ButtonRow({ children }: { children: React.ReactNode }) {
    return <div>{children}</div>;
  };
  return {
    Modal,
    Alert: ({ title, children }: { title: string; children?: React.ReactNode }) => (
      <div role="alert">
        {title}
        {children}
      </div>
    ),
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
    Field: ({ label, children }: { label?: string; children?: React.ReactNode }) => (
      <div>
        {label && <label>{label}</label>}
        {children}
      </div>
    ),
    Select: ({ options, onChange, inputId }: any) => (
      <select
        aria-label="Event type"
        id={inputId}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          const found = (options || []).find((o: any) => String(o.value) === e.target.value);
          onChange(found ?? null);
        }}
      >
        <option value="">--</option>
        {(options || []).map((opt: any) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    ),
    RadioButtonGroup: ({ options, value, onChange }: any) => (
      <div role="radiogroup">
        {options.map((opt: any) => (
          <label key={opt.value}>
            <input type="radio" checked={opt.value === value} onChange={() => onChange(opt.value)} />
            {opt.label}
          </label>
        ))}
      </div>
    ),
    TextArea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
    TimeRangeInput: () => <div data-testid="time-range-input" />,
  };
});

const createAnnotationMock = createAnnotation as jest.Mock;

const baseProps = {
  isOpen: true,
  jobId: '12345',
  tsfmClusterId: 'isk',
  eventTypes: ['thermal_throttle', 'nccl_stall'],
  defaultQuality: 'candidate' as const,
  initialRange: { fromMs: 1_000_000, toMs: 2_000_000 },
  jobWindow: { startMs: 1_000_000, endMs: 2_000_000 },
  onCreated: jest.fn(),
  onDismiss: jest.fn(),
};

describe('LabelWindowModal', () => {
  beforeEach(() => {
    createAnnotationMock.mockReset();
    baseProps.onCreated.mockReset();
    baseProps.onDismiss.mockReset();
  });

  it('disables save until an event type is chosen', async () => {
    render(<LabelWindowModal {...baseProps} />);
    expect(screen.getByRole('button', { name: 'Save label' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'thermal_throttle' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save label' })).not.toBeDisabled());
  });

  it('previews the exact tag array that will be sent', () => {
    render(<LabelWindowModal {...baseProps} />);
    const preview = screen.getByLabelText('Tags preview');
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'nccl_stall' } });
    expect(preview).toHaveTextContent('tsfm:label');
    expect(preview).toHaveTextContent('tsfm:event=nccl_stall');
    expect(preview).toHaveTextContent('tsfm:job=12345');
    expect(preview).toHaveTextContent('tsfm:cluster=isk');
    expect(preview).toHaveTextContent('tsfm:quality=candidate');
  });

  it('posts the annotation payload and closes on success', async () => {
    createAnnotationMock.mockResolvedValue({ id: 1 });
    render(<LabelWindowModal {...baseProps} />);
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'thermal_throttle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));

    await waitFor(() =>
      expect(createAnnotationMock).toHaveBeenCalledWith({
        time: 1_000_000,
        timeEnd: 2_000_000,
        tags: ['tsfm:label', 'tsfm:event=thermal_throttle', 'tsfm:job=12345', 'tsfm:cluster=isk', 'tsfm:quality=candidate'],
        text: '',
      })
    );
    expect(baseProps.onCreated).toHaveBeenCalled();
    expect(baseProps.onDismiss).toHaveBeenCalled();
  });

  it('shows a permission-specific message on 403', async () => {
    createAnnotationMock.mockRejectedValue({ status: 403 });
    render(<LabelWindowModal {...baseProps} />);
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'thermal_throttle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('permission to create annotations'));
    expect(baseProps.onDismiss).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<LabelWindowModal {...baseProps} isOpen={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('isRangeFarOutsideJob', () => {
  const job = { startMs: 1_000_000, endMs: 2_000_000 };

  it('accepts a window inside the job period', () => {
    expect(isRangeFarOutsideJob({ fromMs: 1_100_000, toMs: 1_900_000 }, job)).toBe(false);
  });

  it('flags a window far before the job start', () => {
    expect(isRangeFarOutsideJob({ fromMs: 100_000, toMs: 1_500_000 }, job)).toBe(true);
  });

  it('flags a window far after the job end', () => {
    expect(isRangeFarOutsideJob({ fromMs: 1_500_000, toMs: 9_000_000 }, job)).toBe(true);
  });

  it('ignores the upper bound for running jobs', () => {
    expect(isRangeFarOutsideJob({ fromMs: 1_500_000, toMs: 9_000_000 }, { startMs: 1_000_000, endMs: null })).toBe(false);
  });
});
