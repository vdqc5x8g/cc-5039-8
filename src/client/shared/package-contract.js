// Shared package contract evaluation. The browser loader and the CLI checker
// call this exact function, so "the docs say X" and "the loader accepts X" are
// the same statement. A missing or unsupported version is always an error;
// nothing is defaulted.
import {
  FAILURE_CODES,
  validateDescriptor,
  assertSupportedManifestVersion,
  collectManifestRefs,
  rewriteManifestForPackage,
  normalizePackagePath,
  PACKAGE_DESCRIPTOR_FILE,
  MANIFEST_FILE,
} from './package-format.js';
import { computeClosure } from '../engine/closure.js';

const textDecoder = new TextDecoder();

function parseJson(bytes, code, label) {
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch (err) {
    return { __parseError: new Error(`${label} 不是有效 JSON：${err.message}`), code };
  }
}

/**
 * @param {object} input
 * @param {Uint8Array|null} input.descriptorBytes  package.json bytes
 * @param {(path: string) => Promise<Uint8Array|null>} input.readObject  read a
 *   declared package file by package-relative path (e.g. "objects/<sha>")
 * @param {(bytes: Uint8Array) => Promise<string>} input.sha256
 * @param {string[]} [input.objectFiles]  actual files under objects/, used to
 *   detect files that exist but no descriptor entry claims
 * @param {string[]} [input.topLevelEntries]  actual entries at package root
 */
