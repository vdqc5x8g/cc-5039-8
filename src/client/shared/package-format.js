// Single source of truth for the offline package format.
//
// Both the browser loader and the maintenance tools import this module, so a
// format/version claim can never drift between docs, checker and runtime.
// Nothing here defaults a missing version: absence is a contract failure.

export const PACKAGE_FORMAT = 'offline-media-package';
export const PACKAGE_DESCRIPTOR_FILE = 'package.json';
export const MANIFEST_FILE = 'manifest.json';
export const OBJECTS_DIR = 'objects';

// Package layout versions. 2 = sealed directory (descriptor + content-addressed
// objects), 1 = legacy loose origin layout (catalog/manifest URLs, no seal).
export const ADOPTED_PACKAGE_FORMAT_VERSION = 2;
export const SUPPORTED_PACKAGE_FORMAT_VERSIONS = Object.freeze([2]);
export const LEGACY_PACKAGE_FORMAT_VERSION = 1;

// Manifest schema version. Both layouts carry the same schema today.
export const ADOPTED_MANIFEST_VERSION = 1;
export const SUPPORTED_MANIFEST_VERSIONS = Object.freeze([1]);

export const OFFICIAL_FILES = Object.freeze([PACKAGE_DESCRIPTOR_FILE, MANIFEST_FILE]);

export const FAILURE_CODES = Object.freeze({
  LAYOUT_UNKNOWN: 'LAYOUT_UNKNOWN',
  LAYOUT_BOUNDARY_VIOLATION: 'LAYOUT_BOUNDARY_VIOLATION',
  DESCRIPTOR_INVALID_JSON: 'DESCRIPTOR_INVALID_JSON',
  DESCRIPTOR_INVALID: 'DESCRIPTOR_INVALID',
  FORMAT_VERSION_MISSING: 'FORMAT_VERSION_MISSING',
  FORMAT_VERSION_UNSUPPORTED: 'FORMAT_VERSION_UNSUPPORTED',
  MANIFEST_MISSING: 'MANIFEST_MISSING',
  MANIFEST_INVALID_JSON: 'MANIFEST_INVALID_JSON',
  MANIFEST_SHAPE_INVALID: 'MANIFEST_SHAPE_INVALID',
  MANIFEST_SIZE_MISMATCH: 'MANIFEST_SIZE_MISMATCH',
  MANIFEST_DIGEST_MISMATCH: 'MANIFEST_DIGEST_MISMATCH',
  MANIFEST_VERSION_MISSING: 'MANIFEST_VERSION_MISSING',
  MANIFEST_VERSION_UNSUPPORTED: 'MANIFEST_VERSION_UNSUPPORTED',
  MANIFEST_VERSION_MISMATCH: 'MANIFEST_VERSION_MISMATCH',
  MANIFEST_COURSE_MISMATCH: 'MANIFEST_COURSE_MISMATCH',
  OBJECT_UNDECLARED: 'OBJECT_UNDECLARED',
  OBJECT_MISMATCH: 'OBJECT_MISMATCH',
  OBJECT_MISSING: 'OBJECT_MISSING',
  OBJECT_SIZE_MISMATCH: 'OBJECT_SIZE_MISMATCH',
  OBJECT_HASH_MISMATCH: 'OBJECT_HASH_MISMATCH',
  OBJECT_FILE_UNDECLARED: 'OBJECT_FILE_UNDECLARED',
  OBJECT_UNREFERENCED: 'OBJECT_UNREFERENCED',
});

export class PackageContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PackageContractError';
    this.code = code;
    this.details = details;
  }
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isHexDigest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isSize = (v) => Number.isInteger(v) && v >= 0;
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Public path normalizer shared by descriptor validation and the checker. */
export function normalizePackagePath(p) {
  return normalizeRel(p);
}

function isSafeRel(p) {
  const rel = normalizeRel(p);
  return rel.length > 0 && !rel.startsWith('/') && !rel.split('/').includes('..');
}

function isCachePath(p) {
  const rel = normalizeRel(p);
  return rel.startsWith(`${OBJECTS_DIR}/`) && rel.length > OBJECTS_DIR.length + 1;
}

