// OfflineEngine: install / resume / verify / remove offline course packages.
//
// Completion is never inferred from byte counts: a course becomes 'ready'
// only after every object in its manifest dependency closure has been
// fetched, hash-verified and committed with references — atomically.
import { MediaStore } from './store.js';
import { computeClosure, courseKey, playableFromPresence } from './closure.js';
import { planEviction, QuotaError } from './eviction.js';
import { sha256Hex } from './hash.js';
import { assertSupportedManifestVersion, PACKAGE_DESCRIPTOR_FILE } from '../shared/package-format.js';
import { evaluatePackage } from '../shared/package-contract.js';

const CONCURRENCY = 3;

/**
 * Index an imported package directory by package-relative path. A directory
 * picker prefixes every entry with the chosen folder's name; strip exactly
 * that shared prefix so `pkg/objects/x` becomes `objects/x`.
 */
function indexImportFiles(files) {
  const entries = [...files].map((file) => ({
    file,
    rel: String(file.webkitRelativePath || file.name).replace(/\\/g, '/'),
  }));
  const prefixed = entries.every((e) => e.rel.includes('/'));
  const strip = prefixed ? entries[0].rel.split('/')[0] : null;
  const byPath = new Map();
  for (const { file, rel } of entries) {
    const clean = strip && rel.startsWith(`${strip}/`) ? rel.slice(strip.length + 1) : rel;
    byPath.set(clean, file);
  }
  return byPath;
}

/**
 * The contract view of a directory picker selection, shared by the UI's
 * pre-flight check and importPackage. Keeps one indexing implementation so a
 * pre-check can never disagree with the import that follows it.
 */
export async function inspectPackageFiles(files) {
  const byPath = indexImportFiles(files);
  const readObject = async (rel) => {
    const file = byPath.get(rel);
    return file ? new Uint8Array(await file.arrayBuffer()) : null;
  };
  const report = await evaluatePackage({
    descriptorBytes: await readObject(PACKAGE_DESCRIPTOR_FILE),
    readObject,
    sha256: sha256Hex,
    objectFiles: [...byPath.keys()].filter((p) => p.startsWith('objects/')),
    topLevelEntries: [...byPath.keys()].filter((p) => !p.includes('/')),
  });
  return { byPath, report };
}

export class OfflineEngine {
  static async open({ dbName, originBase, estimateStorage } = {}) {
    const store = await MediaStore.open(dbName);
    const engine = new OfflineEngine(store, { originBase, estimateStorage });
    await store.gc();
    return engine;
  }

  constructor(store, { originBase, estimateStorage } = {}) {
    this.store = store;
    this.originBase = originBase ?? '';
    this._estimateStorage = estimateStorage
      ?? (() => (navigator.storage?.estimate ? navigator.storage.estimate() : Promise.resolve({})));
    this._listeners = new Set();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn();
  }

  // ---- network (online only) ----

  async fetchCatalog() {
    const res = await fetch(`${this.originBase}/catalog.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`课程目录获取失败：HTTP ${res.status}`);
    return res.json();
  }

  async fetchManifest(manifestUrl) {
    const res = await fetch(`${this.originBase}/${manifestUrl}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`课程清单获取失败：HTTP ${res.status} (${manifestUrl})`);
    const manifest = await res.json();
    // The loader accepts exactly the manifest versions the format contract
    // declares. A manifest without `version` is rejected, never assumed.
    return assertSupportedManifestVersion(manifest);
  }

  // ---- sealed offline package import (no network at all) ----

