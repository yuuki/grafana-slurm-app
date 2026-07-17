const mockBackendGet = jest.fn();
const mockBackendPost = jest.fn();
const mockBackendPatch = jest.fn();
const mockBackendDelete = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    get: mockBackendGet,
    post: mockBackendPost,
    patch: mockBackendPatch,
    delete: mockBackendDelete,
  }),
}));

import {
  createAnnotation,
  deleteAnnotation,
  isForbiddenError,
  listAnnotationsByTags,
  patchAnnotationTags,
  refetchAnnotationById,
} from './annotationsApi';

describe('annotationsApi', () => {
  beforeEach(() => {
    mockBackendGet.mockReset();
    mockBackendPost.mockReset();
    mockBackendPatch.mockReset();
    mockBackendDelete.mockReset();
  });

  it('creates an org-level region annotation', async () => {
    mockBackendPost.mockResolvedValue({ id: 7, message: 'Annotation added' });
    const result = await createAnnotation({ time: 1000, timeEnd: 2000, tags: ['tsfm:label'], text: 'note' });
    expect(mockBackendPost).toHaveBeenCalledWith('/api/annotations', {
      time: 1000,
      timeEnd: 2000,
      tags: ['tsfm:label'],
      text: 'note',
    });
    expect(result.id).toBe(7);
  });

  it('lists by tags using repeated tags params (AND) and matchAny=false', async () => {
    mockBackendGet.mockResolvedValue([]);
    await listAnnotationsByTags(['tsfm:label', 'tsfm:job=1', 'tsfm:cluster=isk'], 50);
    const url = mockBackendGet.mock.calls[0][0] as string;
    const query = new URLSearchParams(url.split('?')[1]);
    expect(query.getAll('tags')).toEqual(['tsfm:label', 'tsfm:job=1', 'tsfm:cluster=isk']);
    expect(query.get('matchAny')).toBe('false');
    expect(query.get('limit')).toBe('50');
  });

  it('re-fetches an annotation by id from the tag query', async () => {
    mockBackendGet.mockResolvedValue([
      { id: 1, time: 0, tags: [], text: 'a' },
      { id: 2, time: 0, tags: [], text: 'b' },
    ]);
    const found = await refetchAnnotationById(['tsfm:label'], 2);
    expect(found?.text).toBe('b');
  });

  it('returns null when the annotation is gone from the tag query', async () => {
    mockBackendGet.mockResolvedValue([{ id: 1, time: 0, tags: [], text: 'a' }]);
    expect(await refetchAnnotationById(['tsfm:label'], 99)).toBeNull();
  });

  it('patches only the tags array', async () => {
    mockBackendPatch.mockResolvedValue({});
    await patchAnnotationTags(5, ['tsfm:label', 'tsfm:quality=confirmed']);
    expect(mockBackendPatch).toHaveBeenCalledWith('/api/annotations/5', {
      tags: ['tsfm:label', 'tsfm:quality=confirmed'],
    });
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
