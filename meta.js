// Reads what's inside audio files: chapter marks, title/album/author and cover art.
//  - .m4b / .m4a / .mp4: QuickTime chapter track or Nero "chpl" chapters, iTunes-style tags (©nam ©alb ©ART covr)
//  - .mp3: ID3v2 tags (TIT2 TALB TPE1) and the embedded picture (APIC)
// Only small slices of the file are read, so even 1 GB books are quick.

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

async function bytes(blob, pos, n) {
  const end = Math.min(blob.size, pos + n);
  if (pos >= end) return new DataView(new ArrayBuffer(0));
  return new DataView(await blob.slice(pos, end).arrayBuffer());
}

const u32 = (v, o) => v.getUint32(o);
function u64(v, o) { return v.getUint32(o) * 4294967296 + v.getUint32(o + 4); }
const str4 = (v, o) => latin1.decode(new Uint8Array(v.buffer, v.byteOffset + o, 4));

// ---------- MP4 ----------

async function boxes(blob, from, to) {
  const out = [];
  let pos = from;
  while (pos + 8 <= to) {
    const h = await bytes(blob, pos, 16);
    if (h.byteLength < 8) break;
    let size = u32(h, 0);
    const type = str4(h, 4);
    let header = 8;
    if (size === 1) { if (h.byteLength < 16) break; size = u64(h, 8); header = 16; }
    else if (size === 0) size = to - pos;
    if (size < header || pos + size > to) break;
    out.push({ type, start: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}
async function child(blob, box, type, skip = 0) {
  return (await boxes(blob, box.start + skip, box.end)).find((b) => b.type === type) || null;
}
async function payload(blob, box, max = 8 * 1024 * 1024) {
  return bytes(blob, box.start, Math.min(box.end - box.start, max));
}

async function mp4Info(blob) {
  const info = { chapters: [], title: null, album: null, artist: null, cover: null };
  const top = await boxes(blob, 0, blob.size);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return info;
  const moovKids = await boxes(blob, moov.start, moov.end);
  const traks = moovKids.filter((b) => b.type === 'trak');

  // Tags: moov/udta/meta/ilst
  const udta = moovKids.find((b) => b.type === 'udta');
  if (udta) {
    const meta = await child(blob, udta, 'meta');
    if (meta) {
      // "meta" is usually a full box (4 extra bytes); some files omit them
      let ilst = await child(blob, meta, 'ilst', 4);
      if (!ilst) ilst = await child(blob, meta, 'ilst', 0);
      if (ilst) {
        for (const item of await boxes(blob, ilst.start, ilst.end)) {
          const data = await child(blob, item, 'data');
          if (!data) continue;
          if (item.type === 'covr') {
            const dataType = u32(await bytes(blob, data.start, 4), 0) & 0xffffff;
            const mime = dataType === 14 ? 'image/png' : 'image/jpeg';
            info.cover = blob.slice(data.start + 8, data.end, mime);
          } else if (['©nam', '©alb', '©ART', 'aART'].includes(item.type)) {
            const v = await payload(blob, data, 4096);
            const text = utf8.decode(new Uint8Array(v.buffer, v.byteOffset + 8, Math.max(0, v.byteLength - 8))).trim();
            if (item.type === '©nam') info.title = text;
            if (item.type === '©alb') info.album = text;
            if (item.type === '©ART' || (item.type === 'aART' && !info.artist)) info.artist = text;
          }
        }
      }
    }
    // Nero chapters
    const chpl = await child(blob, udta, 'chpl');
    if (chpl) {
      try {
        const b = await payload(blob, chpl);
        let o = 0;
        const version = b.getUint8(o); o += 4;
        if (version !== 0) o += 4;
        const count = b.getUint8(o); o += 1;
        const list = [];
        for (let i = 0; i < count && o + 9 <= b.byteLength; i++) {
          const start = u64(b, o) / 1e7; o += 8;
          const len = b.getUint8(o); o += 1;
          const title = utf8.decode(new Uint8Array(b.buffer, b.byteOffset + o, Math.min(len, b.byteLength - o)));
          o += len;
          list.push({ start, title });
        }
        if (list.length > 1) info.chapters = list;
      } catch { /* ignore broken chapter list */ }
    }
  }

  // QuickTime chapter track (preferred when present)
  try {
    const ids = [];
    for (const trak of traks) {
      const tref = await child(blob, trak, 'tref');
      const chap = tref && (await child(blob, tref, 'chap'));
      if (chap) {
        const v = await payload(blob, chap);
        for (let o = 0; o + 4 <= v.byteLength; o += 4) ids.push(u32(v, o));
      }
    }
    if (ids.length) {
      for (const trak of traks) {
        const tkhd = await child(blob, trak, 'tkhd');
        if (!tkhd) continue;
        const h = await bytes(blob, tkhd.start, 24);
        const id = u32(h, h.getUint8(0) === 1 ? 20 : 12);
        if (!ids.includes(id)) continue;
        const list = await textTrackChapters(blob, trak);
        if (list.length > 1) info.chapters = list;
      }
    }
  } catch { /* keep Nero chapters if any */ }

  info.chapters = normalise(info.chapters);
  return info;
}

async function textTrackChapters(blob, trak) {
  const mdia = await child(blob, trak, 'mdia');
  const mdhd = mdia && (await child(blob, mdia, 'mdhd'));
  if (!mdhd) return [];
  const mh = await bytes(blob, mdhd.start, 32);
  const timescale = u32(mh, mh.getUint8(0) === 1 ? 20 : 12);
  if (!timescale) return [];
  const minf = await child(blob, mdia, 'minf');
  const stbl = minf && (await child(blob, minf, 'stbl'));
  if (!stbl) return [];
  const kids = await boxes(blob, stbl.start, stbl.end);
  const get = async (t) => { const b = kids.find((k) => k.type === t); return b ? payload(blob, b) : null; };

  const stts = await get('stts'); const stsz = await get('stsz'); const stsc = await get('stsc');
  const stco = await get('stco'); const co64 = await get('co64');
  if (!stts || !stsz || !stsc || (!stco && !co64)) return [];

  const durations = [];
  for (let i = 0, n = u32(stts, 4), o = 8; i < n; i++, o += 8) {
    const count = Math.min(u32(stts, o), 10000), delta = u32(stts, o + 4);
    for (let j = 0; j < count; j++) durations.push(delta);
  }
  const fixed = u32(stsz, 4), sampleCount = u32(stsz, 8);
  const sizes = [];
  for (let i = 0; i < sampleCount; i++) sizes.push(fixed || u32(stsz, 12 + i * 4));
  const offsets = [];
  if (stco) for (let i = 0, n = u32(stco, 4); i < n; i++) offsets.push(u32(stco, 8 + i * 4));
  else for (let i = 0, n = u32(co64, 4); i < n; i++) offsets.push(u64(co64, 8 + i * 8));
  const runs = [];
  for (let i = 0, n = u32(stsc, 4); i < n; i++) runs.push([u32(stsc, 8 + i * 12), u32(stsc, 12 + i * 12)]);

  const sampleOffsets = [];
  for (let chunk = 1; chunk <= offsets.length && sampleOffsets.length < sizes.length; chunk++) {
    const run = runs.filter((r) => r[0] <= chunk).pop();
    if (!run) break;
    let off = offsets[chunk - 1];
    for (let k = 0; k < run[1] && sampleOffsets.length < sizes.length; k++) {
      sampleOffsets.push(off);
      off += sizes[sampleOffsets.length - 1];
    }
  }

  const out = [];
  let time = 0;
  for (let i = 0; i < sampleOffsets.length; i++) {
    let title = '';
    try {
      const head = await bytes(blob, sampleOffsets[i], 2);
      const len = Math.min(head.getUint16(0), 1024);
      const raw = new Uint8Array(await blob.slice(sampleOffsets[i] + 2, sampleOffsets[i] + 2 + len).arrayBuffer());
      title = (raw[0] === 0xfe && raw[1] === 0xff ? new TextDecoder('utf-16be').decode(raw.subarray(2)) : utf8.decode(raw)).trim();
    } catch { /* untitled */ }
    out.push({ start: time / timescale, title });
    time += durations[i] || 0;
  }
  return out;
}

function normalise(list) {
  const seen = new Set();
  return list
    .filter((c) => Number.isFinite(c.start))
    .sort((a, b) => a.start - b.start)
    .filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)))
    .map((c, i) => ({ start: i === 0 ? 0 : c.start, title: c.title || `Chapter ${i + 1}` }));
}

