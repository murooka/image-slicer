import { FeatureAccumulator } from "./features";
import type { Features, Segment } from "./types";

export type OutputFormat = "image/jpeg" | "image/png";

export type WorkerRequest =
  | { type: "analyze"; file: Blob }
  | { type: "export"; segments: Segment[]; format: OutputFormat; quality: number; maxBytes: number };

export interface ExportedSlice {
  blob: Blob;
  /** JPEG で実際に使った品質（PNG の場合は null） */
  quality: number | null;
  /** maxBytes を満たせなかった */
  oversize: boolean;
}

export type WorkerResponse =
  | { type: "progress"; phase: string; done: number; total: number }
  | { type: "analyzed"; features: Features }
  | { type: "exported"; slices: ExportedSlice[] }
  | { type: "error"; message: string };

/** 一度に読み出す行数。巨大な canvas を作らないため帯ごとに処理する */
const STRIP_ROWS = 256;
/** 容量超過時に JPEG 品質を下げる刻みと下限 */
const QUALITY_STEP = 0.05;
const MIN_QUALITY = 0.5;

let bitmap: ImageBitmap | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    if (e.data.type === "analyze") await analyze(e.data.file);
    else await exportSlices(e.data.segments, e.data.format, e.data.quality, e.data.maxBytes);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

async function analyze(file: Blob): Promise<void> {
  post({ type: "progress", phase: "画像をデコード中", done: 0, total: 0 });
  bitmap?.close();
  bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  const canvas = new OffscreenCanvas(width, STRIP_ROWS);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D コンテキストを取得できません");

  const acc = new FeatureAccumulator(width, height);
  for (let y0 = 0; y0 < height; y0 += STRIP_ROWS) {
    const rows = Math.min(STRIP_ROWS, height - y0);
    ctx.clearRect(0, 0, width, STRIP_ROWS);
    ctx.drawImage(bitmap, 0, y0, width, rows, 0, 0, width, rows);
    acc.addRows(ctx.getImageData(0, 0, width, rows).data, rows);
    post({ type: "progress", phase: "画素を走査中", done: y0 + rows, total: height });
  }

  const features = acc.finish();
  post({ type: "analyzed", features }, [features.prefixHist.buffer, features.edge.buffer, features.busy.buffer]);
}

async function exportSlices(segments: Segment[], format: OutputFormat, quality: number, maxBytes: number): Promise<void> {
  if (!bitmap) throw new Error("画像が読み込まれていません");
  const { width } = bitmap;
  const slices: ExportedSlice[] = [];

  for (let i = 0; i < segments.length; i++) {
    post({ type: "progress", phase: "画像を書き出し中", done: i, total: segments.length });
    const { top, bottom } = segments[i];
    const h = bottom - top;
    const canvas = new OffscreenCanvas(width, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D コンテキストを取得できません");
    if (format === "image/jpeg") {
      // 透過部分が黒くならないよう白で塗っておく
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, h);
    }
    ctx.drawImage(bitmap, 0, top, width, h, 0, 0, width, h);

    if (format === "image/png") {
      const blob = await canvas.convertToBlob({ type: format });
      slices.push({ blob, quality: null, oversize: maxBytes > 0 && blob.size > maxBytes });
      continue;
    }

    let q = quality;
    let blob = await canvas.convertToBlob({ type: format, quality: q });
    while (maxBytes > 0 && blob.size > maxBytes && q - QUALITY_STEP >= MIN_QUALITY - 1e-9) {
      q = Math.round((q - QUALITY_STEP) * 100) / 100;
      blob = await canvas.convertToBlob({ type: format, quality: q });
    }
    slices.push({ blob, quality: q, oversize: maxBytes > 0 && blob.size > maxBytes });
  }

  post({ type: "progress", phase: "画像を書き出し中", done: segments.length, total: segments.length });
  post({ type: "exported", slices });
}
