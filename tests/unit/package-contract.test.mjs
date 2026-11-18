import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateDescriptor, assertSupportedManifestVersion, collectManifestRefs,
  defaultSelection, formatContract, FAILURE_CODES,
  ADOPTED_PACKAGE_FORMAT_VERSION, SUPPORTED_PACKAGE_FORMAT_VERSIONS,
  ADOPTED_MANIFEST_VERSION, SUPPORTED_MANIFEST_VERSIONS,
} from '../../src/client/shared/package-format.js';
import { evaluatePackage } from '../../src/client/shared/package-contract.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const manifestBytesRaw = {
  v: Buffer.from('0123456789'),
  a: Buffer.from('01234567890123456789'),
  s: Buffer.from('WEBVTT'),
};
const hashOf = {
  v: sha256(manifestBytesRaw.v),
  a: sha256(manifestBytesRaw.a),
  s: sha256(manifestBytesRaw.s),
};

const manifest = {
  courseId: 'c1',
  version: 1,
  title: 'T',
  video: { '360p': { codec: 'video/mp4', init: { url: 'media/v-init', sha256: hashOf.v, size: manifestBytesRaw.v.length }, segments: [] } },
  audio: { en: { codec: 'audio/mp4', init: { url: 'media/a-init', sha256: hashOf.a, size: manifestBytesRaw.a.length }, segments: [] } },
  subtitles: { en: { language: 'en', label: 'English', url: 'media/subs.vtt', sha256: hashOf.s, size: manifestBytesRaw.s.length } },
};

const bytesByHash = {
  [hashOf.v]: manifestBytesRaw.v,
  [hashOf.a]: manifestBytesRaw.a,
  [hashOf.s]: manifestBytesRaw.s,
};

/** Build a valid package directory in a temp dir. */
export function makePackage(dir, overrides = {}) {
  fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const descriptor = {
    format: 'offline-media-package',
    formatVersion: 2,
    courseId: 'c1',
    selection: { quality: '360p', audio: 'en', subs: ['en'] },
    manifest: { path: 'manifest.json', version: 1, sha256: sha256(manifestBytes), size: manifestBytes.length },
    objects: [
      { sources: ['media/v-init', `objects/${hashOf.v}`], path: `objects/${hashOf.v}`, sha256: hashOf.v, size: manifestBytesRaw.v.length },
      { sources: ['media/a-init', `objects/${hashOf.a}`], path: `objects/${hashOf.a}`, sha256: hashOf.a, size: manifestBytesRaw.a.length },
      { sources: ['media/subs.vtt', `objects/${hashOf.s}`], path: `objects/${hashOf.s}`, sha256: hashOf.s, size: manifestBytesRaw.s.length },
    ],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(descriptor, null, 2));
  for (const obj of descriptor.objects) {
    if (bytesByHash[obj.sha256]) fs.writeFileSync(path.join(dir, obj.path), bytesByHash[obj.sha256]);
  }
  return { dir, descriptor };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-contract-'));

test('adopted versions are the single supported versions', () => {
  assert.deepEqual([ADOPTED_PACKAGE_FORMAT_VERSION], [...SUPPORTED_PACKAGE_FORMAT_VERSIONS]);
  assert.deepEqual([ADOPTED_MANIFEST_VERSION], [...SUPPORTED_MANIFEST_VERSIONS]);
});

test('manifest version is mandatory and never defaulted', () => {
  assert.throws(() => assertSupportedManifestVersion({ courseId: 'c1' }),
    (err) => err.code === FAILURE_CODES.MANIFEST_VERSION_MISSING);
  assert.throws(() => assertSupportedManifestVersion({ courseId: 'c1', version: 2 }),
    (err) => err.code === FAILURE_CODES.MANIFEST_VERSION_UNSUPPORTED);
  assert.equal(assertSupportedManifestVersion(manifest), manifest);
});

test('descriptor without formatVersion is rejected, not assumed', () => {
  const errors = validateDescriptor({ format: 'offline-media-package', courseId: 'c', selection: {}, manifest: {}, objects: [{}] });
  assert.ok(errors.some((e) => e.code === FAILURE_CODES.FORMAT_VERSION_MISSING));
});

test('legacy formatVersion 1 is outside the supported range', () => {
  const { descriptor } = makePackage(tmp(), { formatVersion: 1 });
  const errors = validateDescriptor(descriptor);
  assert.ok(errors.some((e) => e.code === FAILURE_CODES.FORMAT_VERSION_UNSUPPORTED));
});

test('object path must be objects/<sha256> (cache boundary)', () => {
  const { descriptor } = makePackage(tmp());
  descriptor.objects[0].path = 'media/v-init';
  const errors = validateDescriptor(descriptor);
  assert.ok(errors.some((e) => e.code === FAILURE_CODES.LAYOUT_BOUNDARY_VIOLATION));
});

test('valid package passes evaluation', async () => {
  const { dir } = makePackage(tmp());
  const report = await check(dir);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.checkedObjects, 3);
  assert.ok(report.playableManifest);
});