export async function evaluatePackage({ descriptorBytes, readObject, sha256, objectFiles = [], topLevelEntries = [] }) {
  const errors = [];
  const add = (code, message, detail = {}) => errors.push({ code, message, ...detail });
  const result = { ok: false, errors, manifest: null, descriptor: null, checkedObjects: 0 };

  if (!descriptorBytes) {
    add(FAILURE_CODES.DESCRIPTOR_INVALID, `缺少 ${PACKAGE_DESCRIPTOR_FILE}`);
    return result;
  }
  const descriptor = parseJson(descriptorBytes, FAILURE_CODES.DESCRIPTOR_INVALID_JSON, PACKAGE_DESCRIPTOR_FILE);
  if (descriptor?.__parseError) {
    add(FAILURE_CODES.DESCRIPTOR_INVALID_JSON, descriptor.__parseError.message);
    return result;
  }
  result.descriptor = descriptor;

  for (const e of validateDescriptor(descriptor)) errors.push(e);
  if (errors.length > 0) return result;

  // Formal file boundary: descriptor + manifest + objects/ only.
  const official = new Set([PACKAGE_DESCRIPTOR_FILE, MANIFEST_FILE]);
  for (const entry of topLevelEntries) {
    if (!official.has(entry) && entry !== 'objects') {
      add(FAILURE_CODES.LAYOUT_BOUNDARY_VIOLATION, `包根目录出现非正式文件：${entry}`, { entry });
    }
  }

  // Manifest bytes must match the digest recorded in the descriptor.
  const manifestBytes = await readObject(MANIFEST_FILE);
  if (!manifestBytes) {
    add(FAILURE_CODES.MANIFEST_MISSING, `缺少 ${MANIFEST_FILE}`);
    return result;
  }
  if (manifestBytes.byteLength !== descriptor.manifest.size) {
    add(
      FAILURE_CODES.MANIFEST_SIZE_MISMATCH,
      `${MANIFEST_FILE} 大小不符：描述 ${descriptor.manifest.size}，实际 ${manifestBytes.byteLength}`,
    );
  }
  const manifestDigest = await sha256(manifestBytes);
  if (manifestDigest !== descriptor.manifest.sha256) {
    add(FAILURE_CODES.MANIFEST_DIGEST_MISMATCH, `${MANIFEST_FILE} 摘要与包描述不符`);
  }

  const manifest = parseJson(manifestBytes, FAILURE_CODES.MANIFEST_INVALID_JSON, MANIFEST_FILE);
  if (manifest?.__parseError) {
    add(FAILURE_CODES.MANIFEST_INVALID_JSON, manifest.__parseError.message);
    return result;
  }
  result.manifest = manifest;

  try {
    assertSupportedManifestVersion(manifest);
  } catch (err) {
    add(err.code ?? FAILURE_CODES.MANIFEST_SHAPE_INVALID, err.message);
  }
  if (Object.hasOwn(manifest, 'version') && manifest.version !== descriptor.manifest.version) {
    add(
      FAILURE_CODES.MANIFEST_VERSION_MISMATCH,
      `清单 version=${JSON.stringify(manifest.version)} 与包描述 version=${JSON.stringify(descriptor.manifest.version)} 不一致`,
    );
  }
  if (manifest.courseId !== descriptor.courseId) {
    add(FAILURE_CODES.MANIFEST_COURSE_MISMATCH, `清单 courseId 与包描述不一致：${manifest.courseId} ≠ ${descriptor.courseId}`);
  }
  if (errors.length > 0) return result;

  let refs;
  try {
    refs = collectManifestRefs(manifest);
  } catch (err) {
    add(err.code ?? FAILURE_CODES.MANIFEST_SHAPE_INVALID, err.message);
    return result;
  }

  const declaredBySource = new Map();
  const declaredByPath = new Map();
  for (const obj of descriptor.objects) {
    for (const s of obj.sources) declaredBySource.set(normalizePackagePath(s), obj);
    declaredByPath.set(normalizePackagePath(obj.path), obj);
  }
  // Sealed manifests reference cache copies as objects/<sha256>; loose source
  // manifests reference their original URL. Either way the reference must map
  // to a declared row and agree with it.
  for (const ref of refs) {
    const entry = declaredBySource.get(ref.source) ?? declaredByPath.get(ref.source);
    if (!entry) {
      add(FAILURE_CODES.OBJECT_UNDECLARED, `清单引用未在包描述中声明：${ref.source}`, { source: ref.source });
    } else if (entry.sha256 !== ref.sha256 || entry.size !== ref.size) {
      add(FAILURE_CODES.OBJECT_MISMATCH, `包描述与清单不一致：${ref.source}`, { source: ref.source });
    }
  }
  const referencedSources = new Set();
  for (const ref of refs) {
    referencedSources.add(ref.source);
    const entry = declaredBySource.get(ref.source) ?? declaredByPath.get(ref.source);
    if (entry) {
      referencedSources.add(normalizePackagePath(entry.path));
      for (const s of entry.sources) referencedSources.add(normalizePackagePath(s));
    }
  }
  for (const obj of descriptor.objects) {
    const covered = obj.sources.some((s) => referencedSources.has(normalizePackagePath(s)))
      || referencedSources.has(normalizePackagePath(obj.path));
    if (!covered) {
      add(FAILURE_CODES.OBJECT_UNREFERENCED, `包描述声明了清单未引用的对象：${obj.sources[0]}`, { source: obj.sources[0] });
    }
  }

  const declaredPaths = new Set(descriptor.objects.map((o) => normalizePackagePath(o.path)));
  for (const file of objectFiles) {
    if (!declaredPaths.has(normalizePackagePath(file))) {
      add(FAILURE_CODES.OBJECT_FILE_UNDECLARED, `objects/ 中存在包描述未登记的文件：${file}`, { file });
    }
  }

  for (const obj of descriptor.objects) {
    const bytes = await readObject(obj.path);
    if (!bytes) {
      add(FAILURE_CODES.OBJECT_MISSING, `缺少对象文件 ${obj.path}（${obj.sources[0]}）`, { path: obj.path, source: obj.sources[0] });
      continue;
    }
    result.checkedObjects += 1;
    if (bytes.byteLength !== obj.size) {
      add(
        FAILURE_CODES.OBJECT_SIZE_MISMATCH,
        `对象大小不符：${obj.sources[0]} 期望 ${obj.size}，实际 ${bytes.byteLength}`,
        { path: obj.path, source: obj.sources[0] },
      );
      continue;
    }
    if ((await sha256(bytes)) !== obj.sha256) {
      add(FAILURE_CODES.OBJECT_HASH_MISMATCH, `对象内容校验失败：${obj.sources[0]}`, { path: obj.path, source: obj.sources[0] });
    }
  }

  result.ok = errors.length === 0;
  if (result.ok) {
    try {
      // The descriptor's selection must still resolve against the manifest;
      // an imported package whose declared combination vanished is unusable.
      const closure = computeClosure(manifest, descriptor.selection);
      result.closure = closure;
      result.playableManifest = rewriteManifestForPackage(manifest, descriptor);
    } catch (err) {
      add(err.code ?? FAILURE_CODES.MANIFEST_SHAPE_INVALID, err.message);
      result.ok = false;
    }
  }
  return result;
}
