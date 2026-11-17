import { expect } from '@playwright/test';

export const ORIGIN = 'http://localhost:4101';

export async function openApp(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.appReady === true);
}

/** Sever the media origin and count every attempt to reach it. */
export async function cutOriginNetwork(context) {
  const counter = { count: 0, urls: [] };
  await context.route(`${ORIGIN}/**`, (route) => {
    counter.count += 1;
    counter.urls.push(route.request().url());
    return route.abort();
  });
  return counter;
}

/** Let traffic through but count requests per URL. */
export async function countOriginRequests(context) {
  const counter = { count: 0, byUrl: new Map() };
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = route.request().url();
    counter.count += 1;
    counter.byUrl.set(url, (counter.byUrl.get(url) ?? 0) + 1);
    return route.continue();
  });
  return counter;
}

/** Slow the origin down so installs can be interrupted mid-flight. */
export async function throttleOrigin(context, delayMs) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return route.continue();
  });
}

export async function installViaEngine(page, courseId, selection) {
  return page.evaluate(async ({ courseId, selection }) => {
    const manifest = await window.engine.fetchManifest(`media/${courseId}/manifest.json`);
    return window.engine.install(manifest, selection);
  }, { courseId, selection });
}

export async function getRecord(page, key) {
  return page.evaluate((k) => window.engine.getRecord(k), key);
}

export async function engineStats(page) {
  return page.evaluate(() => window.engine.stats());
}

export const SEL_A = { quality: '360p', audio: 'en', subs: ['en', 'zh'] };
export const KEY_A = 'course-a::360p::en::en+zh';
export const KEY_B = 'course-b::360p::en::en+zh';
// matches the UI default selection (first subtitle only)
export const SEL_BASE = { quality: '360p', audio: 'en', subs: ['en'] };
export const KEY_A_BASE = 'course-a::360p::en::en';
export const KEY_B_BASE = 'course-b::360p::en::en';

/** Assert real decoding: playback advances and frames are produced. */
export async function expectRealPlayback(page, seconds = 2.5) {
  const result = await page.evaluate(async (secs) => {
    const video = document.querySelector('#video');
    video.muted = true;
    await video.play();
    const start = { t: video.currentTime, f: video.getVideoPlaybackQuality().totalVideoFrames };
    await new Promise((r) => setTimeout(r, secs * 1000));
    return {
      elapsed: video.currentTime - start.t,
      frames: video.getVideoPlaybackQuality().totalVideoFrames - start.f,
      readyState: video.readyState,
      duration: video.duration,
      paused: video.paused,
    };
  }, seconds);
  expect(result.paused).toBe(false);
  expect(result.elapsed).toBeGreaterThan(1.2);
  expect(result.frames).toBeGreaterThan(20);
  expect(result.readyState).toBeGreaterThanOrEqual(2);
  return result;
}