// ---------- MP3 (ID3v2) ----------

function decodeText(enc, arr) {
  try {
    if (enc === 0) return latin1.decode(arr).replace(/\0+$/, '');
    if (enc === 1) return new TextDecoder('utf-16').decode(arr).replace(/\0+$/, '');
    if (enc === 2) return new TextDecoder('utf-16be').decode(arr).replace(/\0+$/, '');
    return utf8.decode(arr).replace(/\0+$/, '');
  } catch { return ''; }
}

async function id3Info(blob) {
  const info = { chapters: [], title: null, album: null, artist: null, cover: null };
  const h = await bytes(blob, 0, 10);
  if (h.byteLength < 10 || latin1.decode(new Uint8Array(h.buffer, 0, 3)) !== 'ID3') return info;
  const ver = h.getUint8(3);
  const syncsafe = (v, o) => ((v.getUint8(o) & 127) << 21) | ((v.getUint8(o + 1) & 127) << 14) | ((v.getUint8(o + 2) & 127) << 7) | (v.getUint8(o + 3) & 127);
  const size = syncsafe(h, 6);
  const tag = new Uint8Array(await blob.slice(10, 10 + Math.min(size, 16 * 1024 * 1024)).arrayBuffer());
  const v = new DataView(tag.buffer);
  let o = 0;
  while (o + 10 <= tag.length) {
    const id = latin1.decode(tag.subarray(o, o + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = ver >= 4 ? syncsafe(v, o + 4) : v.getUint32(o + 4);
    const body = tag.subarray(o + 10, o + 10 + fsize);
    o += 10 + fsize;
    if (!fsize || !body.length) continue;
    if (id === 'TIT2' || id === 'TALB' || id === 'TPE1') {
      const text = decodeText(body[0], body.subarray(1)).trim();
      if (id === 'TIT2') info.title = text;
      if (id === 'TALB') info.album = text;
      if (id === 'TPE1') info.artist = text;
    } else if (id === 'APIC' && !info.cover) {
      const enc = body[0];
      let p = 1;
      const mimeEnd = body.indexOf(0, p);
      const mime = latin1.decode(body.subarray(p, mimeEnd)) || 'image/jpeg';
      p = mimeEnd + 2; // null + picture type
      if (enc === 1 || enc === 2) { while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2; p += 2; }
      else { while (p < body.length && body[p] !== 0) p++; p += 1; }
      info.cover = new Blob([body.slice(p)], { type: mime.includes('/') ? mime : 'image/' + mime.toLowerCase() });
    }
  }
  return info;
}

export async function readMeta(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    if (['m4b', 'm4a', 'mp4', 'aac'].includes(ext)) return await mp4Info(file);
    if (ext === 'mp3') return await id3Info(file);
  } catch { /* fall through */ }
  return { chapters: [], title: null, album: null, artist: null, cover: null };
}

/** Length of an audio file in seconds, from the browser's own decoder (0 if unknown). */
export function probeDuration(blob) {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (d) => { if (done) return; done = true; URL.revokeObjectURL(url); a.removeAttribute('src'); resolve(d); };
    a.onloadedmetadata = () => finish(Number.isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => finish(0);
    setTimeout(() => finish(0), 20000);
    a.src = url;
  });
}
