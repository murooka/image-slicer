/** 画像を1回走査して得られる行単位の特徴量 */
export interface Features {
  width: number;
  height: number;
  /** 量子化した色ヒストグラムの行方向累積和。長さ (height + 1) * BINS */
  prefixHist: Uint32Array;
  /** edge[y]: 行 y-1 と行 y の間で色が大きく変わった画素の割合 (0..1)。edge[0] は 0 */
  edge: Float32Array;
  /** busy[y]: 行 y の中で隣接画素の色が大きく変わる割合 (0..1)。文字や写真で高くなる */
  busy: Float32Array;
}

export interface ScoreParams {
  /** 上下の帯を比較する高さ (px) */
  bandSize: number;
  /** 上下の帯の色分布の差の重み */
  wBand: number;
  /** 直上の行との色の差の重み */
  wEdge: number;
  /** 分割する行が均一（文字や写真を横切らない）であることの重み */
  wFlat: number;
}

export interface SliceParams {
  minHeight: number;
  maxHeight: number;
  maxCount: number;
}

/** [top, bottom) の範囲 */
export interface Segment {
  top: number;
  bottom: number;
}

/** 分割を禁止する範囲。top〜bottom（両端を含む）の位置では切らない */
export interface Zone {
  top: number;
  bottom: number;
}

export type PlanResult =
  | {
      ok: true;
      segments: Segment[];
      /** 分割禁止範囲を避けられず、やむを得ず範囲内で切った位置 */
      forced: number[];
    }
  | { ok: false; message: string };
