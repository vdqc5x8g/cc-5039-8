// Quota: insufficient storage aborts loudly; the eviction policy reclaims
// orphans to make room; an aborted package never looks complete.
import { test, expect } from '@playwright/test';
import {
  openApp, installViaEngine, getRecord, engineStats, SEL_BASE, KEY_A_BASE,
} from './helpers.js';

async function setQuota(page, quota, usage = 0) {
  await page.evaluate(({ quota, usage }) => {
    window.engine._estimateStorage = async () => ({ quota, usage });
  }, { quota, usage });
}

test('insufficient quota: install aborts with a clear error, no fake completion', async ({ page }) => {
  await openApp(page);
  await setQuota(page, 100_000); // course-a 360p closure needs ~460 KB

  await expect(installViaEngine(page, 'course-a', SEL_BASE)).rejects.toThrow(/存储空间不足/);

  const record = await getRecord(page, KEY_A_BASE);
  expect(record.status).toBe('failed');
  expect(record.error).toContain('存储空间不足');

  await page.evaluate(() => window.engine._emit());
  const card = page.locator('.course-card[data-course-id="course-a"]');
  await expect(card.locator('.course-status[data-status="failed"]')).toHaveText('失败');
  await expect(card.locator('.course-error')).toContainText('存储空间不足');
  await expect(card.locator('.btn-play')).toBeDisabled();
});

test('eviction policy reclaims orphans to satisfy the quota', async ({ page }) => {
  await openApp(page);

  // seed a 500 KB unreferenced orphan (e.g. left over from a wiped course)
  const orphanHash = await page.evaluate(() => window.engine._debugSeedOrphan(500_000));
  const statsBefore = await engineStats(page);
  expect(statsBefore.objectCount).toBe(1);

  // quota too small for the course alone, enough after evicting the orphan
  await setQuota(page, 400_000);
  const result = await installViaEngine(page, 'course-a', SEL_BASE);
  expect(result.key).toBe(KEY_A_BASE);

  const orphanGone = await page.evaluate((h) => window.engine.store.hasObject(h), orphanHash);
  expect(orphanGone).toBe(false);

  const record = await getRecord(page, KEY_A_BASE);
  expect(record.status).toBe('ready');
  const verify = await page.evaluate((key) => window.engine.verify(key), KEY_A_BASE);
  expect(verify.ok).toBe(true);
});

test('eviction never touches objects of ready courses', async ({ page }) => {
  await openApp(page);
  await installViaEngine(page, 'course-a', SEL_BASE);

  // quota that cannot fit course-b and may not be satisfied by evicting
  // course-a (ready) — the install must abort, and course-a must stay intact
  await setQuota(page, 200_000);
  await expect(installViaEngine(page, 'course-b', SEL_BASE)).rejects.toThrow(/存储空间不足/);

  const verifyA = await page.evaluate((key) => window.engine.verify(key), KEY_A_BASE);
  expect(verifyA.ok).toBe(true);
  const recordB = await getRecord(page, 'course-b::360p::en::en');
  expect(recordB.status).toBe('failed');
});
