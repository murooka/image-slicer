import "./style.css";
import { zipSync } from "fflate";
import { checkSegments, planSlices } from "./planner";
import { computeScores, DEFAULT_SCORE_PARAMS } from "./scoring";
import type { Features, ScoreParams, Segment, SliceParams, Zone } from "./types";
import type { ExportedSlice, OutputFormat, WorkerRequest, WorkerResponse } from "./worker";
import { setupPwa } from "./pwa";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>("file");
const drop = $<HTMLLabelElement>("drop");
const dropText = $("drop-text");
const imageInfo = $("image-info");
const exportButton = $<HTMLButtonElement>("export");
const progress = $("progress");
const progressPhase = $("progress-phase");
const progressPct = $("progress-pct");
const progressBar = $("progress-bar");
const message = $("message");
const summary = $("summary");
const preview = $("preview");
const previewImg = $<HTMLImageElement>("preview-img");
const overlay = $("overlay");
const results = $("results");
const sliceList = $("slice-list");
const zipButton = $<HTMLButtonElement>("zip");
const htmlOutput = $<HTMLTextAreaElement>("html");
const zoneCount = $("zone-count");
const clearZonesButton = $<HTMLButtonElement>("clear-zones");
const manualBar = $("manual-bar");
const undoButton = $<HTMLButtonElement>("undo");
const revertButton = $<HTMLButtonElement>("revert");
const previewHint = $("preview-hint");

const num = (id: string) => Number($<HTMLInputElement>(id).value);
const str = (id: string) => $<HTMLInputElement>(id).value;

for (const [key, value] of Object.entries(DEFAULT_SCORE_PARAMS)) {
  $<HTMLInputElement>(key).value = String(value);
}

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

let features: Features | null = null;
let scores: Float32Array | null = null;
let scoreKey = "";
let segments: Segment[] = [];
let forced: number[] = [];
/** 人が指定した分割禁止範囲（画像の px 座標） */
let zones: Zone[] = [];
/** 手動編集モードの分割位置。null なら自動モード */
let manualCuts: number[] | null = null;
/** 手動編集の履歴（編集前の分割位置） */
let undoStack: number[][] = [];
let exported: { name: string; slice: ExportedSlice }[] = [];
let previewUrl: string | null = null;
let busy = false;

function send(req: WorkerRequest): void {
  worker.postMessage(req);
}

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  switch (msg.type) {
    case "progress":
      showProgress(msg.phase, msg.done, msg.total);
      break;
    case "analyzed":
      features = msg.features;
      scores = null;
      setBusy(false);
      hideProgress();
      replan();
      break;
    case "exported":
      setBusy(false);
      hideProgress();
      showResults(msg.slices);
      break;
    case "error":
      setBusy(false);
      hideProgress();
      setMessage(msg.message, "error");
      break;
  }
};

worker.onerror = (e) => {
  setBusy(false);
  hideProgress();
  setMessage(`処理中にエラーが発生しました: ${e.message}`, "error");
};

// ---- 画像の読み込み ----

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
});

drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("dragover");
});
drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("dragover");
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
});

function loadFile(file: File): void {
  if (busy) return;
  if (!file.type.startsWith("image/")) {
    setMessage("画像ファイルを選択してください", "error");
    return;
  }
  features = null;
  scores = null;
  segments = [];
  forced = [];
  zones = [];
  manualCuts = null;
  undoStack = [];
  updateControls();
  clearResults();
  overlay.replaceChildren();
  setMessage("");
  dropText.textContent = file.name;
  imageInfo.textContent = `${formatBytes(file.size)}`;

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  previewImg.src = previewUrl;
  preview.hidden = false;
  summary.textContent = "解析中…";

  setBusy(true);
  send({ type: "analyze", file });
}

// ---- 分割位置の計算 ----

let replanTimer = 0;
for (const id of ["minHeight", "maxHeight", "maxCount", "bandSize", "wBand", "wEdge", "wFlat"]) {
  $(id).addEventListener("input", () => {
    clearTimeout(replanTimer);
    replanTimer = window.setTimeout(replan, 150);
  });
}

const sliceParams = (): SliceParams => ({ minHeight: num("minHeight"), maxHeight: num("maxHeight"), maxCount: num("maxCount") });