/** Manifest version is mandatory. A missing version must never fall back to 1. */
export function assertSupportedManifestVersion(manifest) {
  if (!isPlainObject(manifest)) {
    throw new PackageContractError(FAILURE_CODES.MANIFEST_INVALID_JSON, '清单不是 JSON 对象');
  }
  if (!Object.hasOwn(manifest, 'version') || manifest.version === null) {
    throw new PackageContractError(
      FAILURE_CODES.MANIFEST_VERSION_MISSING,
      '清单缺少 version 字段（格式约定不接受默认版本）',
    );
  }
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.version)) {
    throw new PackageContractError(
      FAILURE_CODES.MANIFEST_VERSION_UNSUPPORTED,
      `不支持的清单版本 ${JSON.stringify(manifest.version)}（支持：${SUPPORTED_MANIFEST_VERSIONS.join(', ')}）`,
      { version: manifest.version, supported: [...SUPPORTED_MANIFEST_VERSIONS] },
    );
  }
  if (!isNonEmptyString(manifest.courseId)) {
    throw new PackageContractError(FAILURE_CODES.MANIFEST_SHAPE_INVALID, '清单缺少 courseId');
  }
  return manifest;
}

/**
 * Validate a sealed-package descriptor. Returns every problem instead of
 * throwing; the checker reports all of them. Never fills in a default version.
 */
