import type { PlanResult, Segment, SliceParams, Zone } from "./types";

/** スコアがこの差以内なら同点とみなし、区間の中央に近い方を選ぶ */
const TIE_EPSILON = 1e-4;

export function validateParams(height: number, p: SliceParams): string | null {
  const { minHeight, maxHeight, maxCount } = p;
  if (!Number.isInteger(minHeight) || minHeight < 1) return "最小高さは 1 以上の整数で指定してください";
  if (!Number.isInteger(maxHeight) || maxHeight < 1) return "最大高さは 1 以上の整数で指定してください";
  if (!Number.isInteger(maxCount) || maxCount < 1) return "最大分割枚数は 1 以上の整数で指定してください";
  if (maxHeight < minHeight * 2) {
    return `最大高さ (${maxHeight}px) は最小高さの 2 倍 (${minHeight * 2}px) 以上にしてください`;
  }
  if (height > maxHeight && height < minHeight * 2) {
    return `画像の高さ (${height}px) では最小高さ ${minHeight}px を保って分割できません`;
  }
  const needed = Math.ceil(height / maxHeight);
  if (needed > maxCount) {
    return `高さ ${height}px を最大高さ ${maxHeight}px 以下にするには ${needed} 枚以上必要です（最大分割枚数: ${maxCount}）`;
  }
  return null;
}

/**
 * 分割位置を決める。
 *
 * 最も高い区間から順に、最小高さを保てる範囲でスコア最大の行で 2 分割する。
 * すべての区間が最大高さ以下になったら終了する。
 *
 * 最大分割枚数を守るため、各区間 h に最低限必要な枚数 ceil(h / maxHeight) の合計が
 * maxCount を超えない位置だけを候補にする（maxHeight >= 2 * minHeight なら候補は必ず存在する）。
 *
 * zones 内の行は候補から外す。それで候補がなくなる場合に限り zones を無視して切り、forced に記録する。
 */
export function planSlices(scores: ArrayLike<number>, height: number, p: SliceParams, zones: Zone[] = []): PlanResult {
  const error = validateParams(height, p);
  if (error) return { ok: false, message: error };

  const { minHeight, maxHeight, maxCount } = p;
  const need = (h: number) => Math.ceil(h / maxHeight);
  const segments: Segment[] = [{ top: 0, bottom: height }];
  const forced: number[] = [];

  const blocked = new Uint8Array(height + 1);
  for (const z of zones) blocked.fill(1, Math.max(0, Math.floor(z.top)), Math.min(height, Math.ceil(z.bottom)) + 1);

  for (;;) {
    let ti = 0;
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].bottom - segments[i].top > segments[ti].bottom - segments[ti].top) ti = i;
    }
    const target = segments[ti];
    const h = target.bottom - target.top;
    if (h <= maxHeight) break;

    let othersNeed = 0;
    for (let i = 0; i < segments.length; i++) {
      if (i !== ti) othersNeed += need(segments[i].bottom - segments[i].top);
    }
    const allowed = maxCount - othersNeed;

    const feasible = (a: number, b: number) => need(a) + need(b) <= allowed;
    let y = findBestCut(scores, target, minHeight, (a, b) => !blocked[target.top + a] && feasible(a, b));
    if (y < 0) {
      y = findBestCut(scores, target, minHeight, feasible);
      if (y >= 0) forced.push(y);
    }
    if (y < 0) {
      // validateParams を通っていれば到達しない
      return { ok: false, message: `${target.top}〜${target.bottom}px の区間を分割できる位置が見つかりませんでした` };
    }
    segments.splice(ti, 1, { top: target.top, bottom: y }, { top: y, bottom: target.bottom });
  }

  segments.sort((a, b) => a.top - b.top);
  forced.sort((a, b) => a - b);
  return { ok: true, segments, forced };
}

function findBestCut(
  scores: ArrayLike<number>,
  seg: Segment,
  minHeight: number,
  feasible: (upper: number, lower: number) => boolean,
): number {
  const center = (seg.top + seg.bottom) / 2;
  let best = -1;
  let bestScore = -Infinity;
  for (let y = seg.top + minHeight; y <= seg.bottom - minHeight; y++) {
    if (!feasible(y - seg.top, seg.bottom - y)) continue;
    const s = scores[y];
    if (s > bestScore + TIE_EPSILON) {
      best = y;
      bestScore = s;
    } else if (s >= bestScore - TIE_EPSILON && Math.abs(y - center) < Math.abs(best - center)) {
      best = y;
      bestScore = Math.max(bestScore, s);
    }
  }
  return best;
}

/** 手動で編集した分割が分割条件を満たしているか調べ、満たしていない点を返す */
export function checkSegments(segments: Segment[], p: SliceParams): string[] {
  const problems: string[] = [];
  if (segments.length > p.maxCount) {
    problems.push(`${segments.length} 枚に分割されており、最大分割枚数 (${p.maxCount} 枚) を超えています`);
  }
  const numbers = (pred: (h: number) => boolean) =>
    segments.flatMap((s, i) => (pred(s.bottom - s.top) ? [i + 1] : [])).join(", ");
  const tall = numbers((h) => h > p.maxHeight);
  if (tall) problems.push(`${tall} 枚目が最大高さ (${p.maxHeight}px) を超えています`);
  const short = numbers((h) => h < p.minHeight);
  if (short) problems.push(`${short} 枚目が最小高さ (${p.minHeight}px) 未満です`);
  return problems;
}
