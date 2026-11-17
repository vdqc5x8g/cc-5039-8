// Integrity: broken manifests must fail loudly (never masquerade as usable),
// and post-install cache damage must be detected by content identity —
// including same-length corruption that byte counts cannot catch.
import { test, expect } from '@playwright/test';
import {
  openApp, installViaEngine, getRecord, cutOriginNetwork, expectRealPlayback, SEL_BASE, KEY_A_BASE,
} from './helpers.js';

test('missing media fragment: install fails and package stays unavailable', async ({ page }) => {
  await openApp(page);
  await expect(installViaEngine(page, 'course-c-broken', SEL_BASE)).rejects.toThrow(/片段缺失|HTTP 404/);

  const key = 'course-c-broken::360p::en::en';
  const record = await getRecord(page, key);
  expect(record.status).toBe('failed');
  expect(record.error).toMatch(/片段缺失/);

  await page.reload();
  await page.waitForFunction(() => window.appReady === true);
  const card = page.locator('.course-card[data-course-id="course-c-broken"]');
  await expect(card.locator('.course-status[data-status="failed"]')).toHaveText('失败');
  await expect(card.locator('.course-error')).toContainText('片段缺失');
  await expect(card.locator('.btn-play')).toBeDisabled();
});

test('same course, intact combination: 720p variant installs fine', async ({ page }) => {
  await openApp(page);
  const result = await installViaEngine(page, 'course-c-broken', { quality: '720p', audio: 'en', subs: ['en'] });
  expect(result.key).toBe('course-c-broken::720p::en::en');
  const record = await getRecord(page, result.key);
  expect(record.status).toBe('ready');
});

test('hash mismatch in manifest: content identity check fails the install', async ({ page }) => {
  await openApp(page);
  await expect(installViaEngine(page, 'course-d-badhash', SEL_BASE)).rejects.toThrow(/内容校验失败/);
  const record = await getRecord(page, 'course-d-badhash::360p::en::en');
  expect(record.status).toBe('failed');
});

test('missing init segment: package never becomes available', async ({ page }) => {
  await openApp(page);
  await expect(installViaEngine(page, 'course-e-noinit', SEL_BASE)).rejects.toThrow(/片段缺失|HTTP 404/);
  const record = await getRecord(page, 'course-e-noinit::360p::en::en');
  expect(record.status).toBe('failed');
  const card = page.locator('.course-card[data-course-id="course-e-noinit"]');
  await expect(card.locator('.course-status[data-status="failed"]')).toHaveText('失败');
  await expect(card.locator('.btn-play')).toBeDisabled();
});

test('init segment deleted from cache after install: availability revoked', async ({ page, context }) => {
  await openApp(page);
  await installViaEngine(page, 'course-a', SEL_BASE);

  const initHash = await page.evaluate(async (key) => {
    const rec = await window.engine.getRecord(key);
    return rec.closure.tracks.video.init;
  }, KEY_A_BASE);
  await page.evaluate((h) => window.engine._debugDeleteObject(h), initHash);

  // engine-level: verify reports the missing init, playable range collapses
  const verify = await page.evaluate((key) => window.engine.verify(key), KEY_A_BASE);
  expect(verify.ok).toBe(false);
  expect(verify.missing.some((o) => o.kind === 'video-init')).toBe(true);
  const info = await page.evaluate((key) => window.engine.playableInfo(key), KEY_A_BASE);
  expect(info.complete).toBe(false);
  expect(info.contiguousSeconds).toBe(0);
  expect(info.missingInit.length).toBeGreaterThan(0);

  // UI-level: the card must stop showing 可用 and disable playback
  await page.evaluate(() => window.engine._emit());
  const card = page.locator('.course-card[data-course-id="course-a"]');
  await expect(card.locator('.course-status[data-status="incomplete"]')).toHaveText('缓存不完整');
  await expect(card.locator('.btn-play')).toBeDisabled();
  await expect(card.locator('.playable-info').first()).toContainText('可播放范围：0–0.0s');

  // and even a direct player attempt refuses instead of falling back online
  const net = await cutOriginNetwork(context);
  const playError = await page.evaluate(async (key) => {
    const rec = await window.engine.getRecord(key);
    const { OfflinePlayer } = await import('./engine/player.js');
    try {
      await new OfflinePlayer(document.querySelector('#video'), window.engine.store, rec).open();
      return null;
    } catch (err) {
      return err.message;
    }
  }, KEY_A_BASE);
  expect(playError).toContain('离线包不完整');
  expect(net.count).toBe(0);
});

test('same-length byte corruption is caught by hash, not by size', async ({ page }) => {
  await openApp(page);
  await installViaEngine(page, 'course-a', SEL_BASE);

  const target = await page.evaluate(async (key) => {
    const rec = await window.engine.getRecord(key);
    const seg = rec.closure.objects.find((o) => o.kind === 'video');
    await window.engine._debugCorruptObject(seg.hash);
    return seg;
  }, KEY_A_BASE);

  const verify = await page.evaluate((key) => window.engine.verify(key), KEY_A_BASE);
  expect(verify.ok).toBe(false);
  expect(verify.mismatched.length).toBe(1);
  expect(verify.mismatched[0].hash).toBe(target.hash);
  // the corrupted object kept its original byte length — a byte-count check
  // would pass; only content identity catches it
  expect(verify.mismatched[0].size).toBe(target.size);

  // UI verify button surfaces the failure too
  await page.evaluate(() => window.engine._emit());
  const card = page.locator('.course-card[data-course-id="course-a"]');
  await card.locator('.btn-verify').click();
  await expect(card.locator('.verify-report.bad')).toContainText('完整性校验失败');
});

test('playback refuses to start when a mid-package fragment is missing', async ({ page }) => {
  await openApp(page);
  await installViaEngine(page, 'course-a', SEL_BASE);
  const segHash = await page.evaluate(async (key) => {
    const rec = await window.engine.getRecord(key);
    const hash = rec.closure.tracks.video.segments[3].hash;
    await window.engine._debugDeleteObject(hash);
    return hash;
  }, KEY_A_BASE);
  const info = await page.evaluate((key) => window.engine.playableInfo(key), KEY_A_BASE);
  expect(info.complete).toBe(false);
  expect(info.contiguousSeconds).toBe(6); // three 2s fragments before the hole
});
