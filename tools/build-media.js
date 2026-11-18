// Generates the origin media library: real decodable fMP4 (VP9 + Opus),
// WebVTT text tracks, per-course manifests with content identity (sha256+size),
// and the course catalog. Output goes to origin-data/ (served by server/origin.js).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { splitFragments } from './mp4.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'origin-data');

const VIDEO_CODEC = 'video/mp4; codecs="vp09.00.10.08"';
const AUDIO_CODEC = 'audio/mp4; codecs="opus"';
const SEG_SECONDS = 2;
const INTRO_SECONDS = 2;
const BODY_SECONDS = 10;

const QUALITIES = {
  '360p': { w: 320, h: 180, dir: 'v360' },
  '720p': { w: 640, h: 360, dir: 'v720' },
};
const AUDIO_LANGS = ['en', 'zh'];
const SUB_LANGS = ['en', 'zh'];

const COURSES = [
  { id: 'course-a', title: '高空作业安全培训', hue: 0, freq: 440 },
  { id: 'course-b', title: '电气检修基础', hue: 90, freq: 520 },
  { id: 'course-c-broken', title: '吊装作业规程', hue: 150, freq: 600, defect: 'missing-segment' },
  { id: 'course-d-badhash', title: '有限空间作业', hue: 210, freq: 680, defect: 'bad-hash' },
  { id: 'course-e-noinit', title: '应急撤离演练', hue: 270, freq: 760, defect: 'missing-init' },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const write = (p, buf) => {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, buf);
};

function ffmpeg(args) {
  const out = args[args.length - 1];
  if (typeof out === 'string' && out.startsWith(OUT)) ensureDir(path.dirname(out));
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function encodeVideo({ w, h, seconds, hue, out }) {
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=25:duration=${seconds}`,
    '-vf', `hue=h=${hue}`,
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
    '-g', '50', '-keyint_min', '50',
    '-force_key_frames', `expr:gte(t,n_forced*${SEG_SECONDS})`,
    '-crf', '40', '-b:v', '0', '-row-mt', '1', '-an',
    '-video_track_timescale', '1000',
    '-f', 'mp4', '-movflags', 'empty_moov+frag_keyframe+default_base_moof+omit_tfhd_offset',
    out,
  ]);
}

function encodeAudio({ freq, seconds, out }) {
  ffmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`,
    '-c:a', 'libopus', '-b:a', '64k', '-vn',
    '-f', 'mp4', '-frag_duration', String(SEG_SECONDS * 1_000_000),
    '-movflags', 'empty_moov+default_base_moof+omit_tfhd_offset',
    out,
  ]);
}

function objectRef(relUrl, buf) {
  return { url: relUrl, sha256: sha256(buf), size: buf.length };
}

function writeObject(relUrl, buf) {
  write(path.join(OUT, relUrl), buf);
  return objectRef(relUrl, buf);
}

function vtt(course, lang) {
  const lines = {
    en: ['Safety briefing intro', `${course} — field rules`, 'End of module'],
    zh: ['安全须知简介', `${course} —— 现场作业规则`, '本模块结束'],
  }[lang];
  const cues = lines.map((text, i) => {
    const s = i * 4;
    const e = s + 4;
    const t = (v) => `00:00:${String(v).padStart(2, '0')}.000`;
    return `${t(s)} --> ${t(e)}\n${text}`;
  });
  return Buffer.from(`WEBVTT\n\n${cues.join('\n\n')}\n`, 'utf8');
}

console.log('building media library →', path.relative(ROOT, OUT));
// A rebuild replaces the origin library and every derived package built from
// it, so stale packages can never masquerade as current. Generated media is
// disposable; anything hand-authored belongs elsewhere.
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(path.join(ROOT, 'packages'), { recursive: true, force: true });
ensureDir(OUT);

// 1. Shared intro segments (identical bytes for every course → shared cache objects).
const introSegByQuality = {};
for (const [q, cfg] of Object.entries(QUALITIES)) {
  const tmp = path.join(OUT, '.tmp', `intro-${cfg.dir}.mp4`);
  encodeVideo({ w: cfg.w, h: cfg.h, seconds: INTRO_SECONDS, hue: 0, out: tmp });
  const { init, segments } = splitFragments(fs.readFileSync(tmp));
  if (segments.length !== 1) throw new Error(`intro ${q}: expected 1 segment, got ${segments.length}`);
  introSegByQuality[q] = { init, seg: segments[0] };
  console.log(`intro ${q}: init=${init.length}B seg=${segments[0].bytes.length}B dur=${segments[0].duration}s`);
}

