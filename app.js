// 盛り上がりファインダー 本体
import { fmtHMS, fmtClock, fmtLen, fmtFileTime, clamp, download, baseName, pad2 } from "./util.js";
import { detect, isTouched } from "./detect.js";
import { Timeline } from "./timeline.js";
import { buildChapters, buildCSV, buildFfmpegScript, scriptName } from "./exporters.js";
import { ClipRecorder, supportedFormats, layout } from "./recorder.js";

const APP = "moriagari-finder", VERSION = 1, SR = 8000;
const $ = id => document.getElementById(id);

const S = {
  file: null, url: null, dur: 0, an: null,
  cands: [], seq: 0, activeId: null,
  filter: "all", sort: "score",
  settings: { mode: "talk", sens: 6, minGap: 45, pre: 20, post: 10, max: 20 },
  clip: null,          // { id, loop } 候補範囲の再生中
  queue: null,         // 通し再生中の候補ID配列
  recording: false,
};
let video = null, tl = null, recorder = null;

/* ================= 共通 ================= */
const byId = id => S.cands.find(c => c.id === id);
const active = () => byId(S.activeId);
const nextId = () => ++S.seq;
function ranked() {
  return S.cands.filter(c => !c.manual).sort((a, b) => b.score - a.score);
}
function rankOf(c) { return c.manual ? null : ranked().indexOf(c) + 1; }
function labelOf(c) { return c.manual ? `手動${S.cands.filter(x => x.manual).indexOf(c) + 1}` : String(rankOf(c)); }

function notice(msg, { error = false, action = null } = {}) {
  const el = $("notice");
  el.hidden = !msg; el.classList.toggle("error", error); el.textContent = msg || "";
  if (action) {
    const b = document.createElement("button"); b.className = "btn"; b.type = "button"; b.textContent = action.label;
    b.onclick = () => { action.run(); };
    el.appendChild(b);
  }
}
function progress(stage, ratio) {
  const p = $("progress");
  if (stage === null) { p.hidden = true; return; }
  p.hidden = false; $("progStage").textContent = stage;
  $("progPct").textContent = ratio == null ? "" : `${Math.round(ratio * 100)}%`;
  $("progFill").style.width = `${Math.round((ratio ?? 0) * 100)}%`;
}

/* ================= テーマ ================= */
const THEMES = ["auto", "light", "dark"], THEME_LABEL = { auto: "自動", light: "ライト", dark: "ダーク" };
let theme = "auto";
try { theme = localStorage.getItem("mf-theme") || "auto"; } catch (e) {}
function applyTheme() {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  $("themeBtn").textContent = "テーマ: " + THEME_LABEL[theme];
  tl && tl.draw();
}
$("themeBtn").onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; try { localStorage.setItem("mf-theme", theme); } catch (e) {} applyTheme(); };
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => tl && tl.draw());

/* ================= 読み込みと解析 ================= */
$("fileIn").addEventListener("change", e => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ""; });
const drop = $("drop");
["dragenter", "dragover"].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === "drop" || e.target === drop) drop.classList.remove("over"); }));
document.addEventListener("drop", e => {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (!f) return;
  if (/\.json$/i.test(f.name)) loadProject(f); else openFile(f);
});

