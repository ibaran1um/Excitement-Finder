// ブラウザ内での切り抜き書き出し（再生しながら MediaRecorder で録画する）
const CANDIDATES = [
  { mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4", label: "MP4（H.264 / AAC）" },
  { mime: "video/webm;codecs=vp9,opus", ext: "webm", label: "WebM（VP9 / Opus）" },
  { mime: "video/webm;codecs=vp8,opus", ext: "webm", label: "WebM（VP8 / Opus）" },
];
export function supportedFormats() {
  if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) return [];
  return CANDIDATES.filter(f => MediaRecorder.isTypeSupported(f.mime));
}

/** 出力サイズと切り取り範囲（偶数ピクセルに揃える） */
export function layout(vw, vh, shape, cropX) {
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  if (shape !== "vertical") {
    const s = Math.min(1, 1920 / Math.max(vw, vh));
    return { cw: even(vw * s), ch: even(vh * s), sx: 0, sy: 0, sw: vw, sh: vh };
  }
  let sw, sh, sx, sy;
  if (vw / vh > 9 / 16) { sh = vh; sw = vh * 9 / 16; sx = (vw - sw) * cropX; sy = 0; }
  else { sw = vw; sh = vw * 16 / 9; sx = 0; sy = (vh - sh) / 2; }
  const ch = even(Math.min(1920, sh)), cw = even(ch * 9 / 16);
  return { cw, ch, sx, sy, sw, sh };
}

export class ClipRecorder {
  constructor(src) {
    this.v = document.createElement("video");
    this.v.src = src; this.v.preload = "auto"; this.v.playsInline = true;
    this.ctx = null; this.dest = null; this.cancelled = false;
  }
  /** クリックなどユーザー操作の中で呼ぶ（音声の再生許可のため） */
  prepareAudio() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const node = this.ctx.createMediaElementSource(this.v);
      this.dest = this.ctx.createMediaStreamDestination();
      node.connect(this.dest);           // スピーカーには繋がないので、書き出し中に音は鳴らない
    }
    return this.ctx.resume();
  }
  cancel() { this.cancelled = true; }
  async _ready() {
    if (this.v.readyState >= 1) return;
    await new Promise((res, rej) => { this.v.onloadedmetadata = res; this.v.onerror = () => rej(new Error("動画を読み込めませんでした")); });
  }
  async _seek(t) {
    await new Promise(res => { const f = () => { this.v.removeEventListener("seeked", f); res(); }; this.v.addEventListener("seeked", f); this.v.currentTime = t; });
  }

  /** 1本書き出す。onProgress(0..1) */
  async record(clip, { shape, cropX, fmt }, onProgress) {
    await this._ready();
    const v = this.v, L = layout(v.videoWidth || 1280, v.videoHeight || 720, shape, cropX);
    const canvas = document.createElement("canvas");
    canvas.width = L.cw; canvas.height = L.ch;
    const g = canvas.getContext("2d");
    const paint = () => { g.fillStyle = "#000"; g.fillRect(0, 0, L.cw, L.ch); g.drawImage(v, L.sx, L.sy, L.sw, L.sh, 0, 0, L.cw, L.ch); };
    await this._seek(clip.start);
    paint();
    const stream = canvas.captureStream(30);
    for (const tr of this.dest.stream.getAudioTracks()) stream.addTrack(tr);
    const rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: L.ch >= 1080 ? 8_000_000 : 5_000_000, audioBitsPerSecond: 192_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    let running = true;
    const loop = () => {
      if (!running) return;
      paint();
      const p = (v.currentTime - clip.start) / (clip.end - clip.start);
      onProgress && onProgress(Math.min(1, Math.max(0, p)));
      if (v.currentTime >= clip.end || v.ended || this.cancelled) { running = false; v.pause(); rec.stop(); return; }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
    };
    rec.start(1000);
    await v.play();
    // 映像フレームが来ない区間（静止画など）でも終了判定できるように
    const guard = setInterval(() => { if (running && (v.currentTime >= clip.end || v.ended || this.cancelled)) loop(); }, 250);
    loop();
    await stopped;
    clearInterval(guard);
    stream.getVideoTracks().forEach(t => t.stop());
    if (this.cancelled) return null;
    const blob = new Blob(chunks, { type: fmt.mime.split(";")[0] });
    const recorded = Math.max(0.1, Math.min(v.currentTime, clip.end) - clip.start);
    return fmt.ext === "webm" ? fixWebmDuration(blob, recorded) : blob;
  }
  dispose() { this.v.removeAttribute("src"); this.v.load(); if (this.ctx) this.ctx.close(); }
}

/* ---- WebM の長さ情報の補完 ----
 * MediaRecorder が作る WebM には Segment Info に Duration が入らないことがあり、
 * その場合プレイヤーで長さが表示されない。Info 要素に Duration を追加する。
 * 参考: Matroska 仕様 (Info=0x1549A966, Duration=0x4489, TimestampScale=0x2AD7B1)
 */
function readVint(b, p, keepMarker) {
  const first = b[p]; let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) return null;
  let v = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < len; i++) v = v * 256 + b[p + i];
  return { v, len };
}
export async function fixWebmDuration(blob, durationSec) {
  try {
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 64 * 1024)).arrayBuffer());
    // Info 要素を探す
    let p = -1;
    for (let i = 0; i < head.length - 4; i++) {
      if (head[i] === 0x15 && head[i + 1] === 0x49 && head[i + 2] === 0xA9 && head[i + 3] === 0x66) { p = i; break; }
    }
    if (p < 0) return blob;
    const sz = readVint(head, p + 4, false);
    if (!sz) return blob;
    const bodyStart = p + 4 + sz.len, bodyEnd = bodyStart + sz.v;
    if (bodyEnd > head.length) return blob;
    // 子要素を走査して Duration と TimestampScale を確認
    let q = bodyStart, scale = 1e6;
    while (q < bodyEnd) {
      const id = readVint(head, q, true); if (!id) return blob;
      const s = readVint(head, q + id.len, false); if (!s) return blob;
      const dataAt = q + id.len + s.len;
      if (id.v === 0x4489) return blob;                       // 既に Duration がある
      if (id.v === 0x2AD7B1) { let v = 0; for (let k = 0; k < s.v; k++) v = v * 256 + head[dataAt + k]; scale = v; }
      q = dataAt + s.v;
    }
    const dur = new Uint8Array(11);
    dur.set([0x44, 0x89, 0x88]);                              // ID, サイズ=8
    new DataView(dur.buffer).setFloat64(3, durationSec * 1e9 / scale);
    const newSize = sz.v + dur.length;
    const sizeBytes = new Uint8Array(8);                      // 8バイト長の vint で書く
    sizeBytes[0] = 0x01; let rest = newSize;
    for (let k = 7; k >= 1; k--) { sizeBytes[k] = rest & 0xff; rest = Math.floor(rest / 256); }
    return new Blob([
      head.slice(0, p + 4), sizeBytes, head.slice(bodyStart, bodyEnd), dur, blob.slice(bodyEnd),
    ], { type: blob.type });
  } catch (e) { return blob; }
}
