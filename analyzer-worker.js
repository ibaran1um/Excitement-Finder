/* 盛り上がりファインダー 解析ワーカー（モジュールワーカー）
 * - 対応形式（MP4・MOV・MKV・WebM）はファイルを少しずつ読み、WebCodecs で音声だけを復号しながら解析する。
 *   動画全体をメモリに展開しないため、長時間のアーカイブでも使うメモリはほぼ一定。
 * - それ以外は本体側で復号した PCM を受け取って解析する。
 */
import { openAudio } from "./demux.js";

const HOP = 0.1, SMOOTH = 1.0, HISTORY = 60, FLOOR = -70, BIN = 0.5;
const NBINS = Math.ceil(-FLOOR / BIN) + 1;

function biquad(type, f0, fs, q = Math.SQRT1_2) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
  let b0, b1, b2;
  if (type === "lowpass") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  const a0 = 1 + a;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * c / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

/** 0.1秒ごとの「全体」と「声の帯域(300〜3000Hz)」の平均二乗値を、流れてくるサンプルから順に作る */
class Features {
  constructor(sr) {
    this.sr = sr; this.hop = Math.round(HOP * sr);
    this.hp = biquad("highpass", 300, sr); this.lp = biquad("lowpass", Math.min(3000, sr * 0.45), sr);
    this.eAll = []; this.eVoice = []; this.acc = 0; this.accV = 0; this.k = 0; this.cursor = 0;
  }
  push(mono, len) {
    const hp = this.hp, lp = this.lp;
    for (let i = 0; i < len; i++) {
      const x = mono[i];
      const h = hp.b0 * x + hp.b1 * hp.x1 + hp.b2 * hp.x2 - hp.a1 * hp.y1 - hp.a2 * hp.y2;
      hp.x2 = hp.x1; hp.x1 = x; hp.y2 = hp.y1; hp.y1 = h;
      const l = lp.b0 * h + lp.b1 * lp.x1 + lp.b2 * lp.x2 - lp.a1 * lp.y1 - lp.a2 * lp.y2;
      lp.x2 = lp.x1; lp.x1 = h; lp.y2 = lp.y1; lp.y1 = l;
      this.acc += x * x; this.accV += l * l;
      if (++this.k === this.hop) { this.eAll.push(this.acc / this.hop); this.eVoice.push(this.accV / this.hop); this.acc = this.accV = 0; this.k = 0; }
    }
    this.cursor += len;
  }
  /** 欠落区間を無音で埋める */
  skipTo(sample) {
    const gap = sample - this.cursor;
    if (gap <= this.hop / 2) return;
    const z = new Float32Array(Math.min(gap, 1 << 16));
    let left = gap; while (left > 0) { const n = Math.min(left, z.length); this.push(z, n); left -= n; }
  }
}

const toDb = e => Math.max(FLOOR, 10 * Math.log10(e + 1e-12));
function smoothDb(energy, w) {
  const n = energy.length, half = w >> 1, pre = new Float64Array(n + 1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + energy[i];
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - half), b = Math.min(n, i + half + 1); out[i] = toDb((pre[b] - pre[a]) / (b - a)); }
  return out;
}
// 直前 len フレームの中央値（ヒストグラムを滑らせて計算）
function trailingMedian(db, len) {
  const n = db.length, out = new Float32Array(n), hist = new Int32Array(NBINS);
  const bin = v => Math.min(NBINS - 1, Math.max(0, Math.round((v - FLOOR) / BIN)));
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (count === 0) out[i] = db[i];
    else { const half = (count + 1) >> 1; let acc = 0, k = 0; for (; k < NBINS; k++) { acc += hist[k]; if (acc >= half) break; } out[i] = FLOOR + k * BIN; }
    hist[bin(db[i])]++; count++;
    if (i - len >= 0) { hist[bin(db[i - len])]--; count--; }
  }
  return out;
}
function finish(f) {
  const w = Math.max(1, Math.round(SMOOTH / HOP)), hist = Math.round(HISTORY / HOP);
  const dbAll = smoothDb(f.eAll, w), dbVoice = smoothDb(f.eVoice, w);
  const baseAll = trailingMedian(dbAll, hist), baseVoice = trailingMedian(dbVoice, hist);
  return { hop: HOP, floor: FLOOR, dbAll, dbVoice, baseAll, baseVoice, duration: f.eAll.length * HOP };
}