async function openFile(file) {
  if (S.recording) { notice("書き出し中は別の動画を開けません。", { error: true }); return; }
  stopClip();
  if (S.url) URL.revokeObjectURL(S.url);
  if (recorder) { recorder.dispose(); recorder = null; }
  Object.assign(S, { file, url: URL.createObjectURL(file), dur: 0, an: null, cands: [], seq: 0, activeId: null });
  $("empty").hidden = true; $("work").hidden = false;
  $("saveProj").disabled = true; $("projIn").disabled = true; $("loadProjLabel").setAttribute("aria-disabled", "true");
  notice("");
  // プレイヤー
  const player = $("player"); player.innerHTML = "";
  video = document.createElement("video");
  video.controls = true; video.preload = "auto"; video.playsInline = true; video.src = S.url;
  video.addEventListener("error", () => notice("このブラウザではこの動画を再生できません。解析と目次・CSV・ffmpegスクリプトの作成は使えます。", { error: true }));
  video.addEventListener("seeking", () => { if (!internalSeek && S.clip) { const c = byId(S.clip.id); if (c && (video.currentTime < c.start - 0.5 || video.currentTime > c.end + 0.5)) stopClip(); } internalSeek = false; });
  video.addEventListener("play", tick);
  video.addEventListener("seeked", () => { tl && tl.request(); updateCropPreview(); });
  video.addEventListener("timeupdate", () => { $("clock").textContent = fmtClock(video.currentTime); if (video.paused) tl.request(); });
  video.addEventListener("loadeddata", updateCropPreview);
  player.appendChild(video);
  renderList(); tl.draw();

  const t0 = performance.now();
  try {
    progress(`「${file.name}」を読み込んでいます`, null);
    let result, fallbackReason = null;
    try {
      // まずはファイルを少しずつ読む方式（長時間でもメモリをほとんど使わない）
      result = await runWorker({ kind: "file", file });
    } catch (e) {
      fallbackReason = e.message;
      console.info("分割読み込みを使えないため、全体を読み込む方式に切り替えます:", e.message);
      progress("音声を取り出しています（この形式はファイル全体を読み込むため、長い動画では時間とメモリを多く使います）", null);
      const buf = await file.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, SR);
      const audio = await ctx.decodeAudioData(buf);
      const n = audio.length, ch = audio.numberOfChannels, pcm = new Float32Array(n);
      for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) pcm[i] += d[i] / ch; }
      result = await runWorker({ kind: "pcm", pcm, sampleRate: audio.sampleRate }, [pcm.buffer]);
    }
    const an = { ...result, n: result.dbAll.length };
    if (video && video.readyState < 1) await new Promise(r => { video.addEventListener("loadedmetadata", r, { once: true }); video.addEventListener("error", r, { once: true }); setTimeout(r, 3000); });
    const vdur = video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const audioDur = an.n * an.hop;
    const fileDur = vdur || audioDur;
    an.dur = fileDur;
    an.maxAll = an.dbAll.reduce((m, v) => v > m ? v : m, -Infinity);
    S.an = an; S.dur = fileDur;
    S.method = result.method;
    progress(null);
    const restored = restoreAutosave();
    if (!restored) redetect();
    tl.fit();
    syncSettingsUI();
    $("saveProj").disabled = false; $("projIn").disabled = false; $("loadProjLabel").removeAttribute("aria-disabled");
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (restored) notice(`前回の作業内容を復元しました（長さ ${fmtHMS(S.dur)}、解析 ${secs}秒）。`, { action: { label: "破棄して検出し直す", run: () => { clearAutosave(); S.cands = []; redetect(); notice("検出し直しました。"); } } });
    else notice(`解析が終わりました（長さ ${fmtHMS(S.dur)}、解析 ${secs}秒）。候補を選んで再生し、「採用」「不採用」を付けていきましょう。`);
    if (S.cands.length) select(sortedView()[0].id, false);
    updateExports();
  } catch (err) {
    console.error(err);
    progress(null);
    notice(`音声を取り出せませんでした。ファイルが大きすぎるか、このブラウザが対応していない形式の可能性があります。音声だけを書き出したファイル（m4a・mp3・wav など）でもお試しください。（詳細: ${err && err.message || err}）`, { error: true });
  }
}

function runWorker(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./analyzer-worker.js", import.meta.url), { type: "module" });
    w.onmessage = e => {
      const m = e.data;
      if (m.type === "progress") progress(m.stage, m.ratio);
      else if (m.type === "done") { w.terminate(); resolve(m); }
      else if (m.type === "error") { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = e => { w.terminate(); reject(new Error(e.message || "解析中にエラーが発生しました")); };
    w.postMessage(msg, transfer);
  });
}

/* ================= 検出 ================= */
function redetect() {
  if (!S.an) return;
  const keep = S.cands.filter(isTouched);
  S.cands = detect({ ...S.an, dur: S.dur }, S.settings, keep, nextId);
  if (!byId(S.activeId)) S.activeId = null;
  renderList(); tl.draw(); updateExports(); autosave();
}

