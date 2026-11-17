// MediaStore: content-addressed cache objects kept strictly separate from
// course records. Courses reference objects by hash through the refs table
// (hash → set of course keys), so shared fragments are stored once and a
// course can only be deleted without breaking others.
import { openDb, reqP, txDone } from './idb.js';

const DB_VERSION = 1;

export class MediaStore {
  static async open(dbName = 'offline-media-v1') {
    const db = await openDb(dbName, DB_VERSION, (d) => {
      d.createObjectStore('objects', { keyPath: 'hash' });
      d.createObjectStore('refs', { keyPath: 'hash' });
      d.createObjectStore('courses', { keyPath: 'key' });
    });
    return new MediaStore(db);
  }

  constructor(db) {
    this.db = db;
  }

  async run(stores, mode, fn) {
    const tx = this.db.transaction(stores, mode);
    const out = await fn(tx);
    await txDone(tx);
    return out;
  }

  // ---- cache objects ----

  async hasObject(hash) {
    const key = await reqP(this.db.transaction('objects').objectStore('objects').getKey(hash));
    return key != null;
  }

  async getObject(hash) {
    return reqP(this.db.transaction('objects').objectStore('objects').get(hash));
  }

  async listObjects() {
    return reqP(this.db.transaction('objects').objectStore('objects').getAll());
  }

  async listRefs() {
    return reqP(this.db.transaction('refs').objectStore('refs').getAll());
  }

  async deleteObjects(hashes) {
    if (hashes.length === 0) return;
    await this.run(['objects', 'refs'], 'readwrite', (tx) => {
      for (const hash of hashes) {
        tx.objectStore('objects').delete(hash);
        tx.objectStore('refs').delete(hash);
      }
    });
  }

  /** Store a verified object and flag it done on the course record, atomically. */
  async putObjectAndMark(courseKey, obj) {
    await this.run(['objects', 'courses'], 'readwrite', async (tx) => {
      tx.objectStore('objects').put({
        hash: obj.hash, bytes: obj.bytes, size: obj.size,
        kind: obj.kind, lastUsedAt: Date.now(),
      });
      const course = await reqP(tx.objectStore('courses').get(courseKey));
      if (course) {
        const entry = course.closure.objects.find((o) => o.hash === obj.hash);
        if (entry && !entry.done) {
          entry.done = true;
          course.bytesDone += obj.size;
        }
        course.updatedAt = Date.now();
        tx.objectStore('courses').put(course);
      }
    });
  }

  // ---- course registry ----

  async putCourse(record) {
    await this.run(['courses'], 'readwrite', (tx) => {
      tx.objectStore('courses').put({ ...record, updatedAt: Date.now() });
    });
  }

  async getCourse(key) {
    return reqP(this.db.transaction('courses').objectStore('courses').get(key));
  }

  async listCourses() {
    return reqP(this.db.transaction('courses').objectStore('courses').getAll());
  }

  /**
   * Commit a fully downloaded course: register its references and flip it to
   * 'ready' in one transaction. Idempotent — referrers are a set, so a retried
   * commit never double-counts.
   */
  async commitCourse(key) {
    await this.run(['courses', 'refs'], 'readwrite', async (tx) => {
      const course = await reqP(tx.objectStore('courses').get(key));
      if (!course) throw new Error(`commitCourse: unknown course ${key}`);
      for (const o of course.closure.objects) {
        const ref = (await reqP(tx.objectStore('refs').get(o.hash))) ?? { hash: o.hash, referrers: [] };
        if (!ref.referrers.includes(key)) ref.referrers.push(key);
        tx.objectStore('refs').put(ref);
      }
      course.status = 'ready';
      course.error = null;
      course.completedAt = Date.now();
      course.updatedAt = Date.now();
      tx.objectStore('courses').put(course);
    });
  }

  /**
   * Remove a course and release its references. Objects still referenced by
   * other courses (via refs or any remaining course record) survive; the rest
   * are deleted in the same transaction.
   */
  async removeCourse(key) {
    await this.run(['courses', 'refs', 'objects'], 'readwrite', async (tx) => {
      const course = await reqP(tx.objectStore('courses').get(key));
      if (!course) return;
      tx.objectStore('courses').delete(key);

      const hashes = course.closure.objects.map((o) => o.hash);
      const refEntries = [];
      for (const hash of hashes) {
        const ref = await reqP(tx.objectStore('refs').get(hash));
        if (ref) {
          ref.referrers = ref.referrers.filter((k) => k !== key);
          if (ref.referrers.length === 0) tx.objectStore('refs').delete(hash);
          else tx.objectStore('refs').put(ref);
        }
        refEntries.push([hash, ref]);
      }

      const remaining = await reqP(tx.objectStore('courses').getAll());
      const stillListed = new Set();
      for (const c of remaining) for (const o of c.closure.objects) stillListed.add(o.hash);

      for (const [hash, ref] of refEntries) {
        const referrers = (ref?.referrers ?? []).filter((k) => k !== key);
        if (referrers.length === 0 && !stillListed.has(hash)) {
          tx.objectStore('objects').delete(hash);
          tx.objectStore('refs').delete(hash);
        }
      }
    });
  }

  /** Delete objects no course record and no ref entry points at. */
  async gc() {
    await this.run(['courses', 'refs', 'objects'], 'readwrite', async (tx) => {
      const [courses, refs, objects] = await Promise.all([
        reqP(tx.objectStore('courses').getAll()),
        reqP(tx.objectStore('refs').getAll()),
        reqP(tx.objectStore('objects').getAll()),
      ]);
      const keep = new Set(refs.filter((r) => r.referrers.length > 0).map((r) => r.hash));
      for (const c of courses) for (const o of c.closure.objects) keep.add(o.hash);
      for (const o of objects) {
        if (!keep.has(o.hash)) tx.objectStore('objects').delete(o.hash);
      }
    });
  }

  async stats() {
    const [objects, courses, refs] = await Promise.all([
      this.listObjects(), this.listCourses(), this.listRefs(),
    ]);
    return {
      objectCount: objects.length,
      objectBytes: objects.reduce((n, o) => n + o.size, 0),
      courseCount: courses.length,
      refCount: refs.length,
    };
  }
}
