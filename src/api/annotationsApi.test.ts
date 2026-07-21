const mockBackendGet = jest.fn();
const mockBackendPost = jest.fn();
const mockBackendDelete = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    get: mockBackendGet,
    post: mockBackendPost,
    delete: mockBackendDelete,
  }),
}));

import {
  createAnnotation,
  deleteAnnotation,
  isForbiddenError,
  listAnnotationsByTags,
  refetchAnnotationById,
} from './annotationsApi';

describe('annotationsApi', () => {
  beforeEach(() => {
    mockBackendGet.mockReset();
    mockBackendPost.mockReset();
    mockBackendDelete.mockReset();
  });

  it('creates an org-level region annotation', async () => {
    mockBackendPost.mockResolvedValue({ id: 7, message: 'Annotation added' });
    const result = await createAnnotation({ time: 1000, timeEnd: 2000, tags: ['slurm-app:annotation'], text: 'note' });
    expect(mockBackendPost).toHaveBeenCalledWith('/api/annotations', {
      time: 1000,
      timeEnd: 2000,
      tags: ['slurm-app:annotation'],
      text: 'note',
    });
    expect(result.id).toBe(7);
  });

  it('lists by tags using repeated tags params (AND) and matchAny=false', async () => {
    mockBackendGet.mockResolvedValue([]);
    await listAnnotationsByTags(['slurm-app:annotation', 'slurm-app:schema=1', 'slurm-app:job=1'], 50);
    const url = mockBackendGet.mock.calls[0][0] as string;
    const query = new URLSearchParams(url.split('?')[1]);
    expect(query.getAll('tags')).toEqual(['slurm-app:annotation', 'slurm-app:schema=1', 'slurm-app:job=1']);
    expect(query.get('matchAny')).toBe('false');
    expect(query.get('limit')).toBe('50');
  });

  it('re-fetches an annotation by id', async () => {
    const annotation = { id: 2, time: 0, tags: [], text: 'b' };
    mockBackendGet.mockResolvedValue(annotation);

    await expect(refetchAnnotationById(2)).resolves.toEqual(annotation);
    expect(mockBackendGet).toHaveBeenCalledWith('/api/annotations/2');
  });

  it('returns null when re-fetching an annotation returns 404', async () => {
    mockBackendGet.mockRejectedValue({ status: 404 });

    await expect(refetchAnnotationById(99)).resolves.toBeNull();
  });

  it('rethrows non-404 errors when re-fetching an annotation', async () => {
    const error = { status: 500 };
    mockBackendGet.mockRejectedValue(error);

    await expect(refetchAnnotationById(2)).rejects.toBe(error);
  });

  it('deletes an annotation by id', async () => {
    mockBackendDelete.mockResolvedValue({});
    await deleteAnnotation(9);
    expect(mockBackendDelete).toHaveBeenCalledWith('/api/annotations/9');
  });

  it('detects HTTP 403 errors', () => {
    expect(isForbiddenError({ status: 403 })).toBe(true);
    expect(isForbiddenError({ status: 500 })).toBe(false);
    expect(isForbiddenError(new Error('nope'))).toBe(false);
    expect(isForbiddenError(null)).toBe(false);
  });
});