const SLIDERS = [
  ["sens", "sens", v => `+${(+v).toFixed(1)} dB`],
  ["gap", "minGap", v => fmtLen(+v)],
  ["pre", "pre", v => fmtLen(+v)],
  ["post", "post", v => fmtLen(+v)],
  ["max", "max", v => `${v} 件`],
];
let detTimer = 0;
for (const [id, key, f] of SLIDERS) {
  const el = $("s-" + id);
  el.addEventListener("input", () => {
    S.settings[key] = +el.value; $("o-" + id).textContent = f(el.value);
    clearTimeout(detTimer); detTimer = setTimeout(redetect, 120);
  });
}
document.querySelectorAll("input[name=mode]").forEach(r => r.addEventListener("change", () => { S.settings.mode = r.value; redetect(); }));
function syncSettingsUI() {
  for (const [id, key, f] of SLIDERS) { $("s-" + id).value = S.settings[key]; $("o-" + id).textContent = f(S.settings[key]); }
  document.querySelectorAll("input[name=mode]").forEach(r => { r.checked = r.value === S.settings.mode; });
}
syncSettingsUI();

/* ================= 候補リスト ================= */
function sortedView() {
  let list = S.cands.slice();
  if (S.filter !== "all") list = list.filter(c => c.status === S.filter);
  if (S.sort === "time") list.sort((a, b) => a.start - b.start);
  else list.sort((a, b) => (b.manual ? -1 : b.score) - (a.manual ? -1 : a.score) || a.start - b.start);
  return list;
}

function renderList() {
  const ol = $("candList"); ol.innerHTML = "";
  const counts = { adopted: 0, new: 0, rejected: 0 };
  S.cands.forEach(c => counts[c.status]++);
  $("candCount").textContent = S.cands.length ? `${S.cands.length}件（採用 ${counts.adopted}・未判定 ${counts.new}・不採用 ${counts.rejected}）` : "";
  const list = sortedView();
  if (!list.length) {
    const li = document.createElement("li"); li.className = "list-empty";
    li.textContent = !S.an ? "動画を開くと候補がここに並びます。"
      : S.filter !== "all" ? "この条件に当てはまる候補はありません。"
      : "候補が見つかりませんでした。「検出の設定」で感度の値を下げるか、配信の種類を変えてみてください。";
    ol.appendChild(li); return;
  }
  for (const c of list) ol.appendChild(candItem(c));
}

function candItem(c) {
  const li = document.createElement("li");
  li.className = `cand ${c.status}` + (c.id === S.activeId ? " active" : "");
  li.dataset.id = c.id;
  const row = document.createElement("div"); row.className = "c-row";
  const rank = document.createElement("span"); rank.className = "c-rank"; rank.textContent = c.manual ? "手動" : `#${rankOf(c)}`;
  const range = document.createElement("button"); range.type = "button"; range.className = "c-range";
  range.setAttribute("aria-label", `候補${labelOf(c)}（${fmtHMS(c.start)}から）を再生`); range.textContent = `${fmtHMS(c.start)} – ${fmtHMS(c.end)}`;
  const len = document.createElement("span"); len.className = "c-len"; len.textContent = fmtLen(c.end - c.start);
  const judge = document.createElement("div"); judge.className = "c-judge";
  const yes = document.createElement("button"); yes.type = "button"; yes.className = "yes"; yes.textContent = "採用";
  yes.setAttribute("aria-pressed", c.status === "adopted"); yes.setAttribute("aria-label", `候補${labelOf(c)}を採用`);
  yes.onclick = e => { e.stopPropagation(); setStatus(c, c.status === "adopted" ? "new" : "adopted"); };
  const no = document.createElement("button"); no.type = "button"; no.className = "no"; no.textContent = "不採用";
  no.setAttribute("aria-pressed", c.status === "rejected"); no.setAttribute("aria-label", `候補${labelOf(c)}を不採用`);
  no.onclick = e => { e.stopPropagation(); setStatus(c, c.status === "rejected" ? "new" : "rejected"); };
  judge.append(yes, no);
  row.append(rank, range, len, judge);
  li.appendChild(row);

  if (!c.manual) {
    const parts = document.createElement("div"); parts.className = "c-parts";
    parts.innerHTML = `<span>総合 <b>${c.score.toFixed(1)}</b></span><span>音量 +${c.parts.all.toFixed(1)}dB</span><span>声 +${c.parts.voice.toFixed(1)}dB</span><span>持続 ${c.parts.sus.toFixed(1)}秒</span>`;
    li.appendChild(parts);
  } else {
    const parts = document.createElement("div"); parts.className = "c-parts"; parts.textContent = "手動で追加した候補";
    li.appendChild(parts);
  }
  const memo = document.createElement("input"); memo.type = "text"; memo.className = "c-memo";
  memo.placeholder = "メモ（目次のタイトルになります）"; memo.value = c.memo || "";
  memo.setAttribute("aria-label", `候補${labelOf(c)}のメモ`);
  memo.addEventListener("click", e => e.stopPropagation());
  memo.addEventListener("input", () => { c.memo = memo.value; updateExports(); autosave(); });
  li.appendChild(memo);

  if (c.id === S.activeId) {
    const ed = document.createElement("div"); ed.className = "c-edit";
    const mk = (label, fn, cls) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn " + (cls || ""); b.textContent = label; b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
    const nudge = (edge, d) => () => {
      if (edge === "start") c.start = clamp(c.start + d, 0, c.end - 1); else c.end = clamp(c.end + d, c.start + 1, S.dur);
      c.edited = true; refreshAfterEdit(c);
    };
    const s = document.createElement("span"); s.textContent = "開始";
    const e2 = document.createElement("span"); e2.textContent = "終了";
    ed.append(s, mk("−1秒", nudge("start", -1)), mk("+1秒", nudge("start", 1)), e2, mk("−1秒", nudge("end", -1)), mk("+1秒", nudge("end", 1)), mk("削除", () => removeCand(c), "del"));
    li.appendChild(ed);
  }
  li.addEventListener("click", () => { select(c.id, true); playClip(c); });
  return li;
}

