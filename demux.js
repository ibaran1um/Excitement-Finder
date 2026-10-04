// 動画ファイルから音声の符号化データだけを取り出す（MP4 / 断片化MP4 / Matroska・WebM）
// ファイル全体をメモリに読み込まず、必要な部分だけを File.slice で読む。

class Reader {
  constructor(file) { this.file = file; this.size = file.size; }
  async read(off, len) {
    const end = Math.min(this.size, off + len);
    return new Uint8Array(await this.file.slice(off, end).arrayBuffer());
  }
}
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const u64 = (b, p) => u32(b, p) * 4294967296 + u32(b, p + 4);
const str4 = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/* ---------- AAC の AudioSpecificConfig ---------- */
const SF = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function aacCodecString(asc) {
  let aot = asc[0] >> 3;
  if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
  return "mp4a.40." + aot;
}
function makeASC(sampleRate, channels) {
  const idx = Math.max(0, SF.indexOf(sampleRate));
  const v = (2 << 11) | (idx << 7) | (channels << 3);
  return new Uint8Array([v >> 8, v & 0xff]);
}

/* ================= MP4 ================= */
function* boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p); const type = str4(b, p + 4); let hdr = 8;
    if (size === 1) { size = u64(b, p + 8); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) return;
    yield { type, start: p, data: p + hdr, end: p + size };
    p += size;
  }
}
const child = (b, box, type) => { for (const c of boxes(b, box.data, box.end)) if (c.type === type) return c; return null; };
const path = (b, box, ...types) => { let c = box; for (const t of types) { c = c && child(b, c, t); } return c; };

function findDeep(b, start, end, type) {
  for (let p = start; p + 8 <= end; p++) {
    if (str4(b, p + 4) === type) { const size = u32(b, p); if (size >= 8 && p + size <= end) return { data: p + 8, end: p + size }; }
  }
  return null;
}
function readDescLen(b, p) { let len = 0, n = 0; while (n < 4) { const x = b[p + n]; len = (len << 7) | (x & 0x7f); n++; if (!(x & 0x80)) break; } return { len, n }; }
function parseEsds(b, box) {
  let p = box.data + 4;
  if (b[p] !== 3) return null;
  let l = readDescLen(b, p + 1); p += 1 + l.n;
  const flags = b[p + 2]; p += 3;
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + b[p];
  if (flags & 0x20) p += 2;
  if (b[p] !== 4) return null;
  l = readDescLen(b, p + 1); p += 1 + l.n;
  const oti = b[p]; p += 13;
  let asc = null;
  if (b[p] === 5) { l = readDescLen(b, p + 1); p += 1 + l.n; asc = b.slice(p, p + l.len); }
  return { oti, asc };
}

function audioConfigFromStsd(b, stsd) {
  const entry = boxes(b, stsd.data + 8, stsd.end).next().value;
  if (!entry) return null;
  const type = entry.type, e = entry.data;
  const ver = u16(b, e + 8);
  const channels = u16(b, e + 16), sampleRate = u32(b, e + 24) >>> 16;
  const childStart = e + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
  if (type === "mp4a") {
    const esds = findDeep(b, childStart, entry.end, "esds");
    const d = esds && parseEsds(b, esds);
    if (!d) return null;
    if (d.oti === 0x40 || d.oti === 0x66 || d.oti === 0x67 || d.oti === 0x68) {
      const asc = d.asc && d.asc.length >= 2 ? d.asc : makeASC(sampleRate, channels);
      return { codec: aacCodecString(asc), sampleRate, numberOfChannels: channels, description: asc };
    }
    if (d.oti === 0x69 || d.oti === 0x6b) return { codec: "mp3", sampleRate, numberOfChannels: channels };
    return null;
  }
  if (type === "Opus") return { codec: "opus", sampleRate: 48000, numberOfChannels: channels };
  if (type === ".mp3") return { codec: "mp3", sampleRate, numberOfChannels: channels };
  return null;
}

