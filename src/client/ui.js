import { OfflineEngine } from './engine/engine.js';
import { OfflinePlayer, installNetworkMonitor } from './engine/player.js';
import { courseKey } from './engine/closure.js';

const ORIGIN = window.OFFLINE_ORIGIN;
const engine = await OfflineEngine.open({ originBase: ORIGIN });
const netMon = installNetworkMonitor(ORIGIN);

const $ = (sel) => document.querySelector(sel);
const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
const fmtSecs = (s) => `${s.toFixed(1)}s`;

const state = {
  catalog: null,          // null when the origin is unreachable (offline)
  manifests: new Map(),   // courseId → manifest
  records: new Map(),     // courseKey → record
  selections: new Map(),  // courseId → {quality, audio, subs}
  player: null,
  playerTimer: null,
};

window.engine = engine;   // e2e/debug hooks
window.netMon = netMon;
window.appState = state;

// ---------- rendering ----------

function renderNetStatus() {
  const el = $('#net-status');
  const online = navigator.onLine;
  el.textContent = online ? '在线' : '离线';
  el.className = `badge ${online ? 'online' : 'offline'}`;
}

async function renderStorage() {
  const stats = await engine.stats();
  let quotaText = '';
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota != null) quotaText = ` / 配额 ${fmtBytes(quota)}（已用 ${fmtBytes(usage ?? 0)}）`;
  } catch { /* estimate unsupported */ }
  $('#storage-usage').textContent =
    `缓存对象 ${stats.objectCount} 个 · ${fmtBytes(stats.objectBytes)}${quotaText}`;
}

function currentSelection(courseId, manifest) {
  if (!state.selections.has(courseId)) {
    state.selections.set(courseId, {
      quality: Object.keys(manifest.video)[0],
      audio: Object.keys(manifest.audio)[0],
      subs: Object.keys(manifest.subtitles).slice(0, 1),
    });
  }
  return state.selections.get(courseId);
}

function statusBadge(record, cacheComplete) {
  if (!record) return '<span class="course-status">未下载</span>';
  if (record.status === 'ready' && cacheComplete === false) {
    return '<span class="course-status failed" data-status="incomplete">缓存不完整</span>';
  }
  const map = {
    ready: ['ready', '可用'],
    installing: ['installing', '下载中'],
    failed: ['failed', '失败'],
  };
  const [cls, text] = map[record.status] ?? ['', record.status];
  return `<span class="course-status ${cls}" data-status="${record.status}">${text}</span>`;
}

// A 'ready' record only means the commit happened; availability is decided by
// what the cache actually contains right now.
async function cacheComplete(record) {
  if (!record || record.status !== 'ready') return null;
  const info = await engine.playableInfo(record.key);
  return info.complete;
}

function missingTracksText(manifest, selection) {
  const missing = [];
  for (const lang of Object.keys(manifest.audio)) {
    if (lang !== selection.audio) missing.push(`音频 ${lang}`);
  }
  for (const lang of Object.keys(manifest.subtitles)) {
    if (!selection.subs.includes(lang)) missing.push(`字幕 ${lang}`);
  }
  return missing.length ? `未包含轨道：${missing.join('、')}` : '已包含全部轨道';
}

async function playableInfoHtml(record) {
  if (!record) return '';
  const info = await engine.playableInfo(record.key);
  const parts = [
    `可播放范围：0–${fmtSecs(info.contiguousSeconds)} / 共 ${fmtSecs(info.totalSeconds)}`,
  ];
  if (info.missing.length > 0) {
    const labels = info.missing.slice(0, 4).map((o) => o.label).join('、');
    parts.push(`<span class="missing">缺失 ${info.missing.length} 个对象（${labels}${info.missing.length > 4 ? '…' : ''}）</span>`);
  }
  if (info.missingSubtitles.length > 0) {
    parts.push(`<span class="missing">字幕轨未就绪：${info.missingSubtitles.map((s) => s.label).join('、')}</span>`);
  }
  return parts.join('<br>');
}

