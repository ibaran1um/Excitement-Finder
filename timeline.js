// タイムライン（拡大表示＋全体表示）
import { fmtHMS, clamp } from "./util.js";

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const HANDLE = 7;     // 端をつかめる幅(px)
const BAND_TOP = 18;  // 目盛りの下から候補の帯を描く

export class Timeline {
  constructor(detail, overview, host) {
    this.c = detail; this.o = overview; this.h = host;
    this.v0 = 0; this.v1 = 1; this.hoverX = null; this.drag = null; this.raf = 0;
    this._bind();
    new ResizeObserver(() => this.draw()).observe(detail);
  }
  get dur() { return this.h.state().dur || 1; }
  fit() { this.v0 = 0; this.v1 = this.dur; this.draw(); }
  setView(a, b) {
    const d = this.dur, minSpan = Math.min(d, 10);
    let span = clamp(b - a, minSpan, d);
    a = clamp(a, 0, d - span);
    this.v0 = a; this.v1 = a + span; this.draw();
  }
  zoom(f, anchor) {
    const span = this.v1 - this.v0;
    anchor = anchor ?? (this.v0 + this.v1) / 2;
    const r = (anchor - this.v0) / span, ns = span * f;
    this.setView(anchor - r * ns, anchor - r * ns + ns);
  }
  focus(a, b) { const pad = Math.max(5, (b - a) * 0.4); this.setView(a - pad, b + pad); }
  ensureVisible(t) {
    const span = this.v1 - this.v0;
    if (t < this.v0 || t > this.v1) this.setView(t - span * 0.2, t + span * 0.8);
  }
  request() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }

  // ---- 座標変換 ----
  x2t(x) { return this.v0 + x / this.c.clientWidth * (this.v1 - this.v0); }
  t2x(t) { return (t - this.v0) / (this.v1 - this.v0) * this.c.clientWidth; }

  hitHandle(x) {
    const { cands } = this.h.state();
    let best = null, bd = HANDLE;
    for (const c of cands) {
      for (const edge of ["start", "end"]) {
        const d = Math.abs(this.t2x(c[edge]) - x);
        if (d <= bd) { bd = d; best = { c, edge }; }
      }
    }
    return best;
  }
  hitBand(x) {
    const t = this.x2t(x), { cands } = this.h.state();
    const hits = cands.filter(c => t >= c.start && t <= c.end);
    return hits.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || null;
  }

  _bind() {
    const c = this.c, o = this.o;
    const px = e => e.clientX - c.getBoundingClientRect().left;
    c.addEventListener("wheel", e => {
      if (!this.h.state().an) return;
      e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const span = this.v1 - this.v0, d = (e.deltaX || e.deltaY) / c.clientWidth * span;
        this.setView(this.v0 + d, this.v1 + d);
      } else this.zoom(e.deltaY > 0 ? 1.25 : 0.8, this.x2t(px(e)));
    }, { passive: false });
    c.addEventListener("pointerdown", e => {
      if (!this.h.state().an) return;
      const x = px(e), hh = this.hitHandle(x);
      c.setPointerCapture(e.pointerId);
      this.drag = hh ? { kind: "edge", ...hh, moved: false }
                     : { kind: "pan", x0: x, v0: this.v0, v1: this.v1, moved: false };
    });
    c.addEventListener("pointermove", e => {
      if (!this.h.state().an) return;
      const x = px(e);
      this.hoverX = x;
      const d = this.drag;
      if (d && d.kind === "edge") {
        d.moved = true;
        const t = clamp(this.x2t(x), 0, this.dur);
        const cand = d.c;
        if (d.edge === "start") cand.start = Math.min(t, cand.end - 1);
        else cand.end = Math.max(t, cand.start + 1);
        this.h.onEdgeDrag(cand, false);
      } else if (d && d.kind === "pan") {
        if (Math.abs(x - d.x0) > 4) d.moved = true;
        if (d.moved) {
          const dt = (d.x0 - x) / c.clientWidth * (d.v1 - d.v0);
          this.setView(d.v0 + dt, d.v1 + dt);
        }
      }
      c.style.cursor = d ? (d.kind === "edge" ? "ew-resize" : d.moved ? "grabbing" : "crosshair")
                         : (this.hitHandle(x) ? "ew-resize" : "crosshair");
      this.request();
    });
    const end = e => {
      const d = this.drag; this.drag = null;
      if (!d) return;
      const x = px(e);
      if (d.kind === "edge") { this.h.onEdgeDrag(d.c, true); return; }
      if (!d.moved) {
        const band = this.hitBand(x);
        if (band) this.h.select(band.id, false);
        this.h.seek(clamp(this.x2t(x), 0, this.dur));
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", () => { this.drag = null; });
    c.addEventListener("pointerleave", () => { this.hoverX = null; this.request(); });

    // 全体表示: クリック・ドラッグで表示範囲を移動
    let ovDrag = false;
    const ovMove = e => {
      const r = o.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * this.dur;
      const span = this.v1 - this.v0;
      this.setView(t - span / 2, t + span / 2);
    };
    o.addEventListener("pointerdown", e => { if (!this.h.state().an) return; ovDrag = true; o.setPointerCapture(e.pointerId); ovMove(e); });
    o.addEventListener("pointermove", e => { if (ovDrag) ovMove(e); });
    o.addEventListener("pointerup", () => { ovDrag = false; });
  }

  _prep(cv) {
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    return { g, W, H };
  }

  /** 表示範囲内を画素ごとに最大値でまとめる */
  _columns(arr, a, b, cols) {
    const { an } = this.h.state(), hop = an.hop, out = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      const i0 = Math.floor((a + (b - a) * x / cols) / hop), i1 = Math.max(i0 + 1, Math.floor((a + (b - a) * (x + 1) / cols) / hop));
      let m = -Infinity;
      for (let i = Math.max(0, i0); i < Math.min(an.n, i1); i++) if (arr[i] > m) m = arr[i];
      out[x] = m === -Infinity ? an.floor : m;
    }
    return out;
  }

  draw() {
    this._drawDetail(); this._drawOverview();
  }

  _drawDetail() {
    const { g, W, H } = this._prep(this.c);
    const st = this.h.state(), an = st.an;
    const line = css("--line"), muted = css("--muted");
    if (!an) return;
    const a = this.v0, b = this.v1, span = b - a;
    // 目盛り
    let step = STEPS.find(s => W / (span / s) >= 90) || 7200;
    g.font = "11px system-ui, sans-serif"; g.fillStyle = muted; g.strokeStyle = line; g.lineWidth = 1; g.textAlign = "left";
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
      const x = Math.round(this.t2x(t)) + .5;
      g.beginPath(); g.moveTo(x, BAND_TOP - 4); g.lineTo(x, H); g.stroke();
      g.fillText(fmtHMS(t), x + 3, 11);
    }
    // 候補の帯
    const top = BAND_TOP, bh = H - top;
    for (const c of st.cands) {
      if (c.end < a || c.start > b) continue;
      const x0 = this.t2x(c.start), x1 = this.t2x(c.end);
      g.fillStyle = c.status === "adopted" ? css("--adopt") : c.status === "rejected" ? css("--reject") : css("--cand");
      g.fillRect(x0, top, Math.max(1, x1 - x0), bh);
      const edge = c.status === "adopted" ? css("--adopt-edge") : c.status === "rejected" ? muted : css("--cand-edge");
      g.fillStyle = edge;
      const wEdge = c.id === st.activeId ? 3 : 1.5;
      g.fillRect(x0, top, wEdge, bh); g.fillRect(x1 - wEdge, top, wEdge, bh);
      if (c.id === st.activeId) { g.fillRect(x0, top, x1 - x0, 3); }
      g.font = "bold 11px system-ui, sans-serif"; g.textAlign = "left";
      const label = c.manual ? "手動" : "#" + st.rankOf(c);
      if (x1 - x0 > 26) g.fillText(label, x0 + 5, top + 15);
    }
    // 波形
    const cols = Math.max(1, Math.floor(W));
    const fl = an.floor;
    const hi = Math.ceil(an.maxAll + 3), lo = Math.max(fl, hi - 60);
    const y = v => H - 3 - (clamp(v, lo, hi) - lo) / (hi - lo) * (bh - 24);
    const all = this._columns(an.dbAll, a, b, cols), voice = this._columns(an.dbVoice, a, b, cols), base = this._columns(an.baseAll, a, b, cols);
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x < cols; x++) g.lineTo(x + .5, y(all[x]));
    g.lineTo(W, H); g.closePath(); g.fillStyle = css("--all-fill"); g.fill();
    const path = (arr, color, wdt, dash) => {
      g.beginPath(); for (let x = 0; x < cols; x++) { const yy = y(arr[x]); x ? g.lineTo(x + .5, yy) : g.moveTo(x + .5, yy); }
      g.strokeStyle = color; g.lineWidth = wdt; g.setLineDash(dash || []); g.stroke(); g.setLineDash([]);
    };
    path(all, css("--all"), 1.2);
    path(voice, css("--voice"), 1.2);
    path(base, css("--base"), 1.5, [5, 4]);
    // 再生位置・カーソル
    const px = Math.round(this.t2x(st.time)) + .5;
    if (px >= 0 && px <= W) { g.strokeStyle = css("--head"); g.lineWidth = 2; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); }
    if (this.hoverX !== null) {
      const hx = Math.round(this.hoverX) + .5;
      g.strokeStyle = muted; g.lineWidth = 1; g.beginPath(); g.moveTo(hx, BAND_TOP); g.lineTo(hx, H); g.stroke();
      const label = fmtHMS(this.x2t(this.hoverX)), tw = g.measureText(label).width + 10;
      const lx = clamp(hx + 6, 0, W - tw);
      g.fillStyle = css("--surface"); g.fillRect(lx, BAND_TOP + 2, tw, 18);
      g.fillStyle = css("--text"); g.font = "12px system-ui, sans-serif"; g.fillText(label, lx + 5, BAND_TOP + 15);
    }
  }

  _drawOverview() {
    const { g, W, H } = this._prep(this.o);
    const st = this.h.state(), an = st.an;
    if (!an) return;
    const d = st.dur, cols = Math.max(1, Math.floor(W));
    const all = this._columns(an.dbAll, 0, d, cols);
    let mx = -Infinity; for (const v of all) if (v > mx) mx = v;
    const lo = Math.max(an.floor, mx - 50);
    g.fillStyle = css("--all");
    g.globalAlpha = .55;
    for (let x = 0; x < cols; x++) { const h = (clamp(all[x], lo, mx) - lo) / (mx - lo || 1) * (H - 6); g.fillRect(x, H - h, 1, h); }
    g.globalAlpha = 1;
    for (const c of st.cands) {
      g.fillStyle = c.status === "adopted" ? css("--adopt-edge") : c.status === "rejected" ? css("--muted") : css("--cand-edge");
      g.fillRect(c.t / d * W - 1, 0, 2, 7);
    }
    const x0 = this.v0 / d * W, x1 = this.v1 / d * W;
    g.strokeStyle = css("--text"); g.lineWidth = 1.5; g.strokeRect(x0 + .75, .75, Math.max(3, x1 - x0) - 1.5, H - 1.5);
    g.fillStyle = css("--head"); g.fillRect(st.time / d * W - 1, 0, 2, H);
  }
}
