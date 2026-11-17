// Cache/course separation: shared fragments are fetched once and reference-
// counted; deleting one course must not damage another.
import { test, expect } from '@playwright/test';
import {
  openApp, installViaEngine, engineStats, countOriginRequests,
  cutOriginNetwork, expectRealPlayback, SEL_BASE, KEY_A_BASE, KEY_B_BASE,
} from './helpers.js';

const mediaRequests = (counter) =>
  [...counter.byUrl.entries()].filter(([url]) => url.includes('/media/') && !url.endsWith('manifest.json'));

test('duplicate install is a no-op; shared fragments fetched once; delete keeps the other course intact', async ({ page, context }) => {
  await openApp(page);
  const counter = await countOriginRequests(context);

  // install course-a
  await installViaEngine(page, 'course-a', SEL_BASE);
  const afterA = mediaRequests(counter).length;
  expect(afterA).toBeGreaterThan(10);

  // duplicate install of the identical combination: zero new media fetches
  const again = await installViaEngine(page, 'course-a', SEL_BASE);
  expect(again.already).toBe(true);
  expect(mediaRequests(counter).length).toBe(afterA);

  // install course-b: shares the intro segment and identical init segments
  await installViaEngine(page, 'course-b', SEL_BASE);
  const introFetches = [...counter.byUrl.entries()]
    .filter(([url]) => url.includes('/media/shared/intro-v360-seg0.m4s'))
    .reduce((n, [, c]) => n + c, 0);
  expect(introFetches).toBe(1); // fetched once, for course-a only

  // every media object fetched at most once across both installs
  for (const [url, count] of mediaRequests(counter)) {
    expect(count, `duplicate fetch of ${url}`).toBe(1);
  }

  // cache holds the union, deduplicated by content hash:
  // 16 + 16 − 3 shared (video init, audio init, shared intro segment)
  const statsBoth = await engineStats(page);
  expect(statsBoth.objectCount).toBe(29);
  expect(statsBoth.courseCount).toBe(2);

  // delete course-a: shared objects survive, course-b still verifies complete
  await page.evaluate((key) => window.engine.remove(key), KEY_A_BASE);
  const statsAfterDelete = await engineStats(page);
  expect(statsAfterDelete.objectCount).toBe(16);
  expect(statsAfterDelete.courseCount).toBe(1);

  const verifyB = await page.evaluate((key) => window.engine.verify(key), KEY_B_BASE);
  expect(verifyB.ok).toBe(true);

  // course-b still plays, fully offline
  await cutOriginNetwork(context);
  await page.reload();
  await page.waitForFunction(() => window.appReady === true);
  const cardB = page.locator('.course-card[data-course-id="course-b"]');
  await expect(cardB.locator('.course-status[data-status="ready"]')).toHaveText('可用');
  await cardB.locator('.btn-play').click();
  await expectRealPlayback(page, 2);

  // deleting course-b too empties the cache — nothing leaks
  await page.evaluate((key) => window.engine.remove(key), KEY_B_BASE);
  const statsEmpty = await engineStats(page);
  expect(statsEmpty.objectCount).toBe(0);
  expect(statsEmpty.courseCount).toBe(0);
});

test('different combinations of one course track references independently', async ({ page }) => {
  await openApp(page);
  await installViaEngine(page, 'course-a', SEL_BASE);
  await installViaEngine(page, 'course-a', { quality: '720p', audio: 'en', subs: ['en'] });

  const stats = await engineStats(page);
  // 360p closure (16) + 720p closure (16) − shared: audio en (8) + sub en (1)
  expect(stats.objectCount).toBe(23);

  await page.evaluate((key) => window.engine.remove(key), KEY_A_BASE);
  const after = await engineStats(page);
  expect(after.objectCount).toBe(16); // exactly the 720p combination remains
  const verify720 = await page.evaluate(
    () => window.engine.verify('course-a::720p::en::en'),
  );
  expect(verify720.ok).toBe(true);
});
