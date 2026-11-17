// Pure manifest/selection logic. No DOM, no IDB — unit-testable in Node.

export class SelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelectionError';
  }
}

export function courseKey(courseId, selection) {
  const subs = [...selection.subs].sort().join('+') || 'nosub';
  return `${courseId}::${selection.quality}::${selection.audio}::${subs}`;
}

/**
 * Dependency closure of a (manifest, selection) pair: every init segment,
 * media fragment and text track the combination needs, deduplicated by
 * content hash so shared objects appear exactly once.
 */
export function computeClosure(manifest, selection) {
  const video = manifest.video?.[selection.quality];
  if (!video) throw new SelectionError(`课程没有清晰度 ${selection.quality}`);
  const audio = manifest.audio?.[selection.audio];
  if (!audio) throw new SelectionError(`课程没有音频语言 ${selection.audio}`);

  const objects = [];
  const seen = new Set();
  const push = (ref, kind, trackId, label, duration = null) => {
    if (seen.has(ref.sha256)) return;
    seen.add(ref.sha256);
    objects.push({
      hash: ref.sha256, url: ref.url, size: ref.size,
      kind, trackId, label, duration,
    });
  };

  const vTrack = `video:${selection.quality}`;
  push(video.init, 'video-init', vTrack, `视频初始化段(${selection.quality})`);
  video.segments.forEach((s, i) => push(s, 'video', vTrack, `视频片段 ${i}(${selection.quality})`, s.duration));

  const aTrack = `audio:${selection.audio}`;
  push(audio.init, 'audio-init', aTrack, `音频初始化段(${selection.audio})`);
  audio.segments.forEach((s, i) => push(s, 'audio', aTrack, `音频片段 ${i}(${selection.audio})`, s.duration));

  const subtitles = [];
  for (const lang of selection.subs) {
    const t = manifest.subtitles?.[lang];
    if (!t) throw new SelectionError(`课程没有字幕语言 ${lang}`);
    push(t, 'subtitle', `sub:${lang}`, `字幕 ${t.label ?? lang}`);
    subtitles.push({ language: lang, label: t.label ?? lang, hash: t.sha256 });
  }

  return {
    objects,
    totalBytes: objects.reduce((n, o) => n + o.size, 0),
    duration: video.segments.reduce((n, s) => n + (s.duration ?? 0), 0),
    tracks: {
      video: {
        quality: selection.quality, codec: video.codec,
        width: video.width, height: video.height,
        init: video.init.sha256,
        segments: video.segments.map((s) => ({ hash: s.sha256, duration: s.duration })),
      },
      audio: {
        language: selection.audio, codec: audio.codec,
        init: audio.init.sha256,
        segments: audio.segments.map((s) => ({ hash: s.sha256, duration: s.duration })),
      },
      subtitles,
    },
  };
}

/**
 * What can actually be played right now, given a presence predicate over
 * content hashes. A package is only complete when the closure is fully
 * present — never inferred from byte counts alone.
 */
export function playableFromPresence(closure, has) {
  const missing = closure.objects.filter((o) => !has(o.hash));
  const missingInit = missing.filter((o) => o.kind === 'video-init' || o.kind === 'audio-init');

  // Contiguous coverage from t=0: playback stalls at the first absent fragment.
  let contiguousSeconds = 0;
  if (has(closure.tracks.video.init) && has(closure.tracks.audio.init)) {
    const vSegs = closure.tracks.video.segments;
    const aSegs = closure.tracks.audio.segments;
    for (let i = 0; i < vSegs.length; i++) {
      const v = vSegs[i];
      const a = aSegs[Math.min(i, aSegs.length - 1)];
      if (!has(v.hash) || (a && !has(a.hash))) break;
      contiguousSeconds += v.duration ?? 0;
    }
  }

  return {
    complete: missing.length === 0,
    totalSeconds: closure.duration,
    contiguousSeconds,
    missing,
    missingInit,
    missingSubtitles: closure.tracks.subtitles.filter((s) => !has(s.hash)),
  };
}