function refreshAfterEdit(c) {
  renderList(); tl.draw(); updateExports(); autosave();
  const li = $("candList").querySelector(`[data-id="${c.id}"]`); if (li) li.scrollIntoView({ block: "nearest" });
}
function setStatus(c, st) { c.status = st; refreshAfterEdit(c); }
function removeCand(c) {
  const list = sortedView(), i = list.indexOf(c);
  S.cands = S.cands.filter(x => x !== c);
  if (S.clip && S.clip.id === c.id) stopClip();
  const nxt = list[i + 1] || list[i - 1];
  S.activeId = nxt ? nxt.id : null;
  renderList(); tl.draw(); updateExports(); autosave();
}
function select(id, scroll) {
  S.activeId = id;
  renderList(); tl.draw(); updateCropPreview();
  const c = byId(id); if (c) tl.ensureVisible(c.start);
  if (scroll) { const li = $("candList").querySelector(`[data-id="${id}"]`); if (li) li.scrollIntoView({ block: "nearest" }); }
}

document.querySelectorAll(".filters button").forEach(b => b.addEventListener("click", () => {
  S.filter = b.dataset.filter;
  document.querySelectorAll(".filters button").forEach(x => x.setAttribute("aria-pressed", x === b));
  renderList();
}));
$("sortSel").addEventListener("change", e => { S.sort = e.target.value; renderList(); });

/* ================= 再生 ================= */
let internalSeek = false;
function seek(t) { if (!video) return; internalSeek = true; video.currentTime = clamp(t, 0, S.dur || video.duration || 0); tl.request(); }
function playClip(c, loop) {
  if (!video || !c) return;
  S.clip = { id: c.id, loop: loop ?? $("loopBtn").getAttribute("aria-pressed") === "true" };
  seek(c.start); video.play().catch(() => {});
}
function stopClip() { S.clip = null; S.queue = null; $("queueBtn").setAttribute("aria-pressed", "false"); }
function tick() {
  if (!video) return;
  $("clock").textContent = fmtClock(video.currentTime);
  if (S.clip) {
    const c = byId(S.clip.id);
    if (!c) stopClip();
    else if (video.currentTime >= c.end) {
      if (S.clip.loop) seek(c.start);
      else if (S.queue && S.queue.length) { const id = S.queue.shift(); select(id, true); S.clip.id = id; seek(byId(id).start); }
      else { video.pause(); stopClip(); }
    }
  }
  tl.draw();
  if (!video.paused) requestAnimationFrame(tick);
}
$("playClipBtn").onclick = () => { const c = active(); if (c) playClip(c); };
$("loopBtn").onclick = () => {
  const on = $("loopBtn").getAttribute("aria-pressed") !== "true";
  $("loopBtn").setAttribute("aria-pressed", on);
  if (S.clip) S.clip.loop = on;
};
$("queueBtn").onclick = () => {
  const ids = S.cands.filter(c => c.status === "adopted").sort((a, b) => a.start - b.start).map(c => c.id);
  if (!ids.length) { notice("採用した候補がありません。"); return; }
  const first = ids.shift();
  select(first, true); playClip(byId(first), false);
  S.queue = ids; $("queueBtn").setAttribute("aria-pressed", "true");
};
function step(dir) {
  if (!video || !S.cands.length) return;
  const list = S.cands.slice().sort((a, b) => a.start - b.start);
  const ref = active() ? active().start : video.currentTime;
  const c = dir > 0 ? list.find(x => x.start > ref + 0.01) : [...list].reverse().find(x => x.start < ref - 0.01);
  if (c) { select(c.id, true); playClip(c); }
}
$("nextBtn").onclick = () => step(1);
$("prevBtn").onclick = () => step(-1);