async function topLevel(r) {
  const list = []; let p = 0;
  while (p + 8 <= r.size) {
    const h = await r.read(p, 16);
    let size = u32(h, 0); const type = str4(h, 4); let hdr = 8;
    if (size === 1) { size = u64(h, 8); hdr = 16; } else if (size === 0) size = r.size - p;
    if (size < hdr) break;
    list.push({ type, start: p, data: p + hdr, end: Math.min(r.size, p + size) });
    p += size;
  }
  return list;
}

/** 読み出しをまとめる（間が1MB未満なら1回で読む） */
async function* readCoalesced(r, samples) {
  const GAP = 1 << 20, MAX = 16 << 20;
  let i = 0;
  while (i < samples.length) {
    let j = i, start = samples[i].off, end = samples[i].off + samples[i].size;
    while (j + 1 < samples.length) {
      const s = samples[j + 1];
      if (s.off < end || s.off - end > GAP || s.off + s.size - start > MAX) break;
      end = s.off + s.size; j++;
    }
    const buf = await r.read(start, end - start);
    for (let k = i; k <= j; k++) { const s = samples[k]; yield { data: buf.subarray(s.off - start, s.off - start + s.size), ts: s.ts, dur: s.dur }; }
    i = j + 1;
  }
}

async function openMP4(r, top) {
  const moovBox = top.find(x => x.type === "moov");
  if (!moovBox) throw new Error("MP4の情報(moov)が見つかりません");
  const b = await r.read(moovBox.start, moovBox.end - moovBox.start);
  const moov = { data: moovBox.data - moovBox.start, end: b.length };
  let trak = null, cfg = null, timescale = 0, duration = 0, trackId = 0;
  for (const t of boxes(b, moov.data, moov.end)) {
    if (t.type !== "trak") continue;
    const hdlr = path(b, t, "mdia", "hdlr");
    if (!hdlr || str4(b, hdlr.data + 8) !== "soun") continue;
    const mdhd = path(b, t, "mdia", "mdhd");
    const v = b[mdhd.data];
    timescale = v === 1 ? u32(b, mdhd.data + 20) : u32(b, mdhd.data + 12);
    duration = v === 1 ? u64(b, mdhd.data + 24) : u32(b, mdhd.data + 16);
    const tkhd = child(b, t, "tkhd");
    trackId = b[tkhd.data] === 1 ? u32(b, tkhd.data + 20) : u32(b, tkhd.data + 12);
    const stsd = path(b, t, "mdia", "minf", "stbl", "stsd");
    cfg = stsd && audioConfigFromStsd(b, stsd);
    trak = t; break;
  }
  if (!trak) throw new Error("音声トラックがありません");
  if (!cfg) throw new Error("この音声形式には対応していません");
  const fragmented = top.some(x => x.type === "moof");
  const durSec = duration && timescale ? duration / timescale : 0;
  if (!fragmented) {
    const stbl = path(b, trak, "mdia", "minf", "stbl");
    const stsz = child(b, stbl, "stsz"), stco = child(b, stbl, "stco"), co64 = child(b, stbl, "co64");
    const stsc = child(b, stbl, "stsc"), stts = child(b, stbl, "stts");
    const fixed = u32(b, stsz.data + 4), count = u32(b, stsz.data + 8);
    const size = i => fixed || u32(b, stsz.data + 12 + i * 4);
    const nChunks = stco ? u32(b, stco.data + 4) : u32(b, co64.data + 4);
    const chunkOff = i => stco ? u32(b, stco.data + 8 + i * 4) : u64(b, co64.data + 8 + i * 8);
    const scN = u32(b, stsc.data + 4), sc = i => ({ first: u32(b, stsc.data + 8 + i * 12) - 1, per: u32(b, stsc.data + 12 + i * 12) });
    const stN = u32(b, stts.data + 4);
    const samples = new Array(count);
    let si = 0, ts = 0, sttsI = 0, sttsLeft = stN ? u32(b, stts.data + 8) : 0, delta = stN ? u32(b, stts.data + 12) : 1024;
    for (let ci = 0, k = 0; ci < nChunks && si < count; ci++) {
      while (k + 1 < scN && sc(k + 1).first <= ci) k++;
      let off = chunkOff(ci);
      for (let s = 0; s < sc(k).per && si < count; s++, si++) {
        const sz = size(si);
        samples[si] = { off, size: sz, ts: ts / timescale, dur: delta / timescale };
        off += sz; ts += delta;
        if (--sttsLeft === 0 && ++sttsI < stN) { sttsLeft = u32(b, stts.data + 8 + sttsI * 8); delta = u32(b, stts.data + 12 + sttsI * 8); }
      }
    }
    samples.length = si;
    samples.sort((a, c) => a.off - c.off);
    return { config: cfg, duration: durSec || ts / timescale, chunks: readCoalesced(r, samples), total: samples.length };
  }
  // 断片化MP4: trex の既定値を読み、moof ごとに trun を解釈する
  let defDur = 0, defSize = 0;
  const mvex = child(b, moov, "mvex");
  if (mvex) for (const t of boxes(b, mvex.data, mvex.end)) if (t.type === "trex" && u32(b, t.data + 4) === trackId) { defDur = u32(b, t.data + 12); defSize = u32(b, t.data + 16); }
  const moofs = top.filter(x => x.type === "moof");
  async function* gen() {
    let lastEnd = 0;
    for (const mf of moofs) {
      const m = await r.read(mf.start, mf.end - mf.start);
      const samples = [];
      for (const traf of boxes(m, mf.data - mf.start, m.length)) {
        if (traf.type !== "traf") continue;
        const tfhd = child(m, traf, "tfhd"); if (!tfhd) continue;
        const fl = (m[tfhd.data + 1] << 16) | (m[tfhd.data + 2] << 8) | m[tfhd.data + 3];
        if (u32(m, tfhd.data + 4) !== trackId) continue;
        let q = tfhd.data + 8, base = mf.start, tDur = defDur, tSize = defSize;
        if (fl & 0x1) { base = u64(m, q); q += 8; }
        if (fl & 0x2) q += 4;
        if (fl & 0x8) { tDur = u32(m, q); q += 4; }
        if (fl & 0x10) { tSize = u32(m, q); q += 4; }
        const tfdt = child(m, traf, "tfdt");
        let t = tfdt ? (m[tfdt.data] === 1 ? u64(m, tfdt.data + 4) : u32(m, tfdt.data + 4)) : lastEnd;
        for (const trun of boxes(m, traf.data, traf.end)) {
          if (trun.type !== "trun") continue;
          const tf = (m[trun.data + 1] << 16) | (m[trun.data + 2] << 8) | m[trun.data + 3];
          const n = u32(m, trun.data + 4); let p = trun.data + 8, off = base;
          if (tf & 0x1) { off = base + (u32(m, p) | 0); p += 4; }
          if (tf & 0x4) p += 4;
          for (let i = 0; i < n; i++) {
            let d = tDur, s = tSize;
            if (tf & 0x100) { d = u32(m, p); p += 4; }
            if (tf & 0x200) { s = u32(m, p); p += 4; }
            if (tf & 0x400) p += 4;
            if (tf & 0x800) p += 4;
            samples.push({ off, size: s, ts: t / timescale, dur: d / timescale });
            off += s; t += d;
          }
        }
        lastEnd = t;
      }
      yield* readCoalesced(r, samples);
    }
  }
  return { config: cfg, duration: durSec, chunks: gen(), total: 0 };
}