  /**
   * Import a sealed package directory (descriptor + manifest + objects/).
   * Every object is verified and committed to the cache; the course record's
   * manifest URLs point at cache paths, so later playback has no source to
   * fall back to.
   *
   * @param {FileList|File[]} files  files chosen from the package directory
   */
  async importPackage(files, { onProgress } = {}) {
    if (!files || files.length === 0) {
      throw new Error('未选择任何文件（请选择包含 package.json 的包目录）');
    }
    const { byPath, report } = await inspectPackageFiles(files);
    const readObject = async (rel) => {
      const file = byPath.get(rel);
      return file ? new Uint8Array(await file.arrayBuffer()) : null;
    };
    if (!report.ok) {
      const first = report.errors[0];
      const err = new Error(`离线包校验失败（${first.code}）：${first.message}`);
      err.code = first.code;
      err.errors = report.errors;
      throw err;
    }

    const { descriptor, manifest, closure } = report;
    const key = courseKey(manifest.courseId, descriptor.selection);
    const existing = await this.store.getCourse(key);
    if (existing?.status === 'ready' && (await this.verify(key)).ok) {
      return { key, already: true };
    }

    // Cache path is declared per digest, so import reads exactly the file the
    // descriptor claims — not a path re-derived from the manifest.
    const pathByHash = new Map(descriptor.objects.map((o) => [o.sha256, o.path]));
    const record = {
      key,
      courseId: manifest.courseId,
      title: manifest.title ?? manifest.courseId,
      manifestVersion: manifest.version,
      packageFormatVersion: descriptor.formatVersion,
      source: 'package',
      selection: descriptor.selection,
      closure,
      status: 'installing',
      error: null,
      bytesTotal: closure.totalBytes,
      bytesDone: 0,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
    };
    await this._syncPresence(record);
    await this.store.putCourse(record);
    this._emit();

    const total = closure.objects.length;
    let done = 0;
    try {
      for (const obj of closure.objects) {
        if (obj.done) { done += 1; continue; }
        const path = pathByHash.get(obj.hash);
        const bytes = path ? await readObject(path) : null;
        if (!bytes) throw new Error(`离线包缺少对象：${path ?? obj.hash}`);
        if (bytes.byteLength !== obj.size) {
          throw new Error(`大小不符，${obj.label}：期望 ${obj.size} 字节，实际 ${bytes.byteLength} 字节`);
        }
        if ((await sha256Hex(bytes)) !== obj.hash) {
          throw new Error(`内容校验失败，${obj.label}`);
        }
        await this.store.putObjectAndMark(key, { ...obj, bytes });
        obj.done = true;
        done += 1;
        onProgress?.({
          key, phase: 'object', label: obj.label,
          objectsDone: done, objectsTotal: total,
          bytesDone: record.bytesDone, bytesTotal: record.bytesTotal,
        });
      }
      const absent = [];
      for (const o of closure.objects) {
        if (!(await this.store.hasObject(o.hash))) absent.push(o);
      }
      if (absent.length > 0) {
        throw new Error(`离线包依赖未闭合，缺少 ${absent.length} 个对象：${absent[0].label} 等`);
      }
      await this.store.commitCourse(key);
      record.status = 'ready';
      record.packageImportedAt = Date.now();
      await this.store.putCourse(record);
      this._emit();
      return { key, already: false };
    } catch (err) {
      record.status = 'failed';
      record.error = err.message;
      await this.store.putCourse(record);
      this._emit();
      throw err;
    }
  }

  // ---- install / resume ----

  async install(manifest, selection, { onProgress } = {}) {
    const closure = computeClosure(manifest, selection);
    const key = courseKey(manifest.courseId, selection);
    const existing = await this.store.getCourse(key);
    if (existing?.status === 'ready') {
      const report = await this.verify(key);
      if (report.ok) return { key, already: true };
      // Cache lost objects (evicted/tampered): fall through and repair.
    }
    const record = {
      key,
      courseId: manifest.courseId,
      title: manifest.title,
      manifestVersion: manifest.version,
      selection,
      closure,
      status: 'installing',
      error: null,
      bytesTotal: closure.totalBytes,
      bytesDone: 0,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
    };
    await this._syncPresence(record);
    await this.store.putCourse(record);
    this._emit();
    return this._download(record, onProgress);
  }

  async resume(key, { onProgress } = {}) {
    const record = await this.store.getCourse(key);
    if (!record) throw new Error(`未知离线包：${key}`);
    if (record.status === 'ready') return { key, already: true };
    record.status = 'installing';
    record.error = null;
    await this._syncPresence(record);
    await this.store.putCourse(record);
    this._emit();
    return this._download(record, onProgress);
  }

  async _syncPresence(record) {
    record.bytesDone = 0;
    for (const o of record.closure.objects) {
      o.done = await this.store.hasObject(o.hash);
      if (o.done) record.bytesDone += o.size;
    }
  }