function addAtPlayhead() {
  if (!video || !S.an) return;
  const t = video.currentTime;
  const c = { id: nextId(), t, start: Math.max(0, t - S.settings.pre), end: Math.min(S.dur, t + S.settings.post), score: 0, parts: { all: 0, voice: 0, sus: 0 }, memo: "", status: "new", manual: true, edited: false };
  S.cands.push(c); select(c.id, true); updateExports(); autosave();
}
function setEdge(edge) {
  const c = active(); if (!c || !video) return;
  const t = video.currentTime;
  if (edge === "start") { if (t >= c.end - 1) { notice("開始は終了より1秒以上前にしてください。", { error: true }); return; } c.start = t; }
  else { if (t <= c.start + 1) { notice("終了は開始より1秒以上後にしてください。", { error: true }); return; } c.end = t; }
  c.edited = true; refreshAfterEdit(c);
}
$("addBtn").onclick = addAtPlayhead;
$("setInBtn").onclick = () => setEdge("start");
$("setOutBtn").onclick = () => setEdge("end");

/* ================= タイムライン ================= */
tl = new Timeline($("detail"), $("overview"), {
  state: () => ({ an: S.an, dur: S.dur, cands: S.cands, activeId: S.activeId, time: video ? video.currentTime : 0, rankOf }),
  seek,
  select,
  onEdgeDrag: (c, done) => { c.edited = true; tl.draw(); if (done) refreshAfterEdit(c); },
});
$("zoomIn").onclick = () => tl.zoom(0.5, video && video.currentTime);
$("zoomOut").onclick = () => tl.zoom(2, video && video.currentTime);
$("zoomFit").onclick = () => tl.fit();
$("zoomClip").onclick = () => { const c = active(); if (c) tl.focus(c.start, c.end); };

/* ================= キーボード ================= */
document.addEventListener("keydown", e => {
  if ($("help").open) return;
  if (e.target.closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!video) { if (e.key === "?") $("help").showModal(); return; }
  const k = e.key;
  const onButton = e.target.closest("button, label.btn, [role=tab]");
  if (k === " " && !onButton && e.target !== video) { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (k === "ArrowRight" || k === "ArrowLeft") {
    if (e.target === video || e.target.closest("[role=tablist]")) return;
    e.preventDefault(); seek(video.currentTime + (k === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 5));
  }
  else if (k === "n" || k === "N") step(1);
  else if (k === "p" || k === "P") step(-1);
  else if (k === "Enter" && !onButton) { const c = active(); if (c) playClip(c); }
  else if (k === "a" || k === "A") { const c = active(); if (c) setStatus(c, c.status === "adopted" ? "new" : "adopted"); }
  else if (k === "x" || k === "X") { const c = active(); if (c) setStatus(c, c.status === "rejected" ? "new" : "rejected"); }
  else if (k === "m" || k === "M") addAtPlayhead();
  else if (k === "i" || k === "I") setEdge("start");
  else if (k === "o" || k === "O") setEdge("end");
  else if (k === "l" || k === "L") $("loopBtn").click();
  else if (k === "+" || k === "=") tl.zoom(0.5, video.currentTime);
  else if (k === "-") tl.zoom(2, video.currentTime);
  else if (k === "Delete" || k === "Backspace") { const c = active(); if (c) { e.preventDefault(); removeCand(c); } }
  else if (k === "?") $("help").showModal();
});
$("helpBtn").onclick = () => $("help").showModal();

/* ================= タブ ================= */
const tabs = [...document.querySelectorAll("[role=tab]")];
function showTab(t) {
  tabs.forEach(x => { const on = x === t; x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1; $(x.getAttribute("aria-controls")).hidden = !on; });
  if (t.id === "tab-export") { updateExports(); updateCropPreview(); }
}
tabs.forEach(t => {
  t.addEventListener("click", () => showTab(t));
  t.addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = tabs.indexOf(t), n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    n.focus(); showTab(n);
  });
});

