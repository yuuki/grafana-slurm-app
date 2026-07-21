import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { deleteAnnotation, listAnnotationsByTags, refetchAnnotationById } from '../../../api/annotationsApi';
import { LabelList } from './LabelList';

jest.mock('../../../api/annotationsApi', () => ({
  listAnnotationsByTags: jest.fn(),
  refetchAnnotationById: jest.fn(),
  deleteAnnotation: jest.fn(),
  isForbiddenError: (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { status?: number }).status === 403,
}));

jest.mock('@grafana/ui', () => ({
  Alert: ({ title }: any) => <div role="alert">{title}</div>,
  IconButton: ({ tooltip, ...props }: any) => <button {...props} />,
  LoadingPlaceholder: ({ text }: any) => <div>{text}</div>,
  ConfirmModal: ({ isOpen, title, confirmText, onConfirm }: any) =>
    isOpen ? <div role="dialog"><span>{title}</span><button onClick={onConfirm}>{confirmText}</button></div> : null,
}));

const listMock = listAnnotationsByTags as jest.Mock;
const refetchMock = refetchAnnotationById as jest.Mock;
const deleteMock = deleteAnnotation as jest.Mock;
const annotation = {
  id: 501,
  time: 1000,
  timeEnd: 2000,
  tags: [
    'slurm-app:annotation',
    'slurm-app:schema=1',
    'slurm-app:job=12345',
    'slurm-app:cluster=gpu-a',
    'slurm-app:category=maintenance',
  ],
  text: 'note',
  login: 'alice',
};
const baseProps = {
  jobId: '12345',
  clusterId: 'gpu-a',
  refreshToken: 0,
  onJumpToRange: jest.fn(),
  onChanged: jest.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('LabelList', () => {
  beforeEach(() => {
    listMock.mockReset();
    refetchMock.mockReset();
    deleteMock.mockReset();
    baseProps.onJumpToRange.mockReset();
    baseProps.onChanged.mockReset();
  });

  it('queries the category-independent generic scope and renders the label table contract', async () => {
    listMock.mockResolvedValue([annotation]);
    render(<LabelList {...baseProps} />);
    await screen.findByText('maintenance');
    expect(listMock).toHaveBeenCalledWith([
      'slurm-app:annotation',
      'slurm-app:schema=1',
      'slurm-app:job=12345',
      'slurm-app:cluster=gpu-a',
    ], 100);

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Window',
      'Category',
      'Note',
      'Author',
      'Actions',
    ]);
    const row = within(table).getAllByRole('row')[1];
    const cells = within(row).getAllByRole('cell');
    expect(cells).toHaveLength(5);
    const actionButtons = within(cells[4]).getAllByRole('button');
    expect(actionButtons).toHaveLength(1);
    expect(actionButtons[0]).toHaveAccessibleName('Delete label 501');
  });

  it('renders the empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<LabelList {...baseProps} />);
    expect(await screen.findByText(/No labels yet/)).toBeInTheDocument();
  });

  it('jumps to an annotation window', async () => {
    listMock.mockResolvedValue([annotation]);
    render(<LabelList {...baseProps} />);
    fireEvent.click(await screen.findByLabelText('Jump to window for label 501'));
    expect(baseProps.onJumpToRange).toHaveBeenCalledWith(1000, 2000);
  });

  it('warns when the query reaches its list limit', async () => {
    listMock.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({ ...annotation, id: index + 1 }))
    );
    render(<LabelList {...baseProps} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('first 100 labels');
  });

  it('refetches and validates exact schema/category identity before delete', async () => {
    listMock.mockResolvedValue([annotation]);
    refetchMock.mockResolvedValue(annotation);
    deleteMock.mockResolvedValue(undefined);
    render(<LabelList {...baseProps} />);
    fireEvent.click(await screen.findByLabelText('Delete label 501'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(501));
    expect(refetchMock.mock.invocationCallOrder[0]).toBeLessThan(deleteMock.mock.invocationCallOrder[0]);
  });

  it.each([
    ['schema', 'slurm-app:schema=2'],
    ['category', 'slurm-app:category=incident'],
    ['duplicate category', 'slurm-app:category=maintenance'],
  ])('rejects %s drift or duplication before delete', async (kind, replacement) => {
    const tags = kind === 'duplicate category'
      ? [...annotation.tags, replacement]
      : annotation.tags.map((tag) => tag.startsWith(`slurm-app:${kind}=`) ? replacement : tag);
    listMock.mockResolvedValue([annotation]);
    refetchMock.mockResolvedValue({ ...annotation, tags });
    render(<LabelList {...baseProps} />);
    fireEvent.click(await screen.findByLabelText('Delete label 501'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('alert');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('isolates same-id deletes across an A-B-A context round trip', async () => {
    const oldDelete = deferred<void>();
    const newDelete = deferred<void>();
    listMock.mockResolvedValueOnce([annotation]).mockResolvedValueOnce([]).mockResolvedValueOnce([annotation]);
    refetchMock.mockResolvedValue(annotation);
    deleteMock.mockReturnValueOnce(oldDelete.promise).mockReturnValueOnce(newDelete.promise);
    const { rerender } = render(<LabelList {...baseProps} />);
    fireEvent.click(await screen.findByLabelText('Delete label 501'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    rerender(<LabelList {...baseProps} jobId="99999" />);
    await screen.findByText(/No labels yet/);
    rerender(<LabelList {...baseProps} />);
    await screen.findByText('maintenance');
    fireEvent.click(screen.getByLabelText('Delete label 501'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));
    oldDelete.reject(new Error('stale failure'));
    await waitFor(() => expect(screen.queryByText('stale failure')).not.toBeInTheDocument());
    newDelete.resolve();
    await waitFor(() => expect(baseProps.onChanged).toHaveBeenCalledTimes(1));
  });

  it('reports read and delete permission failures', async () => {
    listMock.mockResolvedValue([annotation]);
    refetchMock.mockRejectedValue({ status: 403 });
    render(<LabelList {...baseProps} />);
    fireEvent.click(await screen.findByLabelText('Delete label 501'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('permission to view');
  });

  it('refreshes when the annotation was deleted concurrently', async () => {
    listMock.mockResolvedValue([annotation]);
    refetchMock.mockResolvedValue(null);
    render(<LabelList {...baseProps} />);
    fireEvent.click(await screen.findByLabelText('Delete label 501'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer exists');
    expect(deleteMock).not.toHaveBeenCalled();
    expect(baseProps.onChanged).toHaveBeenCalled();
  });

  it('keeps the delete permission error from the action request', async () => {
    listMock.mockResolvedValue([annotation]);
    refetchMock.mockResolvedValue(annotation);
    deleteMock.mockRejectedValue({ status: 403 });
    render(<LabelList {...baseProps} />);
    fireEvent.click(await screen.findByLabelText('Delete label 501'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('permission to delete annotations');
  });

  it('shows the general delete fallback and keeps the row available', async () => {
    listMock.mockResolvedValue([annotation]);
    refetchMock.mockResolvedValue(annotation);
    deleteMock.mockRejectedValue({ status: 500 });
    render(<LabelList {...baseProps} />);
    fireEvent.click(await screen.findByLabelText('Delete label 501'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to delete the label');
    expect(screen.getByLabelText('Delete label 501')).not.toBeDisabled();
  });
});
