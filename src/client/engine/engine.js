// OfflineEngine: install / resume / verify / remove offline course packages.
//
// Completion is never inferred from byte counts: a course becomes 'ready'
// only after every object in its manifest dependency closure has been
// fetched, hash-verified and committed with references — atomically.
import { MediaStore } from './store.js';
import { computeClosure, courseKey, playableFromPresence } from './closure.js';
import { planEviction, QuotaError } from './eviction.js';
import { sha256Hex } from './hash.js';

const CONCURRENCY = 3;

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
    return res.json();
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
