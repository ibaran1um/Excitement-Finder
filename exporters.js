// 目次・CSV・ffmpegスクリプトの生成
import { fmtChapter, fmtHMS, fmtFileTime, pad2, baseName, extName } from "./util.js";

/**
 * YouTube の目次。YouTube ヘルプに記載の条件
 * （最初は 0:00、3つ以上を昇順、各チャプター10秒以上）を満たしているか確認する。
 */
export function buildChapters(clips, dur, firstTitle) {
  const longVideo = dur >= 3600;
  const items = clips.slice().sort((a, b) => a.start - b.start)
    .map(c => ({ t: Math.floor(c.start), title: (c.memo || "").trim() || `候補${c.label}` }));
  if (!items.length) return { text: "", warnings: ["採用した候補がありません。候補の「採用」を押すと目次に入ります。"] };
  if (items[0].t < 10) items[0].t = 0;
  else items.unshift({ t: 0, title: firstTitle.trim() || "オープニング" });
  const warnings = [];
  if (items.length < 3) warnings.push(`チャプターが${items.length}個です。YouTubeで目次として表示されるには3個以上必要です。`);
  for (let i = 0; i < items.length; i++) {
    const next = i + 1 < items.length ? items[i + 1].t : Math.floor(dur);
    if (next - items[i].t < 10) warnings.push(`「${fmtChapter(items[i].t, longVideo)} ${items[i].title}」が10秒未満です。YouTubeでは各チャプター10秒以上が必要です。`);
  }
  const text = items.map(it => `${fmtChapter(it.t, longVideo)} ${it.title}`).join("\n");
  return { text, warnings };
}

const csvCell = v => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const STATUS = { new: "未判定", adopted: "採用", rejected: "不採用" };

/** Excel で文字化けしないよう UTF-8 の BOM 付き */
export function buildCSV(clips) {
  const head = ["番号", "判定", "開始", "終了", "長さ(秒)", "開始(秒)", "終了(秒)", "総合スコア", "音量(dB)", "声の帯域(dB)", "持続(秒)", "手動追加", "メモ"];
  const rows = clips.slice().sort((a, b) => a.start - b.start).map(c => [
    c.label, STATUS[c.status], fmtHMS(c.start), fmtHMS(c.end), (c.end - c.start).toFixed(1),
    c.start.toFixed(2), c.end.toFixed(2),
    c.manual ? "" : c.score.toFixed(1), c.manual ? "" : c.parts.all.toFixed(1), c.manual ? "" : c.parts.voice.toFixed(1), c.manual ? "" : c.parts.sus.toFixed(1),
    c.manual ? "はい" : "", c.memo || "",
  ]);
  const body = [head, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
  return new Blob(["\uFEFF" + body + "\r\n"], { type: "text/csv;charset=utf-8" });
}

const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const batQuote = s => `"${String(s).replace(/%/g, "%%").replace(/"/g, "")}"`;

/**
 * ffmpeg の切り抜きスクリプト
 * mode: "copy"（再エンコードしない）| "encode"（libx264 + AAC で再エンコード）
 * vertical: true なら中央付近を 9:16 で切り取り 1080x1920 に（cropX: 0=左端, 1=右端）
 */
export function buildFfmpegScript(clips, { fileName, os, mode, vertical, cropX }) {
  if (vertical) mode = "encode";
  const inExt = extName(fileName) || "mp4";
  const outExt = mode === "copy" ? inExt : "mp4";
  const sorted = clips.slice().sort((a, b) => a.start - b.start);
  const lines = sorted.map((c, i) => {
    const out = `clips/${pad2(i + 1)}_${fmtFileTime(c.start)}.${outExt}`;
    const ss = c.start.toFixed(3), t = (c.end - c.start).toFixed(3);
    let codec = mode === "copy" ? ["-c", "copy"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
    const vf = vertical
      ? ["-vf", `crop=trunc(ih*9/16/2)*2:ih:trunc((iw-ih*9/16)*${cropX.toFixed(3)}/2)*2:0,scale=1080:1920`]
      : [];
    return { ss, t, out, codec, vf, memo: (c.memo || "").replace(/[\r\n]/g, " ") };
  });
  const title = `盛り上がりファインダーで作成（${sorted.length}件、${mode === "copy" ? "無劣化" : "再エンコード"}${vertical ? "、縦型" : ""}）`;
  if (os === "sh") {
    const body = lines.map(l =>
      `# ${l.memo || "-"}\nffmpeg -hide_banner -y -ss ${l.ss} -i "$IN" -t ${l.t} ${[...l.vf.map((v, k) => k ? shQuote(v) : v), ...l.codec].join(" ")} ${shQuote(l.out)}`
    ).join("\n");
    return new Blob([
      `#!/bin/sh\n# ${title}\n# 使い方: 動画と同じフォルダに置き、sh このファイル名 で実行してください（ffmpegが必要です）。\nset -e\ncd "$(dirname "$0")"\nIN=${shQuote(fileName)}\nmkdir -p clips\n${body}\necho "完了しました: clips フォルダを確認してください"\n`
    ], { type: "text/x-sh" });
  }
  const body = lines.map(l =>
    `rem ${l.memo.replace(/[&|<>^%]/g, "") || "-"}\r\nffmpeg -hide_banner -y -ss ${l.ss} -i ${batQuote(fileName)} -t ${l.t} ${[...l.vf.map((v, k) => k ? `"${v}"` : v), ...l.codec].join(" ")} ${batQuote(l.out.replace(/\//g, "\\"))}\r\nif errorlevel 1 goto failed`
  ).join("\r\n");
  return new Blob([
    `@echo off\r\nchcp 65001 > nul\r\nrem ${title}\r\nrem 使い方: 動画と同じフォルダに置き、ダブルクリックで実行してください（ffmpegが必要です）。\r\ncd /d "%~dp0"\r\nif not exist clips mkdir clips\r\n${body}\r\necho 完了しました: clips フォルダを確認してください\r\npause\r\nexit /b 0\r\n:failed\r\necho エラーが発生しました。上のメッセージを確認してください。\r\npause\r\nexit /b 1\r\n`
  ], { type: "application/x-bat" });
}

export const scriptName = (fileName, os) => `${baseName(fileName)}_切り抜き.${os === "sh" ? "sh" : "bat"}`;