export function validateDescriptor(descriptor) {
  const errors = [];
  const add = (code, message, field = null) => errors.push({ code, message, field });
  if (!isPlainObject(descriptor)) {
    add(FAILURE_CODES.DESCRIPTOR_INVALID, 'package.json 不是 JSON 对象');
    return errors;
  }
  if (descriptor.format !== PACKAGE_FORMAT) {
    add(FAILURE_CODES.DESCRIPTOR_INVALID, `format 必须为 ${PACKAGE_FORMAT}`, 'format');
  }
  if (!Object.hasOwn(descriptor, 'formatVersion') || descriptor.formatVersion === null) {
    add(FAILURE_CODES.FORMAT_VERSION_MISSING, '缺少 formatVersion（不接受默认版本）', 'formatVersion');
  } else if (!SUPPORTED_PACKAGE_FORMAT_VERSIONS.includes(descriptor.formatVersion)) {
    add(
      FAILURE_CODES.FORMAT_VERSION_UNSUPPORTED,
      `不支持的包格式版本 ${JSON.stringify(descriptor.formatVersion)}（支持：${SUPPORTED_PACKAGE_FORMAT_VERSIONS.join(', ')}）`,
      'formatVersion',
    );
  }
  if (!isNonEmptyString(descriptor.courseId)) {
    add(FAILURE_CODES.DESCRIPTOR_INVALID, '缺少 courseId', 'courseId');
  }

  const sel = descriptor.selection;
  if (!isPlainObject(sel)) {
    add(FAILURE_CODES.DESCRIPTOR_INVALID, '缺少 selection', 'selection');
  } else {
    if (!isNonEmptyString(sel.quality)) add(FAILURE_CODES.DESCRIPTOR_INVALID, 'selection.quality 缺失', 'selection.quality');
    if (!isNonEmptyString(sel.audio)) add(FAILURE_CODES.DESCRIPTOR_INVALID, 'selection.audio 缺失', 'selection.audio');
    if (!Array.isArray(sel.subs) || !sel.subs.every(isNonEmptyString)) {
      add(FAILURE_CODES.DESCRIPTOR_INVALID, 'selection.subs 必须是字符串数组', 'selection.subs');
    }
  }

  const m = descriptor.manifest;
  if (!isPlainObject(m)) {
    add(FAILURE_CODES.DESCRIPTOR_INVALID, '缺少 manifest 描述', 'manifest');
  } else {
    if (m.path !== MANIFEST_FILE) {
      add(FAILURE_CODES.LAYOUT_BOUNDARY_VIOLATION, `manifest.path 必须为 ${MANIFEST_FILE}`, 'manifest.path');
    }
    if (!isHexDigest(m.sha256)) {
      add(FAILURE_CODES.DESCRIPTOR_INVALID, 'manifest.sha256 必须是 64 位小写十六进制', 'manifest.sha256');
    }
    if (!isSize(m.size)) {
      add(FAILURE_CODES.DESCRIPTOR_INVALID, 'manifest.size 必须是非负整数', 'manifest.size');
    }
    if (!Object.hasOwn(m, 'version') || m.version === null) {
      add(FAILURE_CODES.MANIFEST_VERSION_MISSING, 'manifest.version 缺失（不接受默认版本）', 'manifest.version');
    } else if (!SUPPORTED_MANIFEST_VERSIONS.includes(m.version)) {
      add(
        FAILURE_CODES.MANIFEST_VERSION_UNSUPPORTED,
        `不支持的清单版本 ${JSON.stringify(m.version)}（支持：${SUPPORTED_MANIFEST_VERSIONS.join(', ')}）`,
        'manifest.version',
      );
    }
  }

  if (!Array.isArray(descriptor.objects) || descriptor.objects.length === 0) {
    add(FAILURE_CODES.DESCRIPTOR_INVALID, 'objects 必须是非空数组', 'objects');
    return errors;
  }

  const bySource = new Map();
  const byPath = new Map();
  const byHash = new Map();
  descriptor.objects.forEach((obj, i) => {
    const at = `objects[${i}]`;
    if (!isPlainObject(obj)) {
      add(FAILURE_CODES.DESCRIPTOR_INVALID, `${at} 不是对象`, at);
      return;
    }
    if (!Array.isArray(obj.sources) || obj.sources.length === 0 || !obj.sources.every(isSafeRel)) {
      add(FAILURE_CODES.DESCRIPTOR_INVALID, `${at}.sources 必须是非空的安全相对路径数组`, `${at}.sources`);
    }
    if (!isCachePath(obj.path)) {
      add(FAILURE_CODES.LAYOUT_BOUNDARY_VIOLATION, `${at}.path 必须位于 ${OBJECTS_DIR}/ 之下`, `${at}.path`);
    } else if (!isSafeRel(obj.path)) {
      add(FAILURE_CODES.DESCRIPTOR_INVALID, `${at}.path 必须是安全相对路径`, `${at}.path`);
    } else if (isHexDigest(obj.sha256) && normalizeRel(obj.path) !== `${OBJECTS_DIR}/${obj.sha256}`) {
      // The cache boundary is mechanical: one file per digest, named by digest.
      add(
        FAILURE_CODES.LAYOUT_BOUNDARY_VIOLATION,
        `${at}.path 必须是 ${OBJECTS_DIR}/<sha256>（缓存文件名即内容标识）`,
        `${at}.path`,
      );
    }
    if (!isHexDigest(obj.sha256)) add(FAILURE_CODES.DESCRIPTOR_INVALID, `${at}.sha256 必须是 64 位小写十六进制`, `${at}.sha256`);
    if (!isSize(obj.size)) add(FAILURE_CODES.DESCRIPTOR_INVALID, `${at}.size 必须是非负整数`, `${at}.size`);

    const cachePath = normalizeRel(obj.path);
    for (const s of Array.isArray(obj.sources) ? obj.sources : []) {
      const norm = normalizeRel(s);
      if (bySource.has(norm)) {
        add(FAILURE_CODES.DESCRIPTOR_INVALID, `${at}.sources 重复声明：${norm}`, `${at}.sources`);
      }
      bySource.set(norm, obj);
    }
    const prevH = byHash.get(obj.sha256);
    if (prevH) {
      // The object table is one row per content digest; duplicate rows are a
      // table error even when the bytes would agree.
      add(FAILURE_CODES.DESCRIPTOR_INVALID, `${at}.sha256 重复：${obj.sha256}`, `${at}.sha256`);
    }
    byHash.set(obj.sha256, obj);
    const prevP = byPath.get(cachePath);
    if (prevP && prevP.sha256 !== obj.sha256) {
      add(FAILURE_CODES.DESCRIPTOR_INVALID, `${at}.path 冲突：${cachePath}`, `${at}.path`);
    }
    byPath.set(cachePath, obj);
  });

  return errors;
}

