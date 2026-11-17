// Pure storage-quota eviction planner. No DOM, no IDB — unit-testable in Node.
//
// Policy:
//   1. Never evict anything referenced by a 'ready' or 'installing' course —
//      eviction must not break a usable offline package.
//   2. Evict unreferenced orphans first (oldest lastUsedAt first).
//   3. Then objects referenced only by 'failed' courses (LRU first).
//   4. If still insufficient, throw QuotaError — the caller aborts the
//      install loudly instead of pretending a partial package is complete.

export class QuotaError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'QuotaError';
    this.details = details;
  }
}

export function planEviction({ needed, free, objects, refCounts, courses }) {
  if (needed <= free) return { evict: [], freed: 0 };

  const protectedHashes = new Set();
  for (const course of courses) {
    if (course.status === 'ready' || course.status === 'installing') {
      for (const h of course.objects) protectedHashes.add(h);
    }
  }

  const candidates = objects
    .filter((o) => !protectedHashes.has(o.hash))
    .sort((a, b) => {
      const ra = refCounts.get(a.hash) ?? 0;
      const rb = refCounts.get(b.hash) ?? 0;
      if (ra !== rb) return ra - rb; // orphans before referenced
      return a.lastUsedAt - b.lastUsedAt; // LRU within a tier
    });

  const evict = [];
  let freed = 0;
  for (const o of candidates) {
    if (needed - freed <= free) break;
    evict.push(o.hash);
    freed += o.size;
  }

  if (needed - freed > free) {
    throw new QuotaError(
      `存储空间不足：需要 ${needed} 字节，当前可用 ${free} 字节，按规则最多再清理 ${freed} 字节`,
      { needed, available: free, reclaimable: freed, deficit: needed - freed - free },
    );
  }
  return { evict, freed };
}
