// Builds sealed offline packages (*.offline package directories) from a source
// manifest plus the origin media objects, and deterministic damaged variants.
//
//   node tools/build-package.js --course course-a --selection 360p:en:en \
//     --out packages/course-a-360p
//
// Layout (format version 2):
//   package.json    descriptor — format/version, courseId, selection, manifest
//                   digest, and the object table (source URL → objects/<sha256>)
//   manifest.json   the course manifest, object URLs rewritten to objects/<sha256>
//   objects/<sha256> one file per content digest (cache layer, not source media)
//
// Damaged variants are produced by --variant; each one is a distinct, labelled
// failure the checker and the loader must reject:
//   truncate-object   objects/<sha> cut short (download truncation)
//   corrupt-object    objects/<sha> same-length corruption (hash, not size)
//   missing-object    an object file removed
//   drop-manifest-version   manifest without `version` (old/loose manifests)
//   old-format-v1     descriptor claims formatVersion 1 (loader no longer
//                     supports it — expected to be rejected)
//   extra-file        a stray file at the package root (boundary violation)
//   bad-manifest-digest     descriptor manifest digest no longer matches
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_FORMAT, PACKAGE_DESCRIPTOR_FILE, MANIFEST_FILE, OBJECTS_DIR,
  ADOPTED_PACKAGE_FORMAT_VERSION, ADOPTED_MANIFEST_VERSION,
  collectManifestRefs, defaultSelection, normalizePackagePath,
} from '../src/client/shared/package-format.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(ROOT, 'origin-data');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const VARIANTS = Object.freeze([
  'truncate-object',
  'corrupt-object',
  'missing-object',
  'drop-manifest-version',
  'old-format-v1',
  'extra-file',
  'bad-manifest-digest',
]);

function parseSelection(value) {
  const [quality, audio, subsCsv = ''] = String(value).split(':');
  return { quality, audio, subs: subsCsv ? subsCsv.split('+').filter(Boolean) : [] };
}

function readSource(rel) {
  const file = path.join(SOURCE, normalizePackagePath(rel));
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

/** Build a sealed package directory in memory, then write it. */
export function buildPackage({ courseId, selection, outDir }) {
  const manifestPath = path.join(SOURCE, 'media', courseId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Object.hasOwn(manifest, 'version')) {
    throw new Error(`源清单缺少 version：${manifestPath}`);
  }
  const sel = selection ?? defaultSelection(manifest);
  const refs = collectManifestRefs(manifest);

  const objects = [];
  const bytesByHash = new Map();
  const objectByHash = new Map();
  for (const ref of refs) {
    const bytes = readSource(ref.source);
    if (!bytes) throw new Error(`源对象缺失：${ref.source}（无法打包缺陷课程，请选用完好的课程）`);
    if (bytes.length !== ref.size) throw new Error(`源对象大小不符：${ref.source}`);
    if (sha256(bytes) !== ref.sha256) throw new Error(`源对象摘要不符：${ref.source}`);
    const digest = ref.sha256;
    let entry = objectByHash.get(digest);
    if (!entry) {
      entry = {
        // Distinct source URLs can share one content digest (e.g. an init
        // segment reused by both audio languages). The table is keyed by
        // digest; every source URL that maps to it is recorded.
        sources: [],
        path: `${OBJECTS_DIR}/${digest}`,
        sha256: digest,
        size: ref.size,
      };
      objectByHash.set(digest, entry);
      objects.push(entry);
      bytesByHash.set(digest, bytes);
    } else if (entry.size !== ref.size) {
      throw new Error(`摘要相同但大小不同：${ref.source}`);
    }
    if (!entry.sources.includes(ref.source)) entry.sources.push(ref.source);
  }

  // Rewrite object URLs to the content-addressed cache copies.
  const pathBySource = new Map();
  for (const obj of objects) for (const s of obj.sources) pathBySource.set(s, obj.path);
  const sealed = JSON.parse(JSON.stringify(manifest));
  const rewrite = (ref) => { ref.url = pathBySource.get(normalizePackagePath(ref.url)); };
  for (const track of Object.values(sealed.video ?? {})) {
    rewrite(track.init);
    track.segments.forEach(rewrite);
  }
  for (const track of Object.values(sealed.audio ?? {})) {
    rewrite(track.init);
    track.segments.forEach(rewrite);
  }
  for (const track of Object.values(sealed.subtitles ?? {})) rewrite(track);

  const manifestBytes = Buffer.from(JSON.stringify(sealed, null, 2));
  const descriptor = {
    format: PACKAGE_FORMAT,
    formatVersion: ADOPTED_PACKAGE_FORMAT_VERSION,
    courseId: manifest.courseId,
    title: manifest.title,
    selection: sel,
    createdAt: new Date().toISOString(),
    manifest: {
      path: MANIFEST_FILE,
      version: manifest.version,
      sha256: sha256(manifestBytes),
      size: manifestBytes.length,
    },
    objects,
  };

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, OBJECTS_DIR), { recursive: true });
  fs.writeFileSync(path.join(outDir, PACKAGE_DESCRIPTOR_FILE), JSON.stringify(descriptor, null, 2));
  fs.writeFileSync(path.join(outDir, MANIFEST_FILE), manifestBytes);
  for (const obj of objects) {
    fs.writeFileSync(path.join(outDir, obj.path), bytesByHash.get(obj.sha256));
  }
  return { descriptor, manifest: sealed, bytesByHash, sel };
}