const catalog = { generatedAt: new Date().toISOString(), courses: [] };

for (const course of COURSES) {
  const mediaBase = `media/${course.id}`;
  const manifest = {
    courseId: course.id,
    version: 1,
    title: course.title,
    video: {},
    audio: {},
    subtitles: {},
  };

  for (const [q, cfg] of Object.entries(QUALITIES)) {
    const tmp = path.join(OUT, '.tmp', `${course.id}-${cfg.dir}.mp4`);
    encodeVideo({ w: cfg.w, h: cfg.h, seconds: BODY_SECONDS, hue: course.hue, out: tmp });
    const { init, segments } = splitFragments(fs.readFileSync(tmp));
    if (segments.length !== BODY_SECONDS / SEG_SECONDS) {
      throw new Error(`${course.id} ${q}: expected ${BODY_SECONDS / SEG_SECONDS} segments, got ${segments.length}`);
    }
    // Init segment must be byte-identical to the shared intro's init, otherwise
    // the intro media segment cannot be appended under this init.
    if (sha256(init) !== sha256(introSegByQuality[q].init)) {
      throw new Error(`${course.id} ${q}: init mismatch with shared intro`);
    }
    const initRef = writeObject(`${mediaBase}/${cfg.dir}-init.mp4`, init);
    const introRef = writeObject(`media/shared/intro-${cfg.dir}-seg0.m4s`, introSegByQuality[q].seg.bytes);
    const segRefs = [introRef];
    const durations = [introSegByQuality[q].seg.duration];
    segments.forEach((seg, i) => {
      segRefs.push(writeObject(`${mediaBase}/${cfg.dir}-seg${i + 1}.m4s`, seg.bytes));
      durations.push(seg.duration);
    });
    manifest.video[q] = {
      codec: VIDEO_CODEC,
      width: cfg.w,
      height: cfg.h,
      init: initRef,
      segments: segRefs.map((ref, i) => ({ ...ref, duration: durations[i] })),
    };
  }

  for (const lang of AUDIO_LANGS) {
    const freq = course.freq + (lang === 'zh' ? 110 : 0);
    const tmp = path.join(OUT, '.tmp', `${course.id}-a-${lang}.mp4`);
    encodeAudio({ freq, seconds: INTRO_SECONDS + BODY_SECONDS, out: tmp });
    const { init, segments } = splitFragments(fs.readFileSync(tmp));
    const initRef = writeObject(`${mediaBase}/a-${lang}-init.mp4`, init);
    manifest.audio[lang] = {
      codec: AUDIO_CODEC,
      language: lang,
      init: initRef,
      segments: segments.map((seg, i) => ({
        ...writeObject(`${mediaBase}/a-${lang}-seg${i}.m4s`, seg.bytes),
        duration: seg.duration,
      })),
    };
  }

  for (const lang of SUB_LANGS) {
    manifest.subtitles[lang] = {
      language: lang,
      label: lang === 'en' ? 'English' : '中文',
      ...writeObject(`${mediaBase}/subs-${lang}.vtt`, vtt(course.title, lang)),
    };
  }

  // Inject deterministic defects so failure handling can be tested end to end.
  if (course.defect === 'missing-segment') {
    manifest.video['360p'].segments[2] = {
      ...manifest.video['360p'].segments[2],
      url: `${mediaBase}/v360-seg2.m4s.absent`,
    };
  } else if (course.defect === 'bad-hash') {
    manifest.video['360p'].segments[2] = {
      ...manifest.video['360p'].segments[2],
      sha256: '0'.repeat(64),
    };
  } else if (course.defect === 'missing-init') {
    manifest.video['360p'].init = {
      ...manifest.video['360p'].init,
      url: `${mediaBase}/v360-init.mp4.absent`,
    };
  }

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  write(path.join(OUT, mediaBase, 'manifest.json'), manifestBuf);
  catalog.courses.push({
    courseId: course.id,
    title: course.title,
    manifestUrl: `${mediaBase}/manifest.json`,
    defect: course.defect ?? null,
  });
  console.log(`${course.id}: manifest written (${manifestBuf.length}B)`);
}

fs.rmSync(path.join(OUT, '.tmp'), { recursive: true, force: true });
write(path.join(OUT, 'catalog.json'), Buffer.from(JSON.stringify(catalog, null, 2)));

const totalBytes = fs.readdirSync(OUT, { recursive: true })
  .filter((f) => !String(f).endsWith('.json'))
  .reduce((acc, f) => acc + fs.statSync(path.join(OUT, String(f))).size, 0);
console.log(`done. media bytes: ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);
