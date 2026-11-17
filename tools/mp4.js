// Minimal MP4 (ISO BMFF) box walker + fMP4 splitter.
// Only handles what the media pipeline needs: top-level split into
// init (ftyp+moov) and media fragments (moof..mdat), plus timing extraction.

const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta',
  'moof', 'traf', 'mvex', 'mfra', 'dinf', 'schi', 'sinf',
]);

export function* walkBoxes(buf, start = 0, end = buf.length) {
  let pos = start;
  while (pos + 8 <= end) {
    const size32 = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) {
      throw new Error(`bad box ${type} at ${pos}: size ${size}`);
    }
    yield { type, start: pos, size, headerSize, end: pos + size };
    pos += size;
  }
}

export function findBox(buf, range, path) {
  let boxes = [{ ...range, type: 'root' }];
  for (const want of path) {
    const next = [];
    for (const box of boxes) {
      const from = box.type === 'root' && box.headerSize == null
        ? box.start
        : box.start + (box.headerSize ?? 0);
      for (const child of walkBoxes(buf, from, box.end)) {
        if (child.type === want) next.push(child);
      }
    }
    boxes = next;
    if (boxes.length === 0) return null;
  }
  return boxes[0];
}

function readFullBoxVersionFlags(buf, payloadStart) {
  const version = buf.readUInt8(payloadStart);
  const flags = buf.readUIntBE(payloadStart + 1, 3);
  return { version, flags };
}

export function parseMdhd(buf, initRange) {
  const mdhd = findBox(buf, initRange, ['moov', 'trak', 'mdia', 'mdhd']);
  if (!mdhd) throw new Error('mdhd not found');
  const p = mdhd.start + mdhd.headerSize;
  const { version } = readFullBoxVersionFlags(buf, p);
  if (version === 1) {
    return { timescale: buf.readUInt32BE(p + 20), duration: Number(buf.readBigUInt64BE(p + 24)) };
  }
  return { timescale: buf.readUInt32BE(p + 12), duration: buf.readUInt32BE(p + 16) };
}

export function parseTfdt(buf, moofRange) {
  const tfdt = findBox(buf, moofRange, ['traf', 'tfdt']);
  if (!tfdt) return null;
  const p = tfdt.start + tfdt.headerSize;
  const { version } = readFullBoxVersionFlags(buf, p);
  return version === 1 ? Number(buf.readBigUInt64BE(p + 4)) : buf.readUInt32BE(p + 4);
}

function parseTfhdDefaultDuration(buf, trafRange) {
  const tfhd = findBox(buf, trafRange, ['tfhd']);
  if (!tfhd) return null;
  const p = tfhd.start + tfhd.headerSize;
  const { flags } = readFullBoxVersionFlags(buf, p);
  let off = p + 4 + 4; // fullbox header + track_ID
  if (flags & 0x000001) off += 8;
  if (flags & 0x000002) off += 4;
  if (flags & 0x000008) return buf.readUInt32BE(off);
  return null;
}

function parseTrunDurationSum(buf, trafRange, defaultDuration) {
  let total = 0;
  let found = false;
  for (const box of walkBoxes(buf, trafRange.start + trafRange.headerSize, trafRange.end)) {
    if (box.type !== 'trun') continue;
    const p = box.start + box.headerSize;
    const { flags } = readFullBoxVersionFlags(buf, p);
    const sampleCount = buf.readUInt32BE(p + 4);
    let off = p + 8;
    if (flags & 0x000001) off += 4;
    if (flags & 0x000004) off += 4;
    const recSize =
      (flags & 0x000100 ? 4 : 0) + (flags & 0x000200 ? 4 : 0) +
      (flags & 0x000400 ? 4 : 0) + (flags & 0x000800 ? 4 : 0);
    if (flags & 0x000100) {
      for (let i = 0; i < sampleCount; i++) total += buf.readUInt32BE(off + i * recSize);
      found = true;
    } else if (defaultDuration != null) {
      total += sampleCount * defaultDuration;
      found = true;
    }
  }
  return found ? total : null;
}

function parseTrexDefaultDuration(buf, initRange) {
  const trex = findBox(buf, initRange, ['moov', 'mvex', 'trex']);
  if (!trex) return null;
  const p = trex.start + trex.headerSize;
  return buf.readUInt32BE(p + 4 + 4 + 4); // fullbox + track_ID + sample_description_index
}

/**
 * Split a fragmented MP4 into init segment + media segments with durations.
 * Returns { init: Buffer, segments: [{ bytes: Buffer, tfdt, duration }] }.
 */
export function splitFragments(buf) {
  const top = [...walkBoxes(buf)];
  const firstMoof = top.findIndex((b) => b.type === 'moof');
  if (firstMoof === -1) throw new Error('no moof boxes: not a fragmented mp4');
  const initEnd = top[firstMoof].start;
  const init = buf.subarray(0, initEnd);
  const initRange = { start: 0, end: initEnd };
  const { timescale } = parseMdhd(buf, initRange);
  const trexDefault = parseTrexDefaultDuration(buf, initRange);

  const moofs = top.slice(firstMoof).filter((b) => b.type === 'moof');
  const segments = [];
  for (let i = 0; i < moofs.length; i++) {
    const start = moofs[i].start;
    const end = i + 1 < moofs.length ? moofs[i + 1].start : buf.length;
    const tfdt = parseTfdt(buf, moofs[i]);
    let duration;
    if (i + 1 < moofs.length) {
      const nextTfdt = parseTfdt(buf, moofs[i + 1]);
      duration = nextTfdt != null && tfdt != null ? nextTfdt - tfdt : null;
    }
    if (duration == null) {
      const traf = findBox(buf, moofs[i], ['traf']);
      const tfhdDefault = traf ? parseTfhdDefaultDuration(buf, traf) : null;
      const sum = traf ? parseTrunDurationSum(buf, traf, tfhdDefault ?? trexDefault) : null;
      duration = sum;
    }
    if (duration == null) throw new Error(`cannot determine duration of fragment ${i}`);
    segments.push({ bytes: buf.subarray(start, end), tfdt, duration: duration / timescale });
  }
  return { init, segments };
}
