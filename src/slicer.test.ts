import { describe, expect, it } from "vitest";
import { FeatureAccumulator } from "./features";
import { checkSegments, planSlices, validateParams } from "./planner";
import { computeScores, DEFAULT_SCORE_PARAMS } from "./scoring";
import type { Segment } from "./types";

type RGB = [number, number, number];

/** 単色セクションを縦に積んだ画像。text を指定した区間には上下 20px の余白を残して縞模様（文字の代わり）を描く */
function makeImage(width: number, sections: { height: number; color: RGB; text?: boolean }[]) {
  const height = sections.reduce((s, x) => s + x.height, 0);
  const data = new Uint8ClampedArray(width * height * 4);
  let y = 0;
  for (const sec of sections) {
    for (let r = 0; r < sec.height; r++, y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const ink = sec.text && r >= 20 && r < sec.height - 20 && r % 20 < 10 && x % 6 < 3;
        const [R, G, B] = ink ? [0, 0, 0] : sec.color;
        data[i] = R;
        data[i + 1] = G;
        data[i + 2] = B;
        data[i + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

function analyze(img: { width: number; height: number; data: Uint8ClampedArray }, strip = 37) {
  const acc = new FeatureAccumulator(img.width, img.height);
  const stride = img.width * 4;
  for (let y = 0; y < img.height; y += strip) {
    const rows = Math.min(strip, img.height - y);
    acc.addRows(img.data.subarray(y * stride, (y + rows) * stride), rows);
  }
  return acc.finish();
}

const heights = (segs: Segment[]) => segs.map((s) => s.bottom - s.top);

function expectContiguous(segs: Segment[], height: number) {
  expect(segs[0].top).toBe(0);
  expect(segs[segs.length - 1].bottom).toBe(height);
  for (let i = 1; i < segs.length; i++) expect(segs[i].top).toBe(segs[i - 1].bottom);
}

describe("FeatureAccumulator", () => {
  it("帯の分け方に依存せず同じ特徴量になる", () => {
    const img = makeImage(30, [
      { height: 50, color: [255, 255, 255], text: true },
      { height: 50, color: [200, 30, 30] },
    ]);
    const a = analyze(img, 1);
    const b = analyze(img, 100);
    expect(Array.from(a.prefixHist)).toEqual(Array.from(b.prefixHist));
    expect(Array.from(a.edge)).toEqual(Array.from(b.edge));
    expect(Array.from(a.busy)).toEqual(Array.from(b.busy));
  });

  it("色が切り替わる行で edge が 1 になる", () => {
    const f = analyze(makeImage(10, [
      { height: 5, color: [255, 255, 255] },
      { height: 5, color: [0, 0, 255] },
    ]));
    expect(f.edge[5]).toBe(1);
    expect(f.edge[4]).toBe(0);
  });
});

describe("computeScores", () => {
  it("セクション境界が最大スコアになり、文字の行は低い", () => {
    const img = makeImage(60, [
      { height: 200, color: [255, 255, 255], text: true },
      { height: 200, color: [30, 60, 160] },
    ]);
    const scores = computeScores(analyze(img), DEFAULT_SCORE_PARAMS);
    let best = 1;
    for (let y = 1; y < img.height; y++) if (scores[y] > scores[best]) best = y;
    expect(best).toBe(200);
    // 文字の縞の上端（白→黒）は境界より低い
    expect(scores[40]).toBeLessThan(scores[200]);
  });
});

describe("validateParams", () => {
  it("最大高さが最小高さの 2 倍未満ならエラー", () => {
    expect(validateParams(1000, { minHeight: 300, maxHeight: 500, maxCount: 10 })).toMatch(/2 倍/);
  });
  it("最大枚数で足りなければエラー", () => {
    expect(validateParams(1000, { minHeight: 100, maxHeight: 300, maxCount: 3 })).toMatch(/4 枚以上/);
  });
  it("妥当な値なら null", () => {
    expect(validateParams(1000, { minHeight: 100, maxHeight: 300, maxCount: 4 })).toBeNull();
  });
});

describe("planSlices", () => {
  it("最大高さ以下なら分割しない", () => {
    const r = planSlices(new Float32Array(500), 500, { minHeight: 100, maxHeight: 500, maxCount: 5 });
    expect(r).toEqual({ ok: true, segments: [{ top: 0, bottom: 500 }], forced: [] });
  });

  it("スコアの高い位置で切り、最大高さを超える区間はさらに分割する", () => {
    const scores = new Float32Array(1000);
    scores[400] = 5;
    scores[700] = 3;
    scores[200] = 1;
    const r = planSlices(scores, 1000, { minHeight: 100, maxHeight: 500, maxCount: 5 });
    // 400 で切ると下側 600px が残るので 700 で再分割。上側 400px は最大高さ以下なので切らない
    expect(r.ok && r.segments.map((s) => s.top)).toEqual([0, 400, 700]);
  });

  it("最小高さより端に近い位置では切らない", () => {
    const scores = new Float32Array(1000);
    scores[50] = 10;
    scores[600] = 1;
    const r = planSlices(scores, 1000, { minHeight: 100, maxHeight: 900, maxCount: 5 });
    expect(r.ok && r.segments.map((s) => s.top)).toEqual([0, 600]);
  });

  it("スコアが平坦なら中央で切る", () => {
    const r = planSlices(new Float32Array(1000), 1000, { minHeight: 100, maxHeight: 600, maxCount: 5 });
    expect(r.ok && r.segments.map((s) => s.top)).toEqual([0, 500]);
  });

  it("分割禁止範囲を避けて次に良い位置で切る", () => {
    const scores = new Float32Array(1000);
    scores[400] = 5;
    scores[401] = 4.9;
    scores[700] = 3;
    const r = planSlices(scores, 1000, { minHeight: 100, maxHeight: 900, maxCount: 5 }, [{ top: 360, bottom: 440 }]);
    expect(r.ok && r.segments.map((s) => s.top)).toEqual([0, 700]);
    expect(r.ok && r.forced).toEqual([]);
  });

  it("分割禁止範囲しか候補がなければ範囲内で切り、forced に記録する", () => {
    const scores = new Float32Array(1000);
    scores[500] = 1;
    const r = planSlices(scores, 1000, { minHeight: 100, maxHeight: 900, maxCount: 5 }, [{ top: 0, bottom: 1000 }]);
    expect(r.ok && r.segments.map((s) => s.top)).toEqual([0, 500]);
    expect(r.ok && r.forced).toEqual([500]);
  });

  it("すべての区間が最小〜最大高さに収まり、最大枚数を守る", () => {
    // 疑似乱数のスコア
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 50; t++) {
      const H = 2000 + Math.floor(rand() * 20000);
      const minHeight = 50 + Math.floor(rand() * 200);
      const maxHeight = minHeight * 2 + Math.floor(rand() * 1000);
      const maxCount = Math.ceil(H / maxHeight) + Math.floor(rand() * 3);
      const scores = Float32Array.from({ length: H }, () => rand());
      const r = planSlices(scores, H, { minHeight, maxHeight, maxCount });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expectContiguous(r.segments, H);
      expect(r.segments.length).toBeLessThanOrEqual(maxCount);
      for (const h of heights(r.segments)) {
        expect(h).toBeGreaterThanOrEqual(minHeight);
        expect(h).toBeLessThanOrEqual(maxHeight);
      }
    }
  });
});

describe("end to end", () => {
  it("縦長の画像をセクション境界で分割する", () => {
    const img = makeImage(80, [
      { height: 600, color: [250, 240, 220], text: true },
      { height: 400, color: [30, 60, 160], text: true },
      { height: 700, color: [255, 255, 255], text: true },
      { height: 500, color: [200, 30, 30] },
    ]);
    const scores = computeScores(analyze(img), DEFAULT_SCORE_PARAMS);
    const r = planSlices(scores, img.height, { minHeight: 200, maxHeight: 800, maxCount: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.top)).toEqual([0, 600, 1000, 1700]);
  });

});

describe("checkSegments", () => {
  const p = { minHeight: 100, maxHeight: 500, maxCount: 3 };
  it("条件を満たしていれば空", () => {
    expect(checkSegments([{ top: 0, bottom: 300 }, { top: 300, bottom: 800 }], p)).toEqual([]);
  });
  it("高さと枚数の違反を報告する", () => {
    const segs = [
      { top: 0, bottom: 600 },
      { top: 600, bottom: 650 },
      { top: 650, bottom: 1000 },
      { top: 1000, bottom: 1050 },
    ];
    expect(checkSegments(segs, p)).toEqual([
      "4 枚に分割されており、最大分割枚数 (3 枚) を超えています",
      "1 枚目が最大高さ (500px) を超えています",
      "2, 4 枚目が最小高さ (100px) 未満です",
    ]);
  });
});