/**
 * Derive a damaged variant from an already-written package. Mutations are
 * targeted and labelled; they never silently "fix" anything.
 */
export function damagePackage(dir, variant) {
  const descriptorPath = path.join(dir, PACKAGE_DESCRIPTOR_FILE);
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  const target = descriptor.objects[0];

  switch (variant) {
    case 'truncate-object': {
      const p = path.join(dir, target.path);
      fs.writeFileSync(p, fs.readFileSync(p).subarray(0, Math.max(0, target.size - 7)));
      break;
    }
    case 'corrupt-object': {
      const p = path.join(dir, target.path);
      const bytes = fs.readFileSync(p);
      bytes[0] ^= 0xff; // same length, different content
      fs.writeFileSync(p, bytes);
      break;
    }
    case 'missing-object':
      fs.rmSync(path.join(dir, target.path));
      break;
    case 'drop-manifest-version': {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      delete m.version;
      const bytes = Buffer.from(JSON.stringify(m, null, 2));
      fs.writeFileSync(manifestPath, bytes);
      descriptor.manifest.size = bytes.length;
      descriptor.manifest.sha256 = sha256(bytes);
      fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2));
      break;
    }
    case 'old-format-v1':
      descriptor.formatVersion = 1;
      fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2));
      break;
    case 'extra-file':
      fs.writeFileSync(path.join(dir, 'README-note.txt'), 'stray file\n');
      break;
    case 'bad-manifest-digest':
      descriptor.manifest.sha256 = '0'.repeat(64);
      fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2));
      break;
    default:
      throw new Error(`未知损坏变体：${variant}`);
  }
  return { variant, descriptor };
}

function main(argv) {
  const args = { variant: null, out: null, course: null, selection: null, manifestVersion: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--course') args.course = argv[++i];
    else if (a === '--selection') args.selection = parseSelection(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--variant') args.variant = argv[++i];
    else if (a === '--manifest-version') args.manifestVersion = Number(argv[++i]);
    else throw new Error(`未知参数：${a}`);
  }
  if (!args.course || !args.out) {
    console.error('usage: node tools/build-package.js --course <id> --out <dir> [--selection 360p:en:en] [--variant <name>]');
    process.exit(2);
  }
  const out = path.resolve(ROOT, args.out);
  buildPackage({ courseId: args.course, selection: args.selection, outDir: out });
  if (args.variant) {
    if (!VARIANTS.includes(args.variant)) {
      console.error(`unknown variant ${args.variant}; known: ${VARIANTS.join(', ')}`);
      process.exit(2);
    }
    damagePackage(out, args.variant);
  }
  if (args.manifestVersion != null) {
    // Legacy manifests with an explicit older/newer version, for the checker.
    const descriptorPath = path.join(out, PACKAGE_DESCRIPTOR_FILE);
    const manifestPath = path.join(out, MANIFEST_FILE);
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    m.version = args.manifestVersion;
    const bytes = Buffer.from(JSON.stringify(m, null, 2));
    fs.writeFileSync(manifestPath, bytes);
    const d = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    d.manifest.version = args.manifestVersion;
    d.manifest.size = bytes.length;
    d.manifest.sha256 = sha256(bytes);
    fs.writeFileSync(descriptorPath, JSON.stringify(d, null, 2));
  }
  console.log(`package written: ${path.relative(ROOT, out)}${args.variant ? ` (variant: ${args.variant})` : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