test('truncated object fails on size', async () => {
  const { dir, descriptor } = makePackage(tmp());
  fs.writeFileSync(path.join(dir, descriptor.objects[0].path), Buffer.from('0123'));
  const report = await check(dir);
  assert.ok(report.errors.some((e) => e.code === FAILURE_CODES.OBJECT_SIZE_MISMATCH));
});

test('same-length corruption fails on hash', async () => {
  const { dir, descriptor } = makePackage(tmp());
  fs.writeFileSync(path.join(dir, descriptor.objects[0].path), Buffer.from('9876543210'));
  const report = await check(dir);
  assert.ok(report.errors.some((e) => e.code === FAILURE_CODES.OBJECT_HASH_MISMATCH));
});

test('missing object file is reported', async () => {
  const { dir, descriptor } = makePackage(tmp());
  fs.rmSync(path.join(dir, descriptor.objects[0].path));
  const report = await check(dir);
  assert.ok(report.errors.some((e) => e.code === FAILURE_CODES.OBJECT_MISSING));
});

test('stray root file violates the layout boundary', async () => {
  const { dir } = makePackage(tmp());
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'x');
  const report = await check(dir);
  assert.ok(report.errors.some((e) => e.code === FAILURE_CODES.LAYOUT_BOUNDARY_VIOLATION));
});

test('manifest without version fails even with matching digest', async () => {
  const { dir } = makePackage(tmp());
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  delete m.version;
  const bytes = Buffer.from(JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(dir, 'manifest.json'), bytes);
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  d.manifest.sha256 = sha256(bytes);
  d.manifest.size = bytes.length;
  delete d.manifest.version;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(d));
  const report = await check(dir);
  assert.ok(report.errors.some((e) => e.code === FAILURE_CODES.MANIFEST_VERSION_MISSING));
});

test('manifest digest mismatch fails before objects are trusted', async () => {
  const { dir } = makePackage(tmp());
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  d.manifest.sha256 = 'f'.repeat(64);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(d));
  const report = await check(dir);
  assert.ok(report.errors.some((e) => e.code === FAILURE_CODES.MANIFEST_DIGEST_MISMATCH));
});

test('undeclared object file is reported', async () => {
  const { dir } = makePackage(tmp());
  fs.writeFileSync(path.join(dir, 'objects', 'd'.repeat(64)), Buffer.from('zz'));
  const report = await check(dir);
  assert.ok(report.errors.some((e) => e.code === FAILURE_CODES.OBJECT_FILE_UNDECLARED));
});

test('collectManifestRefs enumerates every declared object', () => {
  const refs = collectManifestRefs(manifest);
  assert.equal(refs.length, 3);
  assert.deepEqual(defaultSelection({ video: { '360p': {} }, audio: { en: {} }, subtitles: { en: {} } }),
    { quality: '360p', audio: 'en', subs: ['en'] });
});

test('formatContract exposes the machine-checkable contract', () => {
  const c = formatContract();
  assert.equal(c.packageFormat, 'offline-media-package');
  assert.equal(c.adoptedPackageFormatVersion, 2);
  assert.ok(c.failureCodes.includes(FAILURE_CODES.MANIFEST_VERSION_MISSING));
});

async function check(dir) {
  const read = (rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel)) : null);
  const walk = (rel = '') => {
    const out = [];
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...walk(child));
      else out.push(child);
    }
    return out;
  };
  const files = walk();
  return evaluatePackage({
    descriptorBytes: read('package.json'),
    readObject: async (rel) => read(rel),
    sha256,
    objectFiles: files.filter((f) => f.startsWith('objects/')),
    topLevelEntries: files.filter((f) => !f.includes('/')),
  });
}

void ROOT;