/** Every media/text reference the manifest declares, in a stable order. */
export function collectManifestRefs(manifest) {
  if (!isPlainObject(manifest)) {
    throw new PackageContractError(FAILURE_CODES.MANIFEST_INVALID_JSON, '清单不是 JSON 对象');
  }
  const refs = [];
  const push = (ref, kind) => {
    if (!isPlainObject(ref) || !isNonEmptyString(ref.url) || !isHexDigest(ref.sha256) || !isSize(ref.size)) {
      throw new PackageContractError(
        FAILURE_CODES.MANIFEST_SHAPE_INVALID,
        `清单引用无效（${kind}）：需要 url、64 位 sha256 与非负 size`,
      );
    }
    refs.push({ source: normalizeRel(ref.url), sha256: ref.sha256, size: ref.size, kind });
  };

  for (const [quality, track] of Object.entries(manifest.video ?? {})) {
    push(track?.init, `video-init:${quality}`);
    (track?.segments ?? []).forEach((s, i) => push(s, `video:${quality}:${i}`));
  }
  for (const [language, track] of Object.entries(manifest.audio ?? {})) {
    push(track?.init, `audio-init:${language}`);
    (track?.segments ?? []).forEach((s, i) => push(s, `audio:${language}:${i}`));
  }
  for (const [language, track] of Object.entries(manifest.subtitles ?? {})) {
    push(track, `subtitle:${language}`);
  }
  if (refs.length === 0) {
    throw new PackageContractError(FAILURE_CODES.MANIFEST_SHAPE_INVALID, '清单没有声明任何媒体对象');
  }
  return refs;
}

/**
 * Rewrite manifest object URLs to their cache paths inside a sealed package.
 * Requires descriptor coverage of *every* manifest reference, not just the
 * selected combination, so an imported package is closed as a whole.
 */
export function rewriteManifestForPackage(manifest, descriptor) {
  const bySource = new Map();
  const byPath = new Map();
  for (const obj of descriptor.objects) {
    for (const s of obj.sources) bySource.set(normalizeRel(s), obj);
    byPath.set(normalizeRel(obj.path), obj);
  }
  const refs = collectManifestRefs(manifest);
  const entryFor = (source) => bySource.get(source) ?? byPath.get(source);

  for (const ref of refs) {
    const entry = entryFor(ref.source);
    if (!entry) {
      throw new PackageContractError(
        FAILURE_CODES.OBJECT_UNDECLARED,
        `包描述未声明清单对象：${ref.source}`,
        { source: ref.source },
      );
    }
    if (entry.sha256 !== ref.sha256 || entry.size !== ref.size) {
      throw new PackageContractError(
        FAILURE_CODES.OBJECT_MISMATCH,
        `包描述与清单不一致：${ref.source}（sha256/size 不匹配）`,
        { source: ref.source },
      );
    }
  }

  const clone = JSON.parse(JSON.stringify(manifest));
  const rewrite = (ref) => {
    ref.url = entryFor(normalizeRel(ref.url)).path;
  };
  for (const track of Object.values(clone.video ?? {})) {
    rewrite(track.init);
    track.segments.forEach(rewrite);
  }
  for (const track of Object.values(clone.audio ?? {})) {
    rewrite(track.init);
    track.segments.forEach(rewrite);
  }
  for (const track of Object.values(clone.subtitles ?? {})) rewrite(track);
  return clone;
}

/** First available combination, matching the UI's default selection. */
export function defaultSelection(manifest) {
  const quality = Object.keys(manifest.video ?? {})[0];
  const audio = Object.keys(manifest.audio ?? {})[0];
  if (!quality || !audio) {
    throw new PackageContractError(FAILURE_CODES.MANIFEST_SHAPE_INVALID, '清单缺少可播放的视频或音频轨道');
  }
  return { quality, audio, subs: Object.keys(manifest.subtitles ?? {}).slice(0, 1) };
}

/** Contract as exposed to tooling/docs; keep in sync with the constants above. */
export function formatContract() {
  return {
    packageFormat: PACKAGE_FORMAT,
    descriptorFile: PACKAGE_DESCRIPTOR_FILE,
    manifestFile: MANIFEST_FILE,
    objectsDir: OBJECTS_DIR,
    adoptedPackageFormatVersion: ADOPTED_PACKAGE_FORMAT_VERSION,
    supportedPackageFormatVersions: [...SUPPORTED_PACKAGE_FORMAT_VERSIONS],
    legacyPackageFormatVersion: LEGACY_PACKAGE_FORMAT_VERSION,
    adoptedManifestVersion: ADOPTED_MANIFEST_VERSION,
    supportedManifestVersions: [...SUPPORTED_MANIFEST_VERSIONS],
    failureCodes: Object.values(FAILURE_CODES),
  };
}
