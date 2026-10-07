import type { Features } from "./types";

/** RGB 各チャネルを 4 段階に量子化した 64 ビンのヒストグラム */
export const BINS = 64;

/** RGB 差の絶対値の合計がこれを超えたら「色が変わった」とみなす（JPEG ノイズ対策） */
const CHANGE_THRESHOLD = 48;

/**
 * RGBA 画素を上から帯ごとに受け取り、行単位の特徴量を蓄積する。
 * 巨大な画像を 1 枚の canvas に載せずに済むよう、任意の行数ずつ追加できる。
 */
export class FeatureAccumulator {
  private readonly prefixHist: Uint32Array;
  private readonly edge: Float32Array;
  private readonly busy: Float32Array;
  private readonly rowHist = new Uint32Array(BINS);
  private prevRow: Uint8ClampedArray | null = null;
  private y = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.prefixHist = new Uint32Array((height + 1) * BINS);
    this.edge = new Float32Array(height);
    this.busy = new Float32Array(height);
  }

  get rowsProcessed(): number {
    return this.y;
  }

  /** data は幅 width、高さ rows の RGBA 画素列 */
  addRows(data: Uint8ClampedArray, rows: number): void {
    const w = this.width;
    const stride = w * 4;
    const hist = this.rowHist;

    for (let r = 0; r < rows; r++) {
      const y = this.y;
      if (y >= this.height) throw new Error("画像の高さを超えて行が追加されました");

      const off = r * stride;
      const prev = r > 0 ? data : this.prevRow;
      const prevOff = r > 0 ? off - stride : 0;
      hist.fill(0);
      let busyCount = 0;
      let edgeCount = 0;

      for (let x = 0; x < w; x++) {
        const i = off + x * 4;
        const R = data[i];
        const G = data[i + 1];
        const B = data[i + 2];
        hist[((R >> 6) << 4) | ((G >> 6) << 2) | (B >> 6)]++;

        if (x > 0) {
          const d = Math.abs(R - data[i - 4]) + Math.abs(G - data[i - 3]) + Math.abs(B - data[i - 2]);
          if (d > CHANGE_THRESHOLD) busyCount++;
        }
        if (prev) {
          const j = prevOff + x * 4;
          const d = Math.abs(R - prev[j]) + Math.abs(G - prev[j + 1]) + Math.abs(B - prev[j + 2]);
          if (d > CHANGE_THRESHOLD) edgeCount++;
        }
      }

      const base = y * BINS;
      for (let b = 0; b < BINS; b++) {
        this.prefixHist[base + BINS + b] = this.prefixHist[base + b] + hist[b];
      }
      this.busy[y] = w > 1 ? busyCount / (w - 1) : 0;
      this.edge[y] = prev ? edgeCount / w : 0;
      this.y++;
    }

    if (rows > 0) this.prevRow = data.slice((rows - 1) * stride, rows * stride);
  }

  finish(): Features {
    if (this.y !== this.height) {
      throw new Error(`走査した行数 (${this.y}) が画像の高さ (${this.height}) と一致しません`);
    }
    return {
      width: this.width,
      height: this.height,
      prefixHist: this.prefixHist,
      edge: this.edge,
      busy: this.busy,
    };
  }
}
