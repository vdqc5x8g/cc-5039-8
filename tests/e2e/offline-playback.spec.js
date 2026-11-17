// Golden path: pick a course + quality + languages, download, sever the
// network, and play for real from the cache — with zero network requests.
import { test, expect } from '@playwright/test';
import {
  openApp, cutOriginNetwork, expectRealPlayback, KEY_A,
} from './helpers.js';

test('install via UI, then play offline with real decoding and text tracks', async ({ page, context }) => {
  await openApp(page);

  // --- online: choose combination and install through the UI ---
  const card = page.locator('.course-card[data-course-id="course-a"]');
  await card.locator('.sel-quality').selectOption('360p');
  await card.locator('.sel-audio').selectOption('en');
  await card.locator('.chk-sub[value="en"]').check();
  await card.locator('.chk-sub[value="zh"]').check();
  await card.locator('.btn-install').click();
  await expect(card.locator('.course-status[data-status="ready"]')).toHaveText('可用', { timeout: 60_000 });

  // playable range + track info are shown for the ready package; the zh audio
  // track was not part of the selection and is reported as not fetched
  await expect(card.locator('.playable-info').first()).toContainText('可播放范围：0–12.0s / 共 12.0s');
  await expect(card.locator('.playable-info.muted')).toContainText('未包含轨道：音频 zh');

  // integrity check button: every object re-hashed against the manifest
  await card.locator('.btn-verify').click();
  await expect(card.locator('.verify-report.ok')).toContainText('完整性校验通过');

  // --- sever the media origin; anything trying to reach it gets counted ---
  const net = await cutOriginNetwork(context);

  // reload: app shell is local, catalog/manifests are not — offline view must
  // still offer the installed course from the registry.
  await page.reload();
  await page.waitForFunction(() => window.appReady === true);
  await expect(page.locator('#catalog-note')).toContainText('无法连接课程服务器');
  const offlineCard = page.locator('.course-card[data-course-id="course-a"]');
  await expect(offlineCard.locator('.course-status[data-status="ready"]')).toHaveText('可用');

  // the only origin traffic in the offline session was the (gracefully
  // failed) catalog refresh — no media object was ever requested
  const mediaAttempts = net.urls.filter((u) => u.includes('/media/'));
  expect(mediaAttempts).toEqual([]);
  expect(net.urls.some((u) => u.endsWith('/catalog.json'))).toBe(true);

  // and from the moment playback starts, zero network requests of any kind
  net.count = 0;
  net.urls = [];
  await offlineCard.locator('.btn-play').click();
  await expect(page.locator('#player-meta')).toContainText('数据来源：本地缓存');
  await expect(page.locator('#player-meta')).toContainText('可播放范围：0–12.0s');

  const playback = await expectRealPlayback(page, 2.5);
  expect(playback.duration).toBeGreaterThan(11.5);
  expect(playback.duration).toBeLessThan(12.5);

  // text tracks came from cached VTT: two tracks, cues load asynchronously
  await expect.poll(async () => page.evaluate(() => {
    const v = document.querySelector('#video');
    return [...v.textTracks].map((t) => t.cues?.length ?? 0);
  })).toEqual([expect.any(Number), expect.any(Number)]);
  await expect.poll(async () => page.evaluate(() => {
    const v = document.querySelector('#video');
    return Math.min(...[...v.textTracks].map((t) => t.cues?.length ?? 0));
  })).toBeGreaterThan(0);
  const trackLangs = await page.evaluate(() => {
    const v = document.querySelector('#video');
    return [...v.textTracks].map((t) => t.language).sort();
  });
  expect(trackLangs).toEqual(['en', 'zh']);

  await page.click('#subtitle-switch button[data-sub-lang="zh"]');
  const activeCue = await page.evaluate(async () => {
    const v = document.querySelector('#video');
    v.currentTime = 1;
    await new Promise((r) => setTimeout(r, 300));
    const showing = [...v.textTracks].find((t) => t.mode === 'showing');
    return { language: showing?.language, text: showing?.activeCues?.[0]?.text ?? '' };
  });
  expect(activeCue.language).toBe('zh');
  expect(activeCue.text).toContain('安全须知');

  // the offline session made zero network requests to the origin
  expect(net.count).toBe(0);
  const inPageCount = await page.evaluate(() => window.netMon.count);
  expect(inPageCount).toBe(0);
  await expect(page.locator('#play-net-count')).toContainText('播放期网络请求：0');
});

test('uninstalled course offers no playback and no fake availability', async ({ page }) => {
  await openApp(page);
  const card = page.locator('.course-card[data-course-id="course-b"]');
  await expect(card.locator('.course-status')).toHaveText('未下载');
  await expect(card.locator('.btn-play')).toBeDisabled();
});