  async _download(record, onProgress) {
    const report = (extra = {}) => onProgress?.({
      key: record.key,
      objectsDone: record.closure.objects.filter((o) => o.done).length,
      objectsTotal: record.closure.objects.length,
      bytesDone: record.bytesDone,
      bytesTotal: record.bytesTotal,
      ...extra,
    });
    try {
      const missing = record.closure.objects.filter((o) => !o.done);
      await this._ensureSpace(missing.reduce((n, o) => n + o.size, 0));
      report({ phase: 'start' });

      const queue = [...missing];
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length > 0) {
          const obj = queue.shift();
          await this._fetchAndStore(record, obj);
          report({ phase: 'object', label: obj.label });
        }
      }));

      // Dependency-closure check: every object the manifest references must
      // now be present in the cache. Only then may the course flip to ready.
      const absent = [];
      for (const o of record.closure.objects) {
        if (!(await this.store.hasObject(o.hash))) absent.push(o);
      }
      if (absent.length > 0) {
        throw new Error(`清单依赖未闭合，缺少 ${absent.length} 个对象：${absent[0].label} 等`);
      }

      await this.store.commitCourse(record.key);
      record.status = 'ready';
      report({ phase: 'done' });
      this._emit();
      return { key: record.key };
    } catch (err) {
      record.status = 'failed';
      record.error = err.message;
      await this.store.putCourse(record);
      report({ phase: 'error', error: err.message });
      this._emit();
      throw err;
    }
  }

  async _fetchAndStore(record, obj) {
    const url = `${this.originBase}/${obj.url}`;
    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (err) {
      throw new Error(`网络错误，${obj.label}：${err.message}`);
    }
    if (!res.ok) {
      throw new Error(`片段缺失，${obj.label}：HTTP ${res.status} (${obj.url})`);
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength !== obj.size) {
      throw new Error(`大小不符，${obj.label}：期望 ${obj.size} 字节，实际 ${bytes.byteLength} 字节`);
    }
    const hash = await sha256Hex(bytes);
    if (hash !== obj.hash) {
      throw new Error(`内容校验失败，${obj.label}：期望 ${obj.hash.slice(0, 16)}…，实际 ${hash.slice(0, 16)}…`);
    }
    try {
      await this.store.putObjectAndMark(record.key, { ...obj, bytes });
    } catch (err) {
      if (err?.name !== 'QuotaExceededError') throw err;
      await this._ensureSpace(obj.size); // evict by rule, then retry once
      await this.store.putObjectAndMark(record.key, { ...obj, bytes });
    }
    obj.done = true;
    record.bytesDone += obj.size;
  }

  async _ensureSpace(needed) {
    if (needed <= 0) return { evict: [], freed: 0 };
    const { quota, usage } = await this._estimateStorage();
    if (quota == null || usage == null) return { evict: [], freed: 0 };
    const free = quota - usage;
    if (needed <= free) return { evict: [], freed: 0 };

    const [objects, courses, refs] = await Promise.all([
      this.store.listObjects(),
      this.store.listCourses(),
      this.store.listRefs(),
    ]);
    const plan = planEviction({
      needed,
      free,
      objects,
      refCounts: new Map(refs.map((r) => [r.hash, r.referrers.length])),
      courses: courses.map((c) => ({
        key: c.key,
        status: c.status,
        objects: c.closure.objects.map((o) => o.hash),
      })),
    });
    await this.store.deleteObjects(plan.evict);
    return plan;
  }

  // ---- introspection ----

  async list() {
    return this.store.listCourses();
  }

  async getRecord(key) {
    return this.store.getCourse(key);
  }

  /** Re-hash every cached object of a course and compare with the manifest. */
  async verify(key) {
    const record = await this.store.getCourse(key);
    if (!record) return { ok: false, notFound: true, missing: [], mismatched: [] };
    const missing = [];
    const mismatched = [];
    for (const o of record.closure.objects) {
      const stored = await this.store.getObject(o.hash);
      if (!stored) {
        missing.push(o);
        continue;
      }
      if ((await sha256Hex(stored.bytes)) !== o.hash) mismatched.push(o);
    }
    return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
  }

  async playableInfo(key) {
    const record = await this.store.getCourse(key);
    if (!record) return null;
    const presence = new Map();
    for (const o of record.closure.objects) {
      presence.set(o.hash, await this.store.hasObject(o.hash));
    }
    return {
      key,
      status: record.status,
      error: record.error,
      selection: record.selection,
      ...playableFromPresence(record.closure, (h) => presence.get(h) === true),
    };
  }

  async remove(key) {
    await this.store.removeCourse(key);
    this._emit();
  }

  async stats() {
    return this.store.stats();
  }

  // ---- test hooks (used by the e2e suite to simulate corruption/orphans) ----

  async _debugCorruptObject(hash) {
    const obj = await this.store.getObject(hash);
    if (!obj) throw new Error('no such object');
    const bytes = new Uint8Array(obj.bytes.slice(0));
    bytes[0] ^= 0xff; // same length, different content — defeats byte-count checks
    await this.store.run(['objects'], 'readwrite', (tx) => {
      tx.objectStore('objects').put({ ...obj, bytes: bytes.buffer });
    });
  }

  async _debugDeleteObject(hash) {
    await this.store.run(['objects'], 'readwrite', (tx) => {
      tx.objectStore('objects').delete(hash);
    });
  }

  async _debugSeedOrphan(size) {
    const bytes = new Uint8Array(size);
    bytes[0] = 1;
    const hash = await sha256Hex(bytes.buffer);
    await this.store.run(['objects'], 'readwrite', (tx) => {
      tx.objectStore('objects').put({ hash, bytes: bytes.buffer, size, kind: 'orphan', lastUsedAt: Date.now() });
    });
    return hash;
  }
}