/* ================= 書き出し ================= */
function clipsFor(scope) {
  const withLabel = c => ({ ...c, label: labelOf(c) });
  if (scope === "active") return active() ? [withLabel(active())] : [];
  if (scope === "all") return S.cands.filter(c => c.status !== "rejected").map(withLabel);
  return S.cands.filter(c => c.status === "adopted").map(withLabel);
}
function updateExports() {
  if (!S.an) return;
  const { text, warnings } = buildChapters(clipsFor("adopted"), S.dur, $("firstTitle").value);
  $("chapters").value = text;
  const ul = $("chapWarn"); ul.innerHTML = "";
  warnings.forEach(w => { const li = document.createElement("li"); li.textContent = w; ul.appendChild(li); });
  $("copyChap").disabled = !text;
}
$("firstTitle").addEventListener("input", updateExports);
$("copyChap").onclick = async () => {
  const text = $("chapters").value;
  try { await navigator.clipboard.writeText(text); $("copyChapMsg").textContent = "コピーしました。"; }
  catch (e) { $("chapters").select(); $("copyChapMsg").textContent = "自動でコピーできませんでした。選択された文字を Ctrl+C（Macは⌘+C）でコピーしてください。"; }
  setTimeout(() => { $("copyChapMsg").textContent = ""; }, 4000);
};
function needClips(scope) {
  const clips = clipsFor(scope);
  if (!clips.length) notice(scope === "active" ? "候補が選択されていません。" : "対象の候補がありません。候補の「採用」を押してください。", { error: true });
  return clips;
}
$("csvBtn").onclick = () => {
  const clips = needClips($("scopeSel").value); if (!clips.length) return;
  download(buildCSV(clips), `${baseName(S.file.name)}_候補一覧.csv`);
};
$("ffBtn").onclick = () => {
  const clips = needClips($("scopeSel").value); if (!clips.length) return;
  const os = $("osSel").value;
  download(buildFfmpegScript(clips, { fileName: S.file.name, os, mode: $("cutSel").value, vertical: $("ffVertical").checked, cropX: +$("s-crop").value }), scriptName(S.file.name, os));
};

// ブラウザ書き出し
const formats = supportedFormats();
const fmtSel = $("recFmt");
if (!formats.length) {
  const o = document.createElement("option"); o.textContent = "このブラウザは非対応"; fmtSel.appendChild(o);
  fmtSel.disabled = true; $("recBtn").disabled = true;
} else formats.forEach((f, i) => { const o = document.createElement("option"); o.value = i; o.textContent = f.label; fmtSel.appendChild(o); });

$("recShape").addEventListener("change", () => { $("cropBox").hidden = $("recShape").value !== "vertical"; updateCropPreview(); });
$("s-crop").addEventListener("input", () => { updateCropPreview(); });
function updateCropPreview() {
  const v = +$("s-crop").value;
  $("o-crop").textContent = v < 0.34 ? "左寄り" : v > 0.66 ? "右寄り" : "中央付近";
  if ($("cropBox").hidden || !video || !video.videoWidth) return;
  const cv = $("cropPrev"), g = cv.getContext("2d");
  const L = layout(video.videoWidth, video.videoHeight, "vertical", v);
  g.fillStyle = "#000"; g.fillRect(0, 0, cv.width, cv.height);
  try { g.drawImage(video, L.sx, L.sy, L.sw, L.sh, 0, 0, cv.width, cv.height); } catch (e) {}
}

