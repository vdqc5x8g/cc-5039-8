// Sealed package import through the real UI: choose a package directory in
// the browser, watch it validate and import with zero network, sever the
// origin, and play from cache. Damaged variants must be rejected with their
// failure code instead of importing.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutOriginNetwork, expectRealPlayback } from './helpers.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PACKAGES = path.join(ROOT, 'packages');

/** The directory input's browser-side file paths for a sample package. */
function packageFiles(name) {
  const dir = path.join(PACKAGES, name);
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else out.push(path.join(dir, child));
    }
  };
  walk('');
  return out;
}

async function choosePackage(page, name) {
  // webkitdirectory inputs take a directory path, preserving relative names.
  await page.locator('#package-input').setInputFiles(path.join(PACKAGES, name));
}

test('sealed package: choose in UI, import with zero network, play after cut', async ({ page, context }) => {
  const net = await cutOriginNetwork(context);
  await page.goto('/');
  await page.waitForFunction(() => window.appReady === true);

  await choosePackage(page, 'course-a-360p');
  await expect(page.locator('#package-report.ok')).toContainText('校验通过');
  await expect(page.locator('#package-status')).toContainText('离线包已导入', { timeout: 60_000 });

  // The imported package appears as a usable card even though the origin is cut.
  const card = page.locator('.course-card[data-course-id="course-a"]');
  await expect(card.locator('.course-status[data-status="ready"]')).toHaveText('可用');

  // Play from cache: real decoding, zero origin traffic.
  net.count = 0;
  net.urls = [];
  await card.locator('.btn-play').click();
  await expect(page.locator('#player-meta')).toContainText('数据来源：本地缓存');
  await expect(page.locator('#player-error')).toBeHidden();
  const playback = await expectRealPlayback(page, 2.5);
  expect(playback.duration).toBeGreaterThan(11.5);
  expect(net.count).toBe(0);
  const inPage = await page.evaluate(() => window.netMon.count);
  expect(inPage).toBe(0);
});

test('missing resource after import: window shows the gap and revokes availability', async ({ page, context }) => {
  await cutOriginNetwork(context);
  await page.goto('/');
  await page.waitForFunction(() => window.appReady === true);
  await choosePackage(page, 'course-a-360p');
  await expect(page.locator('#package-status')).toContainText('离线包已导入', { timeout: 60_000 });

  // Remove a cached fragment behind the UI's back, then try to play.
  await page.evaluate(async () => {
    const rec = await window.engine.getRecord('course-a::360p::en::en+zh');
    await window.engine._debugDeleteObject(rec.closure.tracks.video.segments[1].hash);
  });
  const card = page.locator('.course-card[data-course-id="course-a"]');
  await card.locator('.btn-play').click();
  await expect(page.locator('#player-error')).toBeVisible();
  await expect(page.locator('#player-error')).toContainText('缺失资源');
  // The player window is still shown with the failure, and the card no longer
  // claims the package is usable.
  await expect(page.locator('#player-active')).toBeVisible();
  await expect(card.locator('.course-status[data-status="incomplete"]')).toHaveText('缓存不完整');
  await expect(card.locator('.btn-play')).toBeDisabled();
});

test('damaged package is rejected before import, with its failure code shown', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.appReady === true);

  await choosePackage(page, 'course-a-360p--corrupt-object');
  await expect(page.locator('#package-report.bad')).toContainText('OBJECT_HASH_MISMATCH');
  await expect(page.locator('#package-status')).toContainText('校验失败');

  // Nothing was imported.
  const count = await page.evaluate(async () => (await window.engine.stats()).courseCount);
  expect(count).toBe(0);
});

test('legacy format version 1 is refused by the loader in the browser', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.appReady === true);
  await choosePackage(page, 'course-a-360p--old-format-v1');
  await expect(page.locator('#package-report.bad')).toContainText('FORMAT_VERSION_UNSUPPORTED');
});

test('missing manifest version is refused, not defaulted', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.appReady === true);
  await choosePackage(page, 'course-a-360p--drop-manifest-version');
  await expect(page.locator('#package-report.bad')).toContainText('MANIFEST_VERSION_MISSING');
});