const post = (stage, ratio) => self.postMessage({ type: "progress", stage, ratio });

/** AudioData をモノラル Float32 に */
function toMono(ad, scratch) {
  const n = ad.numberOfFrames, ch = ad.numberOfChannels;
  if (!scratch.mono || scratch.mono.length < n) { scratch.mono = new Float32Array(n); scratch.plane = new Float32Array(n); }
  const mono = scratch.mono, plane = scratch.plane;
  mono.fill(0, 0, n);
  for (let c = 0; c < ch; c++) {
    ad.copyTo(plane, { planeIndex: c, format: "f32-planar" });
    for (let i = 0; i < n; i++) mono[i] += plane[i] / ch;
  }
  return n;
}

async function streamAnalyze(file) {
  if (typeof AudioDecoder === "undefined") throw new Error("NO_WEBCODECS");
  const src = await openAudio(file);
  const sup = await AudioDecoder.isConfigSupported(src.config).catch(() => ({ supported: false }));
  if (!sup.supported) throw new Error(`UNSUPPORTED_CODEC:${src.config.codec}`);
  const f = new Features(src.config.sampleRate);
  const scratch = {};
  let decodeError = null, lastTs = 0;
  const dec = new AudioDecoder({
    output: ad => {
      try {
        if (ad.sampleRate !== f.sr) { /* まれに出力レートが異なる場合は作り直す */ f.sr = ad.sampleRate; }
        const start = Math.max(0, Math.round(ad.timestamp / 1e6 * f.sr));
        f.skipTo(start);
        const n = toMono(ad, scratch);
        f.push(scratch.mono, n);
        lastTs = ad.timestamp / 1e6;
      } finally { ad.close(); }
    },
    error: e => { decodeError = e; },
  });
  dec.configure(src.config);
  const dur = src.duration || 0;
  let count = 0, t0 = Date.now();
  for await (const c of src.chunks) {
    if (decodeError) throw decodeError;
    dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(c.ts * 1e6), duration: c.dur ? Math.round(c.dur * 1e6) : undefined, data: c.data }));
    count++;
    while (dec.decodeQueueSize > 64) await new Promise(r => setTimeout(r, 0));
    if (Date.now() - t0 > 250) {
      t0 = Date.now();
      const ratio = dur ? Math.min(0.97, c.ts / dur) : (src.total ? count / src.total : null);
      post("音声を取り出して解析しています", ratio);
    }
  }
  await dec.flush();
  dec.close();
  if (decodeError) throw decodeError;
  if (!f.eAll.length) throw new Error("音声を取り出せませんでした");
  post("仕上げています", 0.99);
  return { ...finish(f), method: "stream", codec: src.config.codec };
}

function pcmAnalyze(pcm, sampleRate) {
  const f = new Features(sampleRate);
  const step = sampleRate * 60;
  for (let i = 0; i < pcm.length; i += step) {
    f.push(pcm.subarray(i, Math.min(pcm.length, i + step)), Math.min(step, pcm.length - i));
    post("音量を解析しています", i / pcm.length);
  }
  return { ...finish(f), method: "whole" };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    const res = m.kind === "file" ? await streamAnalyze(m.file) : pcmAnalyze(m.pcm, m.sampleRate);
    self.postMessage({ type: "done", ...res }, [res.dbAll.buffer, res.dbVoice.buffer, res.baseAll.buffer, res.baseVoice.buffer]);
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
