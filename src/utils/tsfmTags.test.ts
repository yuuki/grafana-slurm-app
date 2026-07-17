import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildTsfmTags,
  MAX_TAG_VALUE_LENGTH,
  parseTsfmTags,
  prepareConfirmUpdate,
  setQualityTag,
  TSFM_LABEL_TAG,
  validateTsfmLabelInput,
} from './tsfmTags';
import contractFixture from './__fixtures__/tsfm-annotation-contract.json';

// sakuraone tsfm/tests/test_annotations.py の CONTRACT_FIXTURE_SHA256 と同期する。
// 変更する場合は両リポジトリのフィクスチャと本定数を同時に更新すること。
const CONTRACT_FIXTURE_SHA256 = 'e0ee3187c2c0692693ce0ba5afed779ed767d89f89b82f22d1c13559356614c9';

describe('tsfmTags', () => {
  describe('buildTsfmTags / parseTsfmTags round-trip', () => {
    it('builds the ordered contract tag array', () => {
      expect(buildTsfmTags({ event: 'thermal_throttle', job: '12345', cluster: 'isk', quality: 'candidate' })).toEqual([
        'tsfm:label',
        'tsfm:event=thermal_throttle',
        'tsfm:job=12345',
        'tsfm:cluster=isk',
        'tsfm:quality=candidate',
      ]);
    });

    it('parses back the structured view it built', () => {
      const tags = buildTsfmTags({ event: 'nccl_stall', job: '42', cluster: 'osk', quality: 'confirmed' });
      const parsed = parseTsfmTags(tags);
      expect(parsed).toEqual({
        hasLabel: true,
        event: 'nccl_stall',
        job: '42',
        cluster: 'osk',
        quality: 'confirmed',
        duplicateKeys: [],
        unknownTags: [],
      });
    });

    it('trims values when building', () => {
      expect(buildTsfmTags({ event: '  other  ', job: ' 7 ', cluster: ' isk ', quality: 'candidate' })).toEqual([
        'tsfm:label',
        'tsfm:event=other',
        'tsfm:job=7',
        'tsfm:cluster=isk',
        'tsfm:quality=candidate',
      ]);
    });
  });

  describe('parseTsfmTags', () => {
    it('preserves unknown and non-tsfm tags', () => {
      const parsed = parseTsfmTags([
        'tsfm:label',
        'tsfm:event=job_failure',
        'tsfm:job=1',
        'tsfm:cluster=isk',
        'tsfm:quality=candidate',
        'tsfm:hosts=node[1-4]',
        'incident-123',
      ]);
      expect(parsed.unknownTags).toEqual(['tsfm:hosts=node[1-4]', 'incident-123']);
    });

    it('flags duplicate key/value keys', () => {
      const parsed = parseTsfmTags(['tsfm:label', 'tsfm:quality=candidate', 'tsfm:quality=confirmed']);
      expect(parsed.duplicateKeys).toEqual(['quality']);
      // First occurrence wins for the structured value.
      expect(parsed.quality).toBe('candidate');
    });

    it('reports a missing label marker', () => {
      expect(parseTsfmTags(['tsfm:event=other']).hasLabel).toBe(false);
    });
  });

  describe('validateTsfmLabelInput', () => {
    it('accepts a valid input including a custom (out-of-vocabulary) event', () => {
      expect(
        validateTsfmLabelInput({ event: 'my_custom_event', job: '9', cluster: 'isk', quality: 'candidate' })
      ).toEqual([]);
    });

    it('rejects empty (post-trim) values', () => {
      const errors = validateTsfmLabelInput({ event: '   ', job: '1', cluster: 'isk', quality: 'candidate' });
      expect(errors).toContain('Event type must not be empty.');
    });

    it('rejects values over the length limit', () => {
      const errors = validateTsfmLabelInput({
        event: 'x'.repeat(MAX_TAG_VALUE_LENGTH + 1),
        job: '1',
        cluster: 'isk',
        quality: 'candidate',
      });
      expect(errors).toContain(`Event type must be at most ${MAX_TAG_VALUE_LENGTH} characters.`);
    });

    it('rejects an invalid quality', () => {
      const errors = validateTsfmLabelInput({
        event: 'other',
        job: '1',
        cluster: 'isk',
        // @ts-expect-error deliberately invalid to exercise the guard
        quality: 'bogus',
      });
      expect(errors.some((message) => message.startsWith('Quality must be one of'))).toBe(true);
    });
  });

  describe('setQualityTag', () => {
    it('replaces the quality tag while preserving every other tag', () => {
      const result = setQualityTag(
        ['tsfm:label', 'tsfm:event=other', 'tsfm:job=1', 'tsfm:cluster=isk', 'tsfm:quality=candidate', 'incident-7'],
        'confirmed'
      );
      expect(result).toEqual([
        'tsfm:label',
        'tsfm:event=other',
        'tsfm:job=1',
        'tsfm:cluster=isk',
        'incident-7',
        'tsfm:quality=confirmed',
      ]);
    });

    it('collapses duplicate quality tags into a single confirmed tag', () => {
      const result = setQualityTag(['tsfm:label', 'tsfm:quality=candidate', 'tsfm:quality=candidate'], 'confirmed');
      expect(result.filter((tag) => tag.startsWith('tsfm:quality='))).toEqual(['tsfm:quality=confirmed']);
    });
  });

  describe('prepareConfirmUpdate', () => {
    const expected = { event: 'thermal_throttle', job: '12345', cluster: 'isk' };

    it('replaces only quality with confirmed, preserving concurrent/unknown tags', () => {
      const latest = [
        'tsfm:label',
        'tsfm:event=thermal_throttle',
        'tsfm:job=12345',
        'tsfm:cluster=isk',
        'tsfm:quality=candidate',
        'tsfm:hosts=node[1-4]',
        'incident-42',
      ];
      const result = prepareConfirmUpdate(latest, expected);
      expect('tags' in result && result.tags).toEqual([
        'tsfm:label',
        'tsfm:event=thermal_throttle',
        'tsfm:job=12345',
        'tsfm:cluster=isk',
        'tsfm:hosts=node[1-4]',
        'incident-42',
        'tsfm:quality=confirmed',
      ]);
    });

    it('aborts when the label marker was removed', () => {
      const result = prepareConfirmUpdate(['tsfm:event=thermal_throttle', 'tsfm:job=12345', 'tsfm:cluster=isk'], expected);
      expect('error' in result).toBe(true);
    });

    it('aborts when identity tags drifted from the listed values', () => {
      const latest = ['tsfm:label', 'tsfm:event=nccl_stall', 'tsfm:job=12345', 'tsfm:cluster=isk', 'tsfm:quality=candidate'];
      const result = prepareConfirmUpdate(latest, expected);
      expect('error' in result).toBe(true);
    });

    it('aborts when a duplicate quality tag is present', () => {
      const latest = [
        'tsfm:label',
        'tsfm:event=thermal_throttle',
        'tsfm:job=12345',
        'tsfm:cluster=isk',
        'tsfm:quality=candidate',
        'tsfm:quality=confirmed',
      ];
      const result = prepareConfirmUpdate(latest, expected);
      expect('error' in result).toBe(true);
    });
  });

  describe('contract fixture', () => {
    // CONTRACT: this fixture is the frozen annotation JSON shape the app writes
    // and the sakuraone tsfm collector reads. The identical file must be copied
    // to sakuraone `tsfm/tests/fixtures/` and fed to `test_annotations.py`.
    // Any change here requires updating both sides in the same change set.
    it('matches the tags produced by buildTsfmTags', () => {
      const tags = buildTsfmTags({ event: 'thermal_throttle', job: '12345', cluster: 'isk', quality: 'candidate' });
      expect(contractFixture.tags).toEqual(tags);
    });

    it('round-trips through parseTsfmTags to the expected structured view', () => {
      const parsed = parseTsfmTags(contractFixture.tags);
      expect(parsed.hasLabel).toBe(true);
      expect(parsed.event).toBe('thermal_throttle');
      expect(parsed.job).toBe('12345');
      expect(parsed.cluster).toBe('isk');
      expect(parsed.quality).toBe('candidate');
    });

    it('is a well-formed region annotation (timeEnd after time)', () => {
      expect(contractFixture.timeEnd).toBeGreaterThan(contractFixture.time);
      expect(contractFixture.tags[0]).toBe(TSFM_LABEL_TAG);
    });

    it('locks the fixture byte content via sha256, catching one-sided drift', () => {
      const fixtureBytes = fs.readFileSync(path.join(__dirname, '__fixtures__', 'tsfm-annotation-contract.json'));
      const digest = crypto.createHash('sha256').update(fixtureBytes).digest('hex');
      expect(digest).toBe(CONTRACT_FIXTURE_SHA256);
    });
  });
});
