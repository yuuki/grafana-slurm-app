import {
  ANNOTATION_MARKER_TAG,
  ANNOTATION_SCHEMA_VERSION,
  buildAnnotationScopeTags,
  buildAnnotationTags,
  parseAnnotationTags,
  validateAnnotationIdentity,
  validateAnnotationInput,
} from './annotationTags';
import contractFixture from './__fixtures__/annotation-contract.json';

describe('annotationTags', () => {
  it('builds category-independent query scope tags', () => {
    expect(buildAnnotationScopeTags({ job: ' 12345 ', cluster: ' gpu-a ' })).toEqual([
      'slurm-app:annotation',
      'slurm-app:schema=1',
      'slurm-app:job=12345',
      'slurm-app:cluster=gpu-a',
    ]);
  });

  describe('buildAnnotationTags / parseAnnotationTags round-trip', () => {
    it('builds the ordered, versioned application tag array', () => {
      expect(buildAnnotationTags({ category: 'maintenance', job: '12345', cluster: 'gpu-a' })).toEqual([
        'slurm-app:annotation',
        'slurm-app:schema=1',
        'slurm-app:job=12345',
        'slurm-app:cluster=gpu-a',
        'slurm-app:category=maintenance',
      ]);
    });

    it('parses back the structured view it built', () => {
      const parsed = parseAnnotationTags(
        buildAnnotationTags({ category: 'hardware', job: '42', cluster: 'gpu-b' })
      );

      expect(parsed).toEqual({
        hasMarker: true,
        markerCount: 1,
        schema: '1',
        job: '42',
        cluster: 'gpu-b',
        category: 'hardware',
        duplicateKeys: [],
        unknownTags: [],
      });
    });

    it('trims all input values when building', () => {
      expect(buildAnnotationTags({ category: '  maintenance  ', job: ' 7 ', cluster: ' gpu-a ' })).toEqual([
        'slurm-app:annotation',
        'slurm-app:schema=1',
        'slurm-app:job=7',
        'slurm-app:cluster=gpu-a',
        'slurm-app:category=maintenance',
      ]);
    });
  });

  describe('parseAnnotationTags', () => {
    it('preserves unrelated and unknown tags verbatim', () => {
      const parsed = parseAnnotationTags([
        'slurm-app:annotation',
        'slurm-app:schema=1',
        'slurm-app:job=1',
        'slurm-app:cluster=gpu-a',
        'slurm-app:category=maintenance',
        'slurm-app:future=value',
        'incident-123',
      ]);

      expect(parsed.unknownTags).toEqual(['slurm-app:future=value', 'incident-123']);
    });

    it('returns the first occurrence and reports duplicate controlled keys in schema order', () => {
      const parsed = parseAnnotationTags([
        'slurm-app:category=maintenance',
        'slurm-app:job=1',
        'slurm-app:schema=1',
        'slurm-app:cluster=gpu-a',
        'slurm-app:category=hardware',
        'slurm-app:schema=2',
        'slurm-app:job=2',
      ]);

      expect(parsed.schema).toBe('1');
      expect(parsed.job).toBe('1');
      expect(parsed.category).toBe('maintenance');
      expect(parsed.duplicateKeys).toEqual(['schema', 'job', 'category']);
    });

    it('reports whether and how many times the application marker is present', () => {
      expect(parseAnnotationTags(['slurm-app:schema=1'])).toMatchObject({ hasMarker: false, markerCount: 0 });
      expect(parseAnnotationTags(['slurm-app:annotation', 'slurm-app:annotation'])).toMatchObject({
        hasMarker: true,
        markerCount: 2,
      });
    });
  });

  describe('validateAnnotationInput', () => {
    it('accepts arbitrary non-empty values without an external-consumer-specific length limit', () => {
      expect(
        validateAnnotationInput({
          category: `maintenance-${'x'.repeat(100)}`,
          job: `job-${'1'.repeat(100)}`,
          cluster: `cluster-${'a'.repeat(100)}`,
        })
      ).toEqual([]);
    });

    it.each([
      ['Category', { category: '  ', job: '1', cluster: 'gpu-a' }],
      ['Job ID', { category: 'maintenance', job: '  ', cluster: 'gpu-a' }],
      ['Cluster ID', { category: 'maintenance', job: '1', cluster: '  ' }],
    ])('rejects an empty %s after trimming', (label, input) => {
      expect(validateAnnotationInput(input)).toContain(`${label} must not be empty.`);
    });
  });

  describe('validateAnnotationIdentity', () => {
    const expected = { category: 'maintenance', job: '12345', cluster: 'gpu-a' };
    const tags = buildAnnotationTags(expected);

    it('accepts matching current schema and identity tags', () => {
      expect(validateAnnotationIdentity(tags, expected)).toBeNull();
    });

    it('rejects a missing marker', () => {
      expect(validateAnnotationIdentity(tags.slice(1), expected)).toContain(
        'no longer an application-managed annotation'
      );
    });

    it('rejects a duplicate marker', () => {
      expect(validateAnnotationIdentity([...tags, ANNOTATION_MARKER_TAG], expected)).toContain(
        'duplicate application annotation marker'
      );
    });

    it.each([
      ['missing', tags.filter((tag) => tag !== 'slurm-app:schema=1')],
      ['empty', tags.map((tag) => (tag === 'slurm-app:schema=1' ? 'slurm-app:schema=  ' : tag))],
      ['unsupported', tags.map((tag) => (tag === 'slurm-app:schema=1' ? 'slurm-app:schema=2' : tag))],
    ])('rejects a %s schema version', (_case, latestTags) => {
      expect(validateAnnotationIdentity(latestTags, expected)).toContain('unsupported annotation schema');
    });

    it.each([
      ['schema', 'slurm-app:schema=1'],
      ['job', 'slurm-app:job=12345'],
      ['cluster', 'slurm-app:cluster=gpu-a'],
      ['category', 'slurm-app:category=maintenance'],
    ])('rejects duplicate %s tags', (_key, duplicateTag) => {
      expect(validateAnnotationIdentity([...tags, duplicateTag], expected)).toContain(
        'duplicate application annotation tags'
      );
    });

    it.each([
      ['job', 'slurm-app:job=12345'],
      ['cluster', 'slurm-app:cluster=gpu-a'],
      ['category', 'slurm-app:category=maintenance'],
    ])('rejects a missing %s identity tag', (_key, removedTag) => {
      expect(validateAnnotationIdentity(tags.filter((tag) => tag !== removedTag), expected)).toContain(
        'missing or empty application annotation identity tags'
      );
    });

    it.each([
      ['job', 'slurm-app:job=   '],
      ['cluster', 'slurm-app:cluster=   '],
      ['category', 'slurm-app:category=   '],
    ])('rejects an empty %s identity tag', (_key, emptyTag) => {
      const prefix = emptyTag.slice(0, emptyTag.indexOf('=') + 1);
      expect(
        validateAnnotationIdentity(
          tags.map((tag) => (tag.startsWith(prefix) ? emptyTag : tag)),
          expected
        )
      ).toContain('missing or empty application annotation identity tags');
    });

    it.each([
      ['job', 'slurm-app:job=999'],
      ['cluster', 'slurm-app:cluster=gpu-b'],
      ['category', 'slurm-app:category=hardware'],
    ])('rejects %s drift', (_key, changedTag) => {
      const prefix = changedTag.slice(0, changedTag.indexOf('=') + 1);
      expect(
        validateAnnotationIdentity(
          tags.map((tag) => (tag.startsWith(prefix) ? changedTag : tag)),
          expected
        )
      ).toContain('changed since it was listed');
    });
  });

  describe('local contract fixture', () => {
    it('matches the tags produced by the application writer', () => {
      expect(contractFixture.tags).toEqual(
        buildAnnotationTags({ category: 'maintenance', job: '12345', cluster: 'gpu-a' })
      );
    });

    it('round-trips through the application parser', () => {
      const parsed = parseAnnotationTags(contractFixture.tags);
      expect(parsed).toMatchObject({
        hasMarker: true,
        schema: ANNOTATION_SCHEMA_VERSION,
        job: '12345',
        cluster: 'gpu-a',
        category: 'maintenance',
      });
    });

    it('is a well-formed region annotation', () => {
      expect(contractFixture.timeEnd).toBeGreaterThan(contractFixture.time);
      expect(contractFixture.tags[0]).toBe(ANNOTATION_MARKER_TAG);
    });
  });
});