/* ================= Matroska / WebM ================= */
const ID = { Segment: 0x18538067, Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1,
  Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Duration: 0x4489, Tracks: 0x1654AE6B, TrackEntry: 0xAE,
  TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2, Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F };
const ENTER = new Set([ID.Segment, ID.Cluster, ID.BlockGroup]);

function vint(b, p, keep) {
  const f = b[p]; if (f === undefined) return null;
  let len = 1, mask = 0x80; while (len <= 8 && !(f & mask)) { len++; mask >>= 1; }
  if (len > 8 || p + len > b.length) return null;
  let v = keep ? f : f & (mask - 1), allOnes = (f & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) allOnes = false; }
  return { v, len, unknown: !keep && allOnes };
}
function* ebml(b, s, e) {
  let p = s;
  while (p < e) {
    const id = vint(b, p, true); if (!id) return;
    const sz = vint(b, p + id.len, false); if (!sz) return;
    const d = p + id.len + sz.len;
    yield { id: id.v, data: d, end: Math.min(e, d + sz.v) };
    p = d + sz.v;
  }
}
const uintAt = (b, s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + b[i]; return v; };
const floatAt = (b, s, e) => { const dv = new DataView(b.buffer, b.byteOffset + s, e - s); return e - s === 4 ? dv.getFloat32(0) : dv.getFloat64(0); };

