import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planEviction, QuotaError } from '../../src/client/engine/eviction.js';

const obj = (hash, size, lastUsedAt = 0) => ({ hash, size, lastUsedAt });

test('no eviction needed when space suffices', () => {
  const plan = planEviction({
    needed: 100, free: 200,
    objects: [obj('a', 100)], refCounts: new Map(), courses: [],
  });
  assert.deepEqual(plan, { evict: [], freed: 0 });
});

test('orphans are evicted first, LRU order', () => {
  const plan = planEviction({
    needed: 150, free: 0,
    objects: [obj('old', 100, 1), obj('new', 100, 2)],
    refCounts: new Map(),
    courses: [],
  });
  assert.deepEqual(plan.evict, ['old', 'new']);
  assert.equal(plan.freed, 200);
});

test('objects of ready courses are never evicted; failure is loud', () => {
  assert.throws(
    () => planEviction({
      needed: 300, free: 0,
      objects: [obj('ready-obj', 500, 1)],
      refCounts: new Map([['ready-obj', 1]]),
      courses: [{ key: 'k', status: 'ready', objects: ['ready-obj'] }],
    }),
    (err) => {
      assert.ok(err instanceof QuotaError);
      assert.equal(err.details.deficit, 300);
      return true;
    },
  );
});

test('failed-course objects are evictable, ready-course objects are not', () => {
  const plan = planEviction({
    needed: 100, free: 0,
    objects: [obj('failed-obj', 120, 1), obj('ready-obj', 120, 2)],
    refCounts: new Map([['failed-obj', 0], ['ready-obj', 1]]),
    courses: [
      { key: 'a', status: 'failed', objects: ['failed-obj'] },
      { key: 'b', status: 'ready', objects: ['ready-obj'] },
    ],
  });
  assert.deepEqual(plan.evict, ['failed-obj']);
});

test('installing courses are protected like ready ones', () => {
  assert.throws(
    () => planEviction({
      needed: 100, free: 0,
      objects: [obj('wip', 200, 1)],
      refCounts: new Map(),
      courses: [{ key: 'k', status: 'installing', objects: ['wip'] }],
    }),
    QuotaError,
  );
});

test('evicts only as much as needed', () => {
  const plan = planEviction({
    needed: 60, free: 50,
    objects: [obj('a', 100, 1), obj('b', 100, 2)],
    refCounts: new Map(),
    courses: [],
  });
  assert.deepEqual(plan.evict, ['a']);
  assert.equal(plan.freed, 100);
});