function replan(): void {
  if (!features) return;
  const { width, height } = features;
  imageInfo.textContent = `${width} × ${height}px`;
  clearResults();
  if (manualCuts) {
    renderManual();
    return;
  }

  const sp: ScoreParams = { bandSize: num("bandSize"), wBand: num("wBand"), wEdge: num("wEdge"), wFlat: num("wFlat") };
  const key = JSON.stringify(sp);
  if (!scores || key !== scoreKey) {
    scores = computeScores(features, sp);
    scoreKey = key;
  }

  const result = planSlices(scores, height, sliceParams(), zones);
  if (!result.ok) {
    segments = [];
    forced = [];
    overlay.replaceChildren();
    summary.textContent = "分割できません";
    setMessage(result.message, "error");
    exportButton.disabled = true;
    return;
  }

  segments = result.segments;
  forced = result.forced;
  if (forced.length > 0) {
    setMessage(`${forced.length} 箇所は、ほかに条件を満たす位置がないため切らない範囲の中で分割しました（オレンジの破線）。`, "warn");
  } else {
    setMessage("");
  }
  exportButton.disabled = busy;
  drawOverlay(height);
  summary.textContent = `${segments.length} 枚に分割（${heightRange()}）`;
}

function renderManual(): void {
  const H = features!.height;
  const bounds = [0, ...manualCuts!, H];
  segments = bounds.slice(1).map((bottom, i) => ({ top: bounds[i], bottom }));
  forced = [];
  const problems = checkSegments(segments, sliceParams());
  setMessage(problems.length ? `分割条件を満たしていません（このまま書き出せます）\n${problems.join("\n")}` : "", "warn");
  exportButton.disabled = busy;
  drawOverlay(H);
  summary.textContent = `${segments.length} 枚に分割（手動編集・${heightRange()}）`;
}

function heightRange(): string {
  const hs = segments.map((s) => s.bottom - s.top);
  return `高さ ${Math.min(...hs)}〜${Math.max(...hs)}px`;
}

function drawOverlay(height: number): void {
  const pct = (y: number) => `${(y / height) * 100}%`;
  const { minHeight, maxHeight } = sliceParams();
  const nodes: HTMLElement[] = manualCuts
    ? []
    : zones.map((z, i) => {
        const el = document.createElement("div");
        el.className = "zone";
        el.style.top = pct(z.top);
        el.style.height = pct(z.bottom - z.top);
        el.dataset.zone = String(i);
        el.title = `${z.top}〜${z.bottom}px では切りません（クリックで解除）`;
        return el;
      });
  segments.forEach((s, i) => {
    if (i > 0) {
      const line = document.createElement("div");
      line.className = forced.includes(s.top) ? "cut forced" : "cut";
      line.style.top = pct(s.top);
      line.dataset.index = String(i - 1);
      line.title = manualCuts
        ? `${s.top}px（ドラッグで移動）`
        : `${s.top}px（クリック: この付近では切らない / ドラッグ: 移動）`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "cut-delete";
      del.textContent = "×";
      del.title = "この分割線を削除";
      const pos = document.createElement("span");
      pos.className = "cut-pos";
      line.append(del, pos);
      nodes.push(line);
    }
    const h = s.bottom - s.top;
    const label = document.createElement("div");
    label.className = manualCuts && (h > maxHeight || h < minHeight) ? "seg-label bad" : "seg-label";
    label.style.top = pct(s.top);
    label.textContent = `${i + 1}: ${h}px`;
    nodes.push(label);
  });
  overlay.replaceChildren(...nodes);
}

// ---- プレビュー上の操作 ----

const currentCuts = () => segments.slice(1).map((s) => s.top);

overlay.addEventListener("click", (e) => {
  if (busy || !features) return;
  const el = e.target as HTMLElement;
  if (el.classList.contains("cut-delete")) {
    const i = Number(el.closest<HTMLElement>(".cut")!.dataset.index);
    editCuts(currentCuts().filter((_, j) => j !== i));
  } else if (el.dataset.zone) {
    zones.splice(Number(el.dataset.zone), 1);
    onZonesChanged();
  }
});