function parseTracks(b, s, e) {
  for (const te of ebml(b, s, e)) {
    if (te.id !== ID.TrackEntry) continue;
    const t = { number: 0, type: 0, codec: "", priv: null, rate: 8000, ch: 1 };
    for (const x of ebml(b, te.data, te.end)) {
      if (x.id === ID.TrackNumber) t.number = uintAt(b, x.data, x.end);
      else if (x.id === ID.TrackType) t.type = uintAt(b, x.data, x.end);
      else if (x.id === ID.CodecID) t.codec = new TextDecoder().decode(b.subarray(x.data, x.end));
      else if (x.id === ID.CodecPrivate) t.priv = b.slice(x.data, x.end);
      else if (x.id === ID.Audio) for (const a of ebml(b, x.data, x.end)) {
        if (a.id === ID.SamplingFrequency) t.rate = Math.round(floatAt(b, a.data, a.end));
        else if (a.id === ID.Channels) t.ch = uintAt(b, a.data, a.end);
      }
    }
    if (t.type === 2) return t;
  }
  return null;
}
function mkvConfig(t) {
  if (t.codec === "A_OPUS") return { codec: "opus", sampleRate: 48000, numberOfChannels: t.ch, description: t.priv || undefined };
  if (t.codec.startsWith("A_AAC")) {
    const asc = t.priv && t.priv.length >= 2 ? t.priv : makeASC(t.rate, t.ch);
    return { codec: aacCodecString(asc), sampleRate: t.rate, numberOfChannels: t.ch, description: asc };
  }
  if (t.codec === "A_MPEG/L3") return { codec: "mp3", sampleRate: t.rate, numberOfChannels: t.ch };
  return null;
}
function splitLaces(b, s, e, lacing) {
  if (!lacing) return [b.subarray(s, e)];
  const n = b[s] + 1; let p = s + 1; const sizes = [];
  if (lacing === 1) {               // Xiph
    for (let i = 0; i < n - 1; i++) { let v = 0, x; do { x = b[p++]; v += x; } while (x === 255); sizes.push(v); }
  } else if (lacing === 3) {        // EBML
    let r = vint(b, p, false); sizes.push(r.v); p += r.len;
    for (let i = 1; i < n - 1; i++) { r = vint(b, p, false); const bias = 2 ** (7 * r.len - 1) - 1; sizes.push(sizes[i - 1] + (r.v - bias)); p += r.len; }
  } else {                          // 固定長
    const each = Math.floor((e - p) / n); for (let i = 0; i < n - 1; i++) sizes.push(each);
  }
  const used = sizes.reduce((a, c) => a + c, 0); sizes.push(e - p - used);
  const out = []; for (const z of sizes) { out.push(b.subarray(p, p + z)); p += z; }
  return out;
}

