// Interruption: browser exit mid-download must not leave a package that
// looks complete. The record resumes honestly and finishes verifiably.
import { test, expect } from '@playwright/test';
import {
  openApp, throttleOrigin, cutOriginNetwork, expectRealPlayback, SEL_BASE, KEY_A_BASE,
} from './helpers.js';

test('browser exit mid-download: partial package is not usable, resume completes it', async ({ page, context }) => {
  await throttleOrigin(context, 250); // 16 objects × 250ms ≈ 4s window
  await openApp(page);

  // start the install without awaiting it
  await page.evaluate(async (sel) => {
    const manifest = await window.engine.fetchManifest('media/course-a/manifest.json');
    window.__install = window.engine.install(manifest, sel).catch(() => {});
  }, SEL_BASE);

  // wait until at least two objects are durably stored, then "exit"
  // (expect.poll checks resolved values; waitForFunction would pass on any
  // resolved promise regardless of truthiness)
  await expect.poll(async () => {
    const r = await page.evaluate((key) => window.engine.getRecord(key), KEY_A_BASE);
    return r?.closure.objects.filter((o) => o.done).length ?? 0;
  }, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.reload();
  await page.waitForFunction(() => window.appReady === true);

  // after the crash the package must NOT present itself as complete
  const record = await page.evaluate((key) => window.engine.getRecord(key), KEY_A_BASE);
  expect(['installing', 'failed']).toContain(record.status);
  expect(record.status).not.toBe('ready');
  const card = page.locator('.course-card[data-course-id="course-a"]');
  await expect(card.locator('.course-status[data-status="ready"]')).toHaveCount(0);
  await expect(card.locator('.btn-play')).toBeDisabled();
  await expect(card.locator('.btn-resume')).toBeVisible();

  // partial objects survived the exit (download does not restart from zero)
  const doneBefore = record.closure.objects.filter((o) => o.done).length;
  expect(doneBefore).toBeGreaterThanOrEqual(2);

  // resume (without the throttle) and finish
  await context.unrouteAll();
  await card.locator('.btn-resume').click();
  await expect(card.locator('.course-status[data-status="ready"]')).toHaveText('可用', { timeout: 60_000 });

  const verify = await page.evaluate((key) => window.engine.verify(key), KEY_A_BASE);
  expect(verify.ok).toBe(true);

  // and the finished package plays offline
  await cutOriginNetwork(context);
  await page.reload();
  await page.waitForFunction(() => window.appReady === true);
  await page.locator('.course-card[data-course-id="course-a"] .btn-play').click();
  await expectRealPlayback(page, 2);
});