$("recBtn").onclick = async () => {
  const clips = needClips($("recScope").value); if (!clips.length) return;
  const fmt = formats[+fmtSel.value];
  if (!recorder) recorder = new ClipRecorder(S.url);
  recorder.cancelled = false;
  try { await recorder.prepareAudio(); } catch (e) { notice("音声の準備に失敗しました。もう一度お試しください。", { error: true }); return; }
  video && video.pause();
  S.recording = true;
  $("recBtn").disabled = true; $("recCancel").hidden = false; $("recProg").hidden = false;
  const sorted = clips.sort((a, b) => a.start - b.start);
  const total = sorted.reduce((s, c) => s + (c.end - c.start), 0);
  let done = 0, saved = 0;
  try {
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i], len = c.end - c.start;
      $("recStage").textContent = `${i + 1} / ${sorted.length} 本目を書き出しています（${fmtHMS(c.start)}〜）`;
      const blob = await recorder.record(c, { shape: $("recShape").value, cropX: +$("s-crop").value, fmt }, p => {
        const r = (done + p * len) / total;
        $("recPct").textContent = `${Math.round(r * 100)}%`; $("recFill").style.width = `${r * 100}%`;
      });
      if (!blob) break;
      done += len;
      const name = `${baseName(S.file.name)}_${pad2(i + 1)}_${fmtFileTime(c.start)}${$("recShape").value === "vertical" ? "_縦" : ""}.${fmt.ext}`;
      download(blob, name); saved++;
    }
    notice(recorder.cancelled ? `書き出しを中止しました（${saved}本保存済み）。` : `${saved}本の書き出しが終わりました。ダウンロードフォルダを確認してください。`);
  } catch (err) {
    console.error(err);
    notice(`書き出しに失敗しました（${saved}本保存済み）。詳細: ${err && err.message || err}`, { error: true });
  } finally {
    S.recording = false;
    $("recBtn").disabled = false; $("recCancel").hidden = true; $("recProg").hidden = true;
  }
};
$("recCancel").onclick = () => recorder && recorder.cancel();

/* ================= 作業の保存・復元 ================= */
const fileKey = () => S.file ? `mf:${S.file.name}:${S.file.size}` : null;
function snapshot() {
  return {
    app: APP, version: VERSION, savedAt: new Date().toISOString(),
    file: { name: S.file.name, size: S.file.size, duration: S.dur },
    settings: S.settings,
    cands: S.cands.map(({ id, t, start, end, score, parts, memo, status, manual, edited }) => ({ id, t, start, end, score, parts, memo, status, manual, edited })),
  };
}
function applySnapshot(p) {
  S.settings = { ...S.settings, ...p.settings };
  S.cands = p.cands.map(c => ({ ...c }));
  S.seq = S.cands.reduce((m, c) => Math.max(m, c.id), 0);
  S.activeId = null;
  syncSettingsUI(); renderList(); tl.draw(); updateExports();
}
let saveTimer = 0;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { if (fileKey()) localStorage.setItem(fileKey(), JSON.stringify(snapshot())); } catch (e) {} }, 400);
}
function restoreAutosave() {
  try {
    const raw = localStorage.getItem(fileKey()); if (!raw) return false;
    const p = JSON.parse(raw);
    if (p.app !== APP || Math.abs(p.file.duration - S.dur) > 1) return false;
    applySnapshot(p); return true;
  } catch (e) { return false; }
}
function clearAutosave() { try { localStorage.removeItem(fileKey()); } catch (e) {} }

$("saveProj").onclick = () => {
  const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: "application/json" });
  download(blob, `${baseName(S.file.name)}_作業.json`);
};
$("projIn").addEventListener("change", e => { const f = e.target.files[0]; if (f) loadProject(f); e.target.value = ""; });
async function loadProject(f) {
  if (!S.an) { notice("先に動画を開いてから、作業ファイルを読み込んでください。", { error: true }); return; }
  try {
    const p = JSON.parse(await f.text());
    if (p.app !== APP || !Array.isArray(p.cands)) throw new Error("盛り上がりファインダーの作業ファイルではありません");
    if (p.file && (p.file.name !== S.file.name || Math.abs(p.file.duration - S.dur) > 1)) {
      if (!confirm(`この作業ファイルは「${p.file.name}」用です。今開いている動画に読み込みますか？`)) return;
    }
    applySnapshot(p); autosave();
    notice(`作業ファイルを読み込みました（候補 ${p.cands.length}件）。`);
  } catch (err) { notice(`作業ファイルを読み込めませんでした。${err.message}`, { error: true }); }
}

window.addEventListener("beforeunload", e => { if (S.recording) { e.preventDefault(); e.returnValue = ""; } });
applyTheme();