async function openMKV(r) {
  // 先頭から Tracks までを読んで音声トラックを特定
  const WIN = 8 << 20;
  let scale = 1e6, durSec = 0, track = null;
  let buf = await r.read(0, Math.min(r.size, 4 << 20)), bufStart = 0;
  let p = 0;
  // EBML ヘッダを飛ばす
  { const id = vint(buf, 0, true), sz = vint(buf, id.len, false); p = id.len + sz.len + sz.v; }
  const ensure = async (pos, len) => {
    if (pos >= bufStart && pos + len <= bufStart + buf.length) return true;
    if (pos >= r.size) return false;
    buf = await r.read(pos, Math.max(WIN, len)); bufStart = pos;
    return pos + len <= bufStart + buf.length || bufStart + buf.length >= r.size;
  };
  let pos = p, clusterTime = 0, firstHit = true;
  const header = async () => {
    if (!(await ensure(pos, 16))) return null;
    const q = pos - bufStart;
    const id = vint(buf, q, true), sz = id && vint(buf, q + id.len, false);
    if (!id || !sz) return null;
    return { id: id.v, size: sz.v, unknown: sz.unknown, hdr: id.len + sz.len };
  };
  // Tracks を見つけるまで進む
  while (!track) {
    const h = await header(); if (!h) throw new Error("WebM/MKVの音声トラックが見つかりません");
    if (ENTER.has(h.id) || h.unknown) { pos += h.hdr; continue; }
    if (h.id === ID.Info || h.id === ID.Tracks) {
      await ensure(pos, h.hdr + h.size);
      const q = pos - bufStart + h.hdr;
      if (h.id === ID.Info) for (const x of ebml(buf, q, q + h.size)) {
        if (x.id === ID.TimecodeScale) scale = uintAt(buf, x.data, x.end);
        else if (x.id === ID.Duration) durSec = floatAt(buf, x.data, x.end);
      } else track = parseTracks(buf, q, q + h.size);
      if (h.id === ID.Tracks && !track) throw new Error("音声トラックがありません");
    }
    if (h.id === ID.Cluster) throw new Error("トラック情報より前に映像データがあります");
    pos += h.hdr + h.size;
  }
  durSec = durSec * scale / 1e9;
  const config = mkvConfig(track);
  if (!config) throw new Error(`この音声形式（${track.codec}）には対応していません`);
  async function* gen() {
    while (true) {
      const h = await header(); if (!h) return;
      if (ENTER.has(h.id) || h.unknown) { pos += h.hdr; continue; }
      if (h.id === ID.Timecode) {
        if (!(await ensure(pos, h.hdr + h.size))) return;
        const q = pos - bufStart + h.hdr;
        clusterTime = uintAt(buf, q, q + h.size);
      } else if (h.id === ID.SimpleBlock || h.id === ID.Block) {
        // まずトラック番号だけ確認し、音声のときだけ中身を読む
        if (!(await ensure(pos, h.hdr + 4))) return;
        const tn0 = vint(buf, pos - bufStart + h.hdr, false);
        if (tn0 && tn0.v === track.number) {
          if (!(await ensure(pos, h.hdr + h.size))) return;
          const q = pos - bufStart + h.hdr, e = q + h.size;
          const tn = vint(buf, q, false);
          {
            const rel = (buf[q + tn.len] << 24 >> 16) | buf[q + tn.len + 1];
            const flags = buf[q + tn.len + 2], lacing = (flags >> 1) & 3;
            const ts = (clusterTime + rel) * scale / 1e9;
            for (const f of splitLaces(buf, q + tn.len + 3, e, lacing)) yield { data: f.slice(), ts, dur: 0 };
          }
        }
      }
      pos += h.hdr + h.size;
    }
  }
  return { config, duration: durSec, chunks: gen(), total: 0, progress: () => pos / r.size };
}

/** 対応形式なら { config, duration, chunks(非同期イテレータ) } を返す */
export async function openAudio(file) {
  const r = new Reader(file);
  const head = await r.read(0, 12);
  if (head.length >= 4 && u32(head, 0) === 0x1A45DFA3) return openMKV(r);
  if (head.length >= 8 && ["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(str4(head, 4))) {
    const top = await topLevel(r);
    const res = await openMP4(r, top);
    return res;
  }
  throw new Error("MP4・MOV・MKV・WebM 以外の形式");
}