async function courseCardHtml(course, manifest) {
  const sel = currentSelection(course.courseId, manifest);
  const key = courseKey(course.courseId, sel);
  const record = state.records.get(key);
  const complete = await cacheComplete(record);
  const playable = record?.status === 'ready' && complete !== false;
  const progress = record
    ? `<progress value="${record.bytesDone}" max="${record.bytesTotal}"></progress>
       <div class="progress-text">${record.closure.objects.filter((o) => o.done).length}/${record.closure.objects.length} 对象 · ${fmtBytes(record.bytesDone)} / ${fmtBytes(record.bytesTotal)}</div>`
    : '';
  const error = record?.error ? `<div class="course-error">${record.error}</div>` : '';
  return `
  <div class="course-card" data-course-id="${course.courseId}">
    <div class="course-head">
      <span class="course-title">${manifest.title}</span>
      ${statusBadge(record, complete)}
    </div>
    ${error}
    <div class="combo-row">
      <label>清晰度
        <select class="sel-quality">
          ${Object.keys(manifest.video).map((q) => `<option value="${q}" ${q === sel.quality ? 'selected' : ''}>${q}</option>`).join('')}
        </select>
      </label>
      <label>音频
        <select class="sel-audio">
          ${Object.keys(manifest.audio).map((l) => `<option value="${l}" ${l === sel.audio ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <span class="subs-checks">字幕
        ${Object.entries(manifest.subtitles).map(([l, t]) => `
          <label><input type="checkbox" class="chk-sub" value="${l}" ${sel.subs.includes(l) ? 'checked' : ''}>${t.label ?? l}</label>`).join('')}
      </span>
    </div>
    <div class="actions">
      <button class="btn-install">下载离线包</button>
      <button class="btn-resume secondary" ${record && record.status !== 'ready' ? '' : 'hidden'}>继续下载</button>
      <button class="btn-play" ${playable ? '' : 'disabled'}>播放</button>
      <button class="btn-verify secondary" ${record ? '' : 'disabled'}>验证完整性</button>
      <button class="btn-remove danger" ${record ? '' : 'disabled'}>删除</button>
    </div>
    ${progress}
    <div class="playable-info">${await playableInfoHtml(record)}</div>
    <div class="playable-info muted">${missingTracksText(manifest, sel)}</div>
    <div class="verify-report"></div>
  </div>`;
}

async function recordCardHtml(record) {
  // Offline view: manifest unavailable, render straight from the registry.
  const sel = record.selection;
  const complete = await cacheComplete(record);
  const playable = record.status === 'ready' && complete !== false;
  const error = record.error ? `<div class="course-error">${record.error}</div>` : '';
  return `
  <div class="course-card" data-course-id="${record.courseId}" data-record-key="${record.key}">
    <div class="course-head">
      <span class="course-title">${record.title}</span>
      ${statusBadge(record, complete)}
    </div>
    ${error}
    <div class="combo-row">组合：${sel.quality} · 音频 ${sel.audio} · 字幕 ${sel.subs.join('+') || '无'}</div>
    <div class="actions">
      <button class="btn-resume secondary" ${record.status === 'ready' ? 'hidden' : ''}>继续下载</button>
      <button class="btn-play" ${playable ? '' : 'disabled'}>播放</button>
      <button class="btn-verify secondary">验证完整性</button>
      <button class="btn-remove danger">删除</button>
    </div>
    <div class="playable-info">${await playableInfoHtml(record)}</div>
    <div class="verify-report"></div>
  </div>`;
}

async function renderCourses() {
  const list = $('#course-list');
  const known = new Set();
  let html = '';
  if (state.catalog) {
    for (const course of state.catalog.courses) {
      const manifest = state.manifests.get(course.courseId);
      if (!manifest) continue;
      known.add(course.courseId);
      html += await courseCardHtml(course, manifest);
    }
  }
  // Records without a catalog entry (or everything, when offline).
  for (const record of state.records.values()) {
    if (state.catalog && known.has(record.courseId)) continue;
    html += await recordCardHtml(record);
  }
  list.innerHTML = html || '<div>暂无课程。</div>';
  bindCards(list);
}

function bindCards(list) {
  for (const card of list.querySelectorAll('.course-card')) {
    const courseId = card.dataset.courseId;
    const manifest = state.manifests.get(courseId);

    const readSelection = () => ({
      quality: card.querySelector('.sel-quality')?.value,
      audio: card.querySelector('.sel-audio')?.value,
      subs: [...card.querySelectorAll('.chk-sub')].filter((c) => c.checked).map((c) => c.value),
    });
    const keyForCard = () => (manifest
      ? courseKey(courseId, readSelection())
      : card.dataset.recordKey);

    for (const sel of card.querySelectorAll('.sel-quality, .sel-audio, .chk-sub')) {
      sel.addEventListener('change', () => {
        state.selections.set(courseId, readSelection());
        renderCourses();
      });
    }

    card.querySelector('.btn-install')?.addEventListener('click', async () => {
      const selection = readSelection();
      state.selections.set(courseId, selection);
      try {
        await engine.install(manifest, selection, { onProgress: updateProgress(courseId) });
      } catch { /* failure is rendered from the record */ }
      await refresh();
    });

    card.querySelector('.btn-resume')?.addEventListener('click', async () => {
      try {
        await engine.resume(keyForCard(), { onProgress: updateProgress(courseId) });
      } catch { /* rendered from record */ }
      await refresh();
    });

    card.querySelector('.btn-play')?.addEventListener('click', () => playCourse(keyForCard()));

    card.querySelector('.btn-verify')?.addEventListener('click', async () => {
      const reportEl = card.querySelector('.verify-report');
      reportEl.textContent = '校验中…';
      const report = await engine.verify(keyForCard());
      if (report.ok) {
        const total = (await engine.getRecord(keyForCard())).closure.objects.length;
        reportEl.className = 'verify-report ok';
        reportEl.textContent = `完整性校验通过：${total} 个对象 SHA-256 全部一致`;
      } else {
        reportEl.className = 'verify-report bad';
        const bits = [];
        if (report.missing.length) bits.push(`缺失 ${report.missing.length} 个（${report.missing[0].label} 等）`);
        if (report.mismatched.length) bits.push(`内容不符 ${report.mismatched.length} 个（${report.mismatched[0].label} 等）`);
        reportEl.textContent = `完整性校验失败：${bits.join('；')}`;
      }
    });

    card.querySelector('.btn-remove')?.addEventListener('click', async () => {
      await engine.remove(keyForCard());
      await refresh();
    });
  }
}

function updateProgress(courseId) {
  // Re-query the live card on every tick: engine change events re-render the
  // list, and a stale element reference would silently stop updating.
  return ({ objectsDone, objectsTotal, bytesDone, bytesTotal }) => {
    const card = document.querySelector(`.course-card[data-course-id="${courseId}"]`);
    const bar = card?.querySelector('progress');
    const text = card?.querySelector('.progress-text');
    if (bar) {
      bar.max = bytesTotal;
      bar.value = bytesDone;
    }
    if (text) text.textContent = `${objectsDone}/${objectsTotal} 对象 · ${fmtBytes(bytesDone)} / ${fmtBytes(bytesTotal)}`;
  };
}

// ---------- player ----------

async function playCourse(key) {
  const record = await engine.getRecord(key);
  if (!record) return;
  await closePlayer();

  $('#player-empty').hidden = true;
  $('#player-active').hidden = false;
  const meta = $('#player-meta');
  meta.textContent = '正在从本地缓存装配…';

  try {
    netMon.reset();
    const player = await new OfflinePlayer($('#video'), engine.store, record).open();
    state.player = player;
    const sel = record.selection;
    const stats = await engine.stats();
    meta.innerHTML =
      `课程：${record.title} · 组合：${sel.quality} / 音频 ${sel.audio} / 字幕 ${sel.subs.join('+') || '无'}<br>` +
      `可播放范围：0–${fmtSecs(record.closure.duration)} · 数据来源：本地缓存（对象 ${record.closure.objects.length} 个，库内共 ${stats.objectCount} 个）`;

    const switcher = $('#subtitle-switch');
    switcher.innerHTML = '';
    for (const { language, label } of player.textTracks()) {
      const btn = document.createElement('button');
      btn.textContent = `字幕：${label}`;
      btn.className = 'secondary';
      btn.dataset.subLang = language;
      btn.addEventListener('click', () => player.showSubtitle(language));
      switcher.appendChild(btn);
    }
    const off = document.createElement('button');
    off.textContent = '关闭字幕';
    off.className = 'secondary';
    off.addEventListener('click', () => player.showSubtitle('__none__'));
    switcher.appendChild(off);

    state.playerTimer = setInterval(() => {
      $('#play-net-count').textContent = `播放期网络请求：${netMon.count}`;
    }, 300);
  } catch (err) {
    meta.textContent = `无法播放：${err.message}`;
    $('#player-active').hidden = false;
  }
}

async function closePlayer() {
  if (state.player) {
    await state.player.destroy();
    state.player = null;
  }
  if (state.playerTimer) clearInterval(state.playerTimer);
  state.playerTimer = null;
  $('#player-active').hidden = true;
  $('#player-empty').hidden = false;
}

$('#btn-close-player').addEventListener('click', closePlayer);

// ---------- bootstrap ----------

async function refresh() {
  const records = await engine.list();
  state.records = new Map(records.map((r) => [r.key, r]));
  await renderStorage();
  await renderCourses();
}

async function loadCatalog() {
  try {
    state.catalog = await engine.fetchCatalog();
    const manifests = await Promise.all(
      state.catalog.courses.map((c) => engine.fetchManifest(c.manifestUrl)),
    );
    for (const m of manifests) state.manifests.set(m.courseId, m);
    $('#catalog-note').textContent = '';
  } catch (err) {
    state.catalog = null;
    $('#catalog-note').textContent = `无法连接课程服务器（${err.message}）。仅显示本机已下载内容。`;
  }
}

window.addEventListener('online', renderNetStatus);
window.addEventListener('offline', renderNetStatus);
engine.onChange(() => refresh());

renderNetStatus();
await loadCatalog();
await refresh();
window.appReady = true;
