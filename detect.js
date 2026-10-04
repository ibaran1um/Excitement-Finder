// 解析結果から候補を作る
export const MODES = {
  talk:  { all: 0.4,  voice: 0.6,  sustain: 0.6, label: "雑談・実況" },
  game:  { all: 0.15, voice: 0.85, sustain: 0.6, label: "ゲーム音が大きい" },
  music: { all: 0.8,  voice: 0.2,  sustain: 0.4, label: "歌・音楽" },
};

/** 各フレームの総合スコア（基準より何dB大きいかの重み付き和） */
export function combinedScore(an, mode) {
  const w = MODES[mode] || MODES.talk;
  const { n, dbAll, dbVoice, baseAll, baseVoice } = an;
  const out = new Float32Array(n), jA = new Float32Array(n), jV = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    jA[i] = Math.max(0, dbAll[i] - baseAll[i]);
    jV[i] = Math.max(0, dbVoice[i] - baseVoice[i]);
    out[i] = w.all * jA[i] + w.voice * jV[i];
  }
  return { score: out, jA, jV };
}

/**
 * 候補の検出
 * @param keep 再検出でも残す候補（ユーザーが手を加えたもの）
 */
export function detect(an, s, keep, nextId) {
  const { n, hop, dur } = an;
  const w = MODES[s.mode] || MODES.talk;
  const { score, jA, jV } = combinedScore(an, s.mode);
  // 感度を超えている区間（1秒未満の途切れはつなげる）を1つの盛り上がりとみなす
  const bridge = Math.round(1 / hop), look = Math.round(10 / hop);
  const runs = [];
  let i = 0;
  while (i < n) {
    if (score[i] < s.sens) { i++; continue; }
    const i0 = i; let last = i;
    while (i < n && i - last <= bridge) { if (score[i] >= s.sens) last = i; i++; }
    runs.push([i0, last]);
    i = last + 1;
  }
  const peaks = runs.map(([i0, i1]) => {
    // 強さは始まりから10秒以内の最大値、持続は区間の長さ（最大8秒）
    let pk = i0;
    for (let k = i0; k <= Math.min(i1, i0 + look); k++) if (score[k] > score[pk]) pk = k;
    const susSec = Math.min(8, (i1 - i0 + 1) * hop);
    return { t: i0 * hop, peakT: pk * hop, all: jA[pk], voice: jV[pk], sus: susSec, score: score[pk] + w.sustain * susSec };
  });
  peaks.sort((a, b) => b.score - a.score);
  const chosen = [];
  const blocked = t => keep.some(k => Math.abs(k.t - t) < s.minGap) || chosen.some(c => Math.abs(c.t - t) < s.minGap);
  for (const p of peaks) {
    if (chosen.length + keep.length >= s.max) break;
    if (blocked(p.t)) continue;
    chosen.push(p);
  }
  // 範囲は「盛り上がりの始まり」を基準に前後へ広げる
  const fresh = chosen.map(p => ({
    id: nextId(), t: p.t,
    start: Math.max(0, p.t - s.pre), end: Math.min(dur, Math.max(p.peakT, p.t) + s.post),
    score: p.score, parts: { all: p.all, voice: p.voice, sus: p.sus },
    memo: "", status: "new", manual: false, edited: false,
  }));
  return [...keep, ...fresh];
}

/** ユーザーが手を加えた候補か */
export const isTouched = c => c.manual || c.edited || c.status !== "new" || (c.memo && c.memo.trim() !== "");
