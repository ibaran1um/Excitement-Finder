// 時間表記などの共通処理
export const pad2 = n => String(n).padStart(2, "0");

/** 0:00:00 形式（常に時間を含む） */
export function fmtHMS(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 3600)}:${pad2(Math.floor(s % 3600 / 60))}:${pad2(s % 60)}`;
}
/** 0:00:00.0 形式 */
export function fmtClock(s) {
  s = Math.max(0, s);
  const t = Math.floor(s * 10) / 10;
  return `${fmtHMS(t)}.${Math.floor(t * 10) % 10}`;
}
/** YouTube の目次用。動画が1時間以上なら h:mm:ss、未満なら m:ss */
export function fmtChapter(s, longVideo) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return longVideo ? `${h}:${pad2(m)}:${pad2(x)}` : `${h * 60 + m}:${pad2(x)}`;
}
/** 秒数の長さ表記 */
export function fmtLen(s) {
  s = Math.round(s);
  return s >= 60 ? `${Math.floor(s / 60)}分${pad2(s % 60)}秒` : `${s}秒`;
}
/** ファイル名用 0h00m00s */
export function fmtFileTime(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 3600)}h${pad2(Math.floor(s % 3600 / 60))}m${pad2(s % 60)}s`;
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.style.display = "none";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export const baseName = name => name.replace(/\.[^.]+$/, "");
export const extName = name => (name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