/** 分割線のドラッグで移動、クリックで付近を分割禁止にする（自動モードのみ） */
overlay.addEventListener("pointerdown", (e) => {
  const target = e.target as HTMLElement;
  const line = target.closest<HTMLElement>(".cut");
  if (busy || !features || e.button !== 0 || !line || target.classList.contains("cut-delete")) return;
  e.preventDefault();

  const H = features.height;
  const cuts = currentCuts();
  const i = Number(line.dataset.index);
  const lo = (cuts[i - 1] ?? 0) + 1;
  const hi = (cuts[i + 1] ?? H) - 1;
  const pos = line.querySelector<HTMLElement>(".cut-pos")!;
  const startClientY = e.clientY;
  let dragging = false;
  let y = cuts[i];

  const onMove = (ev: PointerEvent) => {
    if (!dragging && Math.abs(ev.clientY - startClientY) < 4) return;
    dragging = true;
    line.classList.add("dragging");
    y = Math.min(hi, Math.max(lo, toImageY(ev.clientY)));
    line.style.top = `${(y / H) * 100}%`;
    pos.textContent = `${y}px`;
  };
  const onUp = (ev: PointerEvent) => {
    line.removeEventListener("pointermove", onMove);
    line.removeEventListener("pointerup", onUp);
    line.removeEventListener("pointercancel", onUp);
    if (ev.type === "pointercancel") {
      drawOverlay(H);
    } else if (dragging) {
      if (y !== cuts[i]) editCuts(cuts.map((c, j) => (j === i ? y : c)));
      else drawOverlay(H);
    } else if (!manualCuts) {
      const r = Math.max(1, num("zoneRadius"));
      addZone(cuts[i] - r, cuts[i] + r);
    }
  };
  line.setPointerCapture(e.pointerId);
  line.addEventListener("pointermove", onMove);
  line.addEventListener("pointerup", onUp);
  line.addEventListener("pointercancel", onUp);
});

/** 画像上をドラッグして分割禁止範囲を指定する（タッチはスクロールと衝突するため対象外） */
previewImg.addEventListener("pointerdown", (e) => {
  if (busy || !features || manualCuts || e.button !== 0 || e.pointerType === "touch") return;
  e.preventDefault();
  const startClientY = e.clientY;
  const start = toImageY(startClientY);
  const draft = document.createElement("div");
  draft.className = "zone draft";
  overlay.append(draft);

  const range = (clientY: number) => {
    const y = toImageY(clientY);
    return { top: Math.min(start, y), bottom: Math.max(start, y) };
  };
  const onMove = (ev: PointerEvent) => {
    const { top, bottom } = range(ev.clientY);
    const H = features!.height;
    draft.style.top = `${(top / H) * 100}%`;
    draft.style.height = `${((bottom - top) / H) * 100}%`;
  };
  const onUp = (ev: PointerEvent) => {
    previewImg.removeEventListener("pointermove", onMove);
    previewImg.removeEventListener("pointerup", onUp);
    previewImg.removeEventListener("pointercancel", onUp);
    draft.remove();
    // 数 px 程度の動きはドラッグとみなさない
    if (ev.type === "pointerup" && Math.abs(ev.clientY - startClientY) >= 4) {
      const { top, bottom } = range(ev.clientY);
      addZone(top, bottom);
    }
  };
  previewImg.setPointerCapture(e.pointerId);
  previewImg.addEventListener("pointermove", onMove);
  previewImg.addEventListener("pointerup", onUp);
  previewImg.addEventListener("pointercancel", onUp);
});

/** 画像のダブルクリックで分割線を追加する。自動モードからは手動編集モードに切り替わる */
previewImg.addEventListener("dblclick", (e) => {
  if (busy || !features) return;
  const y = toImageY(e.clientY);
  const cuts = currentCuts();
  if (y <= 0 || y >= features.height || cuts.includes(y)) return;
  editCuts([...cuts, y]);
});

function toImageY(clientY: number): number {
  const rect = previewImg.getBoundingClientRect();
  const H = features!.height;
  return Math.round(Math.min(H, Math.max(0, ((clientY - rect.top) / rect.height) * H)));
}

// ---- 手動編集 ----

/** 分割線を直接編集する。自動モードからは手動編集モードに切り替わる */
function editCuts(cuts: number[]): void {
  undoStack.push(currentCuts());
  manualCuts = [...cuts].sort((a, b) => a - b);
  updateControls();
  replan();
}

function undo(): void {
  if (busy || !manualCuts) return;
  const prev = undoStack.pop();
  // 最初の編集まで戻したら自動モードに戻る（分割条件は編集中変えられないので同じ結果になる）
  manualCuts = undoStack.length > 0 && prev ? prev : null;
  if (!manualCuts) undoStack = [];
  updateControls();
  replan();
}

undoButton.addEventListener("click", undo);

revertButton.addEventListener("click", () => {
  if (!confirm("手動で編集した分割線を破棄して、自動分割に戻しますか？")) return;
  manualCuts = null;
  undoStack = [];
  updateControls();
  replan();
});

document.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "z" && tag !== "INPUT" && tag !== "TEXTAREA" && manualCuts) {
    e.preventDefault();
    undo();
  }
});

// ---- 分割禁止範囲 ----

clearZonesButton.addEventListener("click", () => {
  zones = [];
  onZonesChanged();
});

