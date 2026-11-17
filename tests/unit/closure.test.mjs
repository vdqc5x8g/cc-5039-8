import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeClosure, courseKey, playableFromPresence, SelectionError } from '../../src/client/engine/closure.js';

const ref = (name, size = 100, duration) => ({
  url: `media/${name}`,
  sha256: `hash-${name}`,
  size,
  ...(duration != null ? { duration } : {}),
});

const manifest = {
  courseId: 'c1',
  version: 1,
  title: 'T',
  video: {
    '360p': {
      codec: 'video/mp4',
      init: ref('v-init'),
      segments: [ref('shared-intro', 100, 2), ref('v-s1', 100, 2), ref('v-s2', 100, 2)],
    },
    '720p': {
      codec: 'video/mp4',
      init: ref('v-init-720'),
      segments: [ref('shared-intro', 100, 2), ref('v720-s1', 100, 2)],
    },
  },
  audio: {
    en: { codec: 'audio/mp4', init: ref('a-init'), segments: [ref('a-s0', 50, 2), ref('a-s1', 50, 2), ref('a-s2', 50, 2)] },
    zh: { codec: 'audio/mp4', init: ref('a-init-zh'), segments: [ref('az-s0', 50, 2)] },
  },
  subtitles: {
    en: { language: 'en', label: 'English', ...ref('sub-en', 10) },
    zh: { language: 'zh', label: '中文', ...ref('sub-zh', 10) },
  },
};

test('closure contains exactly the selected combination', () => {
  const c = computeClosure(manifest, { quality: '360p', audio: 'en', subs: ['en', 'zh'] });
  const kinds = c.objects.map((o) => o.kind);
  assert.equal(kinds.filter((k) => k === 'video-init').length, 1);
  assert.equal(kinds.filter((k) => k === 'video').length, 3);
  assert.equal(kinds.filter((k) => k === 'audio-init').length, 1);
  assert.equal(kinds.filter((k) => k === 'audio').length, 3);
  assert.equal(kinds.filter((k) => k === 'subtitle').length, 2);
  assert.equal(c.duration, 6);
});

test('shared objects are deduplicated by content hash inside the closure', () => {
  const c = computeClosure(manifest, { quality: '720p', audio: 'en', subs: [] });
  const hashes = c.objects.map((o) => o.hash);
  assert.equal(new Set(hashes).size, hashes.length);
  // the shared intro segment appears once even though it is segment 0 of both qualities
  assert.equal(hashes.filter((h) => h === 'hash-shared-intro').length, 1);
});

test('unknown quality / language raises SelectionError', () => {
  assert.throws(() => computeClosure(manifest, { quality: '4k', audio: 'en', subs: [] }), SelectionError);
  assert.throws(() => computeClosure(manifest, { quality: '360p', audio: 'fr', subs: [] }), SelectionError);
  assert.throws(() => computeClosure(manifest, { quality: '360p', audio: 'en', subs: ['fr'] }), SelectionError);
});

test('courseKey is deterministic and distinguishes combinations', () => {
  const a = courseKey('c1', { quality: '360p', audio: 'en', subs: ['zh', 'en'] });
  const b = courseKey('c1', { quality: '360p', audio: 'en', subs: ['en', 'zh'] });
  const c = courseKey('c1', { quality: '720p', audio: 'en', subs: ['en', 'zh'] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('playableFromPresence: missing init means zero playable range', () => {
  const c = computeClosure(manifest, { quality: '360p', audio: 'en', subs: ['en'] });
  const present = new Set(c.objects.map((o) => o.hash));
  present.delete('hash-v-init');
  const info = playableFromPresence(c, (h) => present.has(h));
  assert.equal(info.complete, false);
  assert.equal(info.contiguousSeconds, 0);
  assert.equal(info.missingInit.length, 1);
});

test('playableFromPresence: contiguous range stops at first missing fragment', () => {
  const c = computeClosure(manifest, { quality: '360p', audio: 'en', subs: [] });
  const present = new Set(c.objects.map((o) => o.hash));
  present.delete('hash-v-s1'); // second video fragment
  const info = playableFromPresence(c, (h) => present.has(h));
  assert.equal(info.contiguousSeconds, 2); // only the intro fragment
  assert.equal(info.complete, false);
});

test('playableFromPresence: full presence means complete', () => {
  const c = computeClosure(manifest, { quality: '360p', audio: 'en', subs: ['zh'] });
  const present = new Set(c.objects.map((o) => o.hash));
  const info = playableFromPresence(c, (h) => present.has(h));
  assert.equal(info.complete, true);
  assert.equal(info.contiguousSeconds, 6);
  assert.equal(info.missingSubtitles.length, 0);
});
