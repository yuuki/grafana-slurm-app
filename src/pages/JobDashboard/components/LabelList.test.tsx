import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LabelList } from './LabelList';
import {
  deleteAnnotation,
  listAnnotationsByTags,
  patchAnnotationTags,
  refetchAnnotationById,
} from '../../../api/annotationsApi';

jest.mock('../../../api/annotationsApi', () => ({
  listAnnotationsByTags: jest.fn(),
  refetchAnnotationById: jest.fn(),
  patchAnnotationTags: jest.fn(),
  deleteAnnotation: jest.fn(),
  isForbiddenError: (error: unknown) => typeof error === 'object' && error !== null && (error as { status?: number }).status === 403,
}));

jest.mock('@grafana/ui', () => {
  const React = require('react');
  return {
    Alert: ({ title, onRemove }: { title: string; onRemove?: () => void }) => (
      <div role="alert">
        {title}
        {onRemove && <button onClick={onRemove}>dismiss</button>}
      </div>
    ),
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
    IconButton: ({ tooltip, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { name?: string; tooltip?: string }) => (
      <button aria-label={props['aria-label'] ?? tooltip} {...props} />
    ),
    LoadingPlaceholder: ({ text }: { text: string }) => <div>{text}</div>,
    ConfirmModal: ({ isOpen, title, confirmText, onConfirm }: any) =>
      isOpen ? (
        <div role="dialog">
          <span>{title}</span>
          <button onClick={onConfirm}>{confirmText}</button>
        </div>
      ) : null,
  };
});

const listMock = listAnnotationsByTags as jest.Mock;
const refetchMock = refetchAnnotationById as jest.Mock;
const patchMock = patchAnnotationTags as jest.Mock;
const deleteMock = deleteAnnotation as jest.Mock;

const annotation = {
  id: 501,
  time: 1000,
  timeEnd: 2000,
  tags: ['tsfm:label', 'tsfm:event=thermal_throttle', 'tsfm:job=12345', 'tsfm:cluster=isk', 'tsfm:quality=candidate', 'incident-7'],
  text: 'note',
  login: 'alice',
};

const baseProps = {
  jobId: '12345',
  tsfmClusterId: 'isk',
  refreshToken: 0,
  onJumpToRange: jest.fn(),
  onChanged: jest.fn(),
};

describe('LabelList', () => {
  beforeEach(() => {
    listMock.mockReset();
    refetchMock.mockReset();
    patchMock.mockReset();
    deleteMock.mockReset();
    baseProps.onJumpToRange.mockReset();
    baseProps.onChanged.mockReset();
  });

  it('queries with the three-tag AND and renders a row', async () => {
    listMock.mockResolvedValue([annotation]);
    render(<LabelList {...baseProps} />);

    await screen.findByText('thermal_throttle');
    expect(listMock).toHaveBeenCalledWith(['tsfm:label', 'tsfm:job=12345', 'tsfm:cluster=isk'], 100);
    expect(screen.getByText('candidate')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('shows an empty state when there are no labels', async () => {
    listMock.mockResolvedValue([]);
    render(<LabelList {...baseProps} />);
    await screen.findByText(/No labels yet/);
  });

  it('jumps the scene time range when a window is clicked', async () => {
    listMock.mockResolvedValue([annotation]);
    render(<LabelList {...baseProps} />);
    fireEvent.click(await screen.findByLabelText('Jump to window for label 501'));
    expect(baseProps.onJumpToRange).toHaveBeenCalledWith(1000, 2000);
  });

  it('confirms by re-fetching then replacing only the quality tag (preserving unknown tags)', async () => {
    listMock.mockResolvedValue([annotation]);
    refetchMock.mockResolvedValue(annotation);
    patchMock.mockResolvedValue(undefined);
    render(<LabelList {...baseProps} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(refetchMock).toHaveBeenCalledWith(['tsfm:label', 'tsfm:job=12345', 'tsfm:cluster=isk'], 501, 100));
    expect(patchMock).toHaveBeenCalledWith(501, [
      'tsfm:label',
      'tsfm:event=thermal_throttle',
      'tsfm:job=12345',
      'tsfm:cluster=isk',
      'incident-7',
      'tsfm:quality=confirmed',
    ]);
    expect(baseProps.onChanged).toHaveBeenCalled();
  });

  it('aborts confirm when the re-fetched annotation drifted from the listed values', async () => {
    listMock.mockResolvedValue([annotation]);
    refetchMock.mockResolvedValue({
      ...annotation,
      tags: ['tsfm:label', 'tsfm:event=nccl_stall', 'tsfm:job=12345', 'tsfm:cluster=isk', 'tsfm:quality=candidate'],
    });
    render(<LabelList {...baseProps} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('changed since it was listed'));
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('aborts confirm when the annotation was deleted concurrently', async () => {
    listMock.mockResolvedValue([annotation]);
    refetchMock.mockResolvedValue(null);
    render(<LabelList {...baseProps} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no longer exists'));
    expect(patchMock).not.toHaveBeenCalled();
    expect(baseProps.onChanged).toHaveBeenCalled();
  });

  it('deletes after confirmation dialog', async () => {
    listMock.mockResolvedValue([annotation]);
    deleteMock.mockResolvedValue(undefined);
    render(<LabelList {...baseProps} />);

    fireEvent.click(await screen.findByLabelText('Delete label 501'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(501));
    expect(baseProps.onChanged).toHaveBeenCalled();
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    render(<LabelList {...baseProps} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'));
  });
});