/** 範囲を追加する。重なる・接する既存の範囲とは 1 つにまとめる */
function addZone(top: number, bottom: number): void {
  const H = features!.height;
  let z: Zone = { top: Math.max(0, Math.round(top)), bottom: Math.min(H, Math.round(bottom)) };
  const rest: Zone[] = [];
  for (const o of zones) {
    if (o.bottom >= z.top && o.top <= z.bottom) z = { top: Math.min(o.top, z.top), bottom: Math.max(o.bottom, z.bottom) };
    else rest.push(o);
  }
  zones = [...rest, z].sort((a, b) => a.top - b.top);
  onZonesChanged();
}

function onZonesChanged(): void {
  updateControls();
  replan();
}

// ---- 書き出し ----

exportButton.addEventListener("click", () => {
  if (!segments.length || busy) return;
  clearResults();
  setMessage("");
  setBusy(true);
  send({
    type: "export",
    segments,
    format: str("format") as OutputFormat,
    quality: num("quality"),
    maxBytes: Math.max(0, num("maxKB")) * 1024,
  });
});

function showResults(slices: ExportedSlice[]): void {
  const ext = str("format") === "image/png" ? "png" : "jpg";
  const digits = Math.max(2, String(slices.length).length);
  const prefix = str("prefix");
  exported = slices.map((slice, i) => ({ name: `${prefix}${String(i + 1).padStart(digits, "0")}.${ext}`, slice }));

  sliceList.replaceChildren(
    ...exported.map(({ name, slice }, i) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(slice.blob);
      a.download = name;
      a.textContent = name;
      const seg = segments[i];
      const q = slice.quality !== null ? ` / 品質 ${slice.quality}` : "";
      li.append(a, ` — ${seg.bottom - seg.top}px / ${formatBytes(slice.blob.size)}${q}`);
      if (slice.oversize) {
        li.classList.add("oversize");
        li.append("（上限超過）");
      }
      return li;
    }),
  );

  const base = str("baseUrl");
  htmlOutput.value = exported.map(({ name }) => `<img src="${base}${name}" width="100%" alt="">`).join("\n");
  results.hidden = false;

  const over = slices.filter((s) => s.oversize).length;
  if (over > 0) setMessage(`${over} 枚が容量の上限を超えています。最大高さを下げるか、上限を見直してください。`, "warn");
}

zipButton.addEventListener("click", async () => {
  if (!exported.length) return;
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const { name, slice } of exported) {
    entries[name] = [new Uint8Array(await slice.blob.arrayBuffer()), { level: 0 }];
  }
  const zip = zipSync(entries);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }));
  a.download = "slices.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

function clearResults(): void {
  for (const a of sliceList.querySelectorAll("a")) URL.revokeObjectURL(a.href);
  sliceList.replaceChildren();
  exported = [];
  htmlOutput.value = "";
  results.hidden = true;
}

// ---- 表示まわり ----

/** 状態に応じて操作できる部品を切り替える */
function updateControls(): void {
  // 書き出し中に条件が変わると結果と分割位置がずれるため、すべての入力を止める。
  // 手動編集中は自動分割用の設定（data-auto）が反映されないため止める
  for (const f of document.querySelectorAll<HTMLFieldSetElement>("fieldset")) {
    f.disabled = busy || (manualCuts !== null && "auto" in f.dataset);
  }
  zoneCount.textContent = `切らない範囲: ${zones.length} 件`;
  clearZonesButton.disabled = busy || manualCuts !== null || zones.length === 0;
  manualBar.hidden = manualCuts === null;
  undoButton.disabled = busy;
  revertButton.disabled = busy;
  previewHint.textContent = manualCuts
    ? "分割線: ドラッグで移動 / × で削除　画像: ダブルクリックで分割線を追加"
    : "分割線: クリックでその付近を切らない / ドラッグで移動 / × で削除　画像: ドラッグで切らない範囲を指定 / ダブルクリックで分割線を追加";
}

function setBusy(value: boolean): void {
  busy = value;
  exportButton.disabled = value || !segments.length;
  fileInput.disabled = value;
  updateControls();
}

function showProgress(phase: string, done: number, total: number): void {
  progress.hidden = false;
  progressPhase.textContent = phase;
  if (total > 0) {
    const pct = Math.round((done / total) * 100);
    progressBar.classList.remove("indeterminate");
    progressBar.style.width = `${pct}%`;
    progressPct.textContent = `${pct}%`;
  } else {
    progressBar.classList.add("indeterminate");
    progressBar.style.width = "";
    progressPct.textContent = "";
  }
}

function hideProgress(): void {
  progress.hidden = true;
}

function setMessage(text: string, kind: "error" | "warn" | "" = ""): void {
  message.textContent = text;
  message.className = `message ${kind}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

setupPwa();
