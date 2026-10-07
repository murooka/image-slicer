import { BINS } from "./features";
import type { Features, ScoreParams } from "./types";

export const DEFAULT_SCORE_PARAMS: ScoreParams = {
  bandSize: 24,
  wBand: 1,
  wEdge: 0.5,
  wFlat: 1,
};

/**
 * 各行の「分割ラインとしての適性」を計算する。
 * scores[y] は行 y-1 と行 y の間で切る場合のスコア（y = 1..height-1 が有効、scores[0] は 0）。
 *
 * - band: 上下 bandSize 行ずつの色分布の差。背景色が切り替わるセクション境界で高くなる
 * - edge: 直上の行からの色の変化。境界がはっきりしているほど高くなる
 * - flat: 境界を挟む 2 行が均一かどうか。文字や写真を横切る位置では低くなる
 */
export function computeScores(f: Features, p: ScoreParams): Float32Array {
  const { width: W, height: H, prefixHist: P, edge, busy } = f;
  const scores = new Float32Array(H);
  const bandSize = Math.max(1, Math.floor(p.bandSize));

  for (let y = 1; y < H; y++) {
    const k = Math.min(bandSize, y, H - y);
    const a = (y - k) * BINS;
    const m = y * BINS;
    const c = (y + k) * BINS;
    let dist = 0;
    for (let b = 0; b < BINS; b++) {
      const up = P[m + b] - P[a + b];
      const down = P[c + b] - P[m + b];
      dist += Math.abs(up - down);
    }
    const band = dist / (2 * k * W);
    const flat = 1 - Math.max(busy[y - 1], busy[y]);
    scores[y] = p.wBand * band + p.wEdge * edge[y] + p.wFlat * flat;
  }
  return scores;
}
