// OfflinePlayer: feeds a <video> element exclusively from the content-
// addressed cache via MSE. There is intentionally no network code path here:
// every byte comes from MediaStore, and the dependency closure is re-verified
// before anything is appended — a package with a missing init segment or a
// hash mismatch refuses to play instead of silently falling back online.
import { sha256Hex } from './hash.js';

function once(target, event) {
  return new Promise((resolve, reject) => {
    const on = () => {
      target.removeEventListener(event, on);
      resolve();
    };
    target.addEventListener(event, on);
  });
}

function appendAndWait(sourceBuffer, bytes) {
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error('SourceBuffer append failed'));
    };
    const cleanup = () => {
      sourceBuffer.removeEventListener('updateend', onEnd);
      sourceBuffer.removeEventListener('error', onErr);
    };
    sourceBuffer.addEventListener('updateend', onEnd);
    sourceBuffer.addEventListener('error', onErr);
    sourceBuffer.appendBuffer(bytes);
  });
}

export class OfflinePlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {import('./store.js').MediaStore} store
   * @param {object} record  course record with closure snapshot
   */
  constructor(video, store, record) {
    this.video = video;
    this.store = store;
    this.record = record;
    this._blobUrls = [];
    this._objectUrl = null;
  }

  async _verifiedBytes(hash) {
    const obj = await this.store.getObject(hash);
    if (!obj) throw new Error(`缓存缺少对象 ${hash.slice(0, 12)}…`);
    if ((await sha256Hex(obj.bytes)) !== hash) {
      throw new Error(`缓存对象内容校验失败 ${hash.slice(0, 12)}…`);
    }
    return obj.bytes;
  }

  async open() {
    const tracks = this.record.closure.tracks;

    // Dependency-closure gate: every object, init segments included, must be
    // present and authentic before playback starts.
    const missing = [];
    for (const o of this.record.closure.objects) {
      if (!(await this.store.hasObject(o.hash))) missing.push(o.label);
    }
    if (missing.length > 0) {
      const err = new Error(`离线包不完整，无法播放。缺少：${missing.join('、')}`);
      err.missing = missing;
      throw err;
    }

    this.mediaSource = new MediaSource();
    this._objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this._objectUrl;
    await once(this.mediaSource, 'sourceopen');

    const vbuf = this.mediaSource.addSourceBuffer(tracks.video.codec);
    vbuf.mode = 'sequence';
    const abuf = this.mediaSource.addSourceBuffer(tracks.audio.codec);
    abuf.mode = 'sequence';

    await appendAndWait(vbuf, await this._verifiedBytes(tracks.video.init));
    await appendAndWait(abuf, await this._verifiedBytes(tracks.audio.init));

    const vSegs = tracks.video.segments;
    const aSegs = tracks.audio.segments;
    for (let i = 0; i < Math.max(vSegs.length, aSegs.length); i++) {
      if (vSegs[i]) await appendAndWait(vbuf, await this._verifiedBytes(vSegs[i].hash));
      if (aSegs[i]) await appendAndWait(abuf, await this._verifiedBytes(aSegs[i].hash));
    }

    this.mediaSource.duration = this.record.closure.duration;
    this.mediaSource.endOfStream();

    for (const sub of tracks.subtitles) {
      const bytes = await this._verifiedBytes(sub.hash);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'text/vtt' }));
      const el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = sub.label;
      el.srclang = sub.language;
      el.src = url;
      this.video.appendChild(el);
      this._blobUrls.push(url);
    }
    // A track only fetches its resource once its mode leaves 'disabled'.
    const trackEls = [...this.video.querySelectorAll('track')];
    trackEls.forEach((el, i) => {
      el.track.mode = i === 0 ? 'showing' : 'hidden';
    });
    return this;
  }

  textTracks() {
    return [...this.video.querySelectorAll('track')].map((el, i) => ({
      index: i,
      language: el.srclang,
      label: el.label,
      track: el.track,
    }));
  }

  showSubtitle(language) {
    for (const t of this.video.textTracks) {
      t.mode = t.language === language ? 'showing' : 'hidden';
    }
  }

  async destroy() {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    for (const el of this.video.querySelectorAll('track')) el.remove();
    for (const url of this._blobUrls) URL.revokeObjectURL(url);
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._blobUrls = [];
    this._objectUrl = null;
  }
}

/**
 * Counts network requests the page makes while offline playback is supposed
 * to be cache-only. The player itself never fetches; this makes that visible.
 */
export function installNetworkMonitor(originBase) {
  const state = {
    count: 0,
    requests: [],
    reset() {
      this.count = 0;
      this.requests = [];
    },
  };
  const origin = new URL(originBase).host;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    const url = String(args[0]?.url ?? args[0]);
    if (new URL(url, location.href).host === origin) {
      state.count += 1;
      state.requests.push(url);
    }
    return originalFetch(...args);
  };
  return state;
}
