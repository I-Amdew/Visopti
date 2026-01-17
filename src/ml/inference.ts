import * as ort from "onnxruntime-web";

export type MlRuntime = "onnx" | "tfjs";

export interface DetectorConfig {
  runtime: MlRuntime;
  modelUrl: string;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  runtime: "onnx",
  modelUrl: "/models/treesigns/latest.onnx"
};

export interface TreeSignsManifest {
  model: string;
  version: string;
  classes: string[];
  input?: { width?: number; height?: number };
  exportedAt?: string;
  sha256?: string;
}

export interface PatchPrediction {
  class: string;
  confidence: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

interface LoadedModel {
  session: ort.InferenceSession;
  manifest: TreeSignsManifest;
  inputWidth: number;
  inputHeight: number;
  classes: string[];
}

const DEFAULT_INPUT_SIZE = 640;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.35;
const DEFAULT_NMS_IOU = 0.45;
const FALLBACK_CLASS_NAMES = ["tree_deciduous", "tree_pine", "billboard", "stop_sign"];

let cachedModel: LoadedModel | null = null;
let loadPromise: Promise<LoadedModel> | null = null;
let wasmConfigured = false;

export function invalidateTreeSignsModelCache(): void {
  cachedModel = null;
}

export async function loadTreeSignsModel(): Promise<{
  session: ort.InferenceSession;
  manifest: TreeSignsManifest;
}> {
  const model = await ensureTreeSignsModel();
  return { session: model.session, manifest: model.manifest };
}

export async function detectOnPatch(
  image: HTMLCanvasElement | HTMLImageElement | ImageData
): Promise<PatchPrediction[]> {
  const model = await ensureTreeSignsModel();
  const { inputWidth, inputHeight } = model;
  const { canvas, width: sourceWidth, height: sourceHeight } = ensureSourceCanvas(image);
  const resized = resizeCanvas(canvas, inputWidth, inputHeight);
  const ctx = resized.getContext("2d");
  if (!ctx) {
    return [];
  }
  const imageData = ctx.getImageData(0, 0, inputWidth, inputHeight);
  const inputTensor = imageDataToTensor(imageData, inputWidth, inputHeight);
  const inputName = model.session.inputNames[0];
  const outputName = model.session.outputNames[0];
  const outputs = await model.session.run({ [inputName]: inputTensor });
  const output = outputs[outputName];
  if (!output) {
    return [];
  }
  const raw = parseYoloOutput(output, model.classes, DEFAULT_CONFIDENCE_THRESHOLD);
  const normalized = raw.length > 0 &&
    raw.every(
      (pred) => pred.cx <= 1.5 && pred.cy <= 1.5 && pred.w <= 1.5 && pred.h <= 1.5
    );
  const scaledRaw = normalized
    ? raw.map((pred) => ({
        ...pred,
        cx: pred.cx * inputWidth,
        cy: pred.cy * inputHeight,
        w: pred.w * inputWidth,
        h: pred.h * inputHeight
      }))
    : raw;
  const scaleX = sourceWidth / inputWidth;
  const scaleY = sourceHeight / inputHeight;
  const scaled = scaledRaw.map((pred) => ({
    ...pred,
    cx: pred.cx * scaleX,
    cy: pred.cy * scaleY,
    w: pred.w * scaleX,
    h: pred.h * scaleY
  }));
  return applyNms(scaled, DEFAULT_NMS_IOU);
}

async function ensureTreeSignsModel(): Promise<LoadedModel> {
  if (cachedModel) {
    return cachedModel;
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      configureWasm();
      const manifest = await fetchManifest();
      if (cachedModel && manifest.version === cachedModel.manifest.version) {
        return cachedModel;
      }
      const inputWidth = normalizeInputSize(manifest.input?.width);
      const inputHeight = normalizeInputSize(manifest.input?.height);
      const cacheBuster = manifest.sha256 ? `sha256=${encodeURIComponent(manifest.sha256)}` : `ts=${Date.now()}`;
      const onnxUrl = resolveModelUrl(`/models/treesigns/latest.onnx?${cacheBuster}`);
      const session = await ort.InferenceSession.create(onnxUrl, {
        executionProviders: ["wasm"]
      });
      const classes = Array.isArray(manifest.classes) && manifest.classes.length > 0
        ? manifest.classes
        : FALLBACK_CLASS_NAMES;
      cachedModel = {
        session,
        manifest,
        inputWidth,
        inputHeight,
        classes
      };
      return cachedModel;
    })();
  }
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function fetchManifest(): Promise<TreeSignsManifest> {
  const url = resolveModelUrl(`/models/treesigns/manifest.json?ts=${Date.now()}`);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Model manifest unavailable (${response.status}).`);
  }
  const manifest = (await response.json()) as TreeSignsManifest;
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Model manifest invalid.");
  }
  return manifest;
}

function configureWasm(): void {
  if (wasmConfigured) {
    return;
  }
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";
  wasmConfigured = true;
}

function resolveModelUrl(path: string): string {
  if (typeof window === "undefined") {
    return path;
  }
  try {
    const base =
      window.location.origin && window.location.origin !== "null"
        ? window.location.origin
        : window.location.href;
    return new URL(path, base).toString();
  } catch {
    return path;
  }
}

function ensureSourceCanvas(
  image: HTMLCanvasElement | HTMLImageElement | ImageData
): { canvas: HTMLCanvasElement; width: number; height: number } {
  if (image instanceof HTMLCanvasElement) {
    return { canvas: image, width: image.width, height: image.height };
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { canvas, width: 1, height: 1 };
  }
  if (image instanceof HTMLImageElement) {
    const width = image.naturalWidth || image.width || 1;
    const height = image.naturalHeight || image.height || 1;
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(image, 0, 0, width, height);
    return { canvas, width, height };
  }
  const width = Math.max(1, image.width);
  const height = Math.max(1, image.height);
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(image, 0, 0);
  return { canvas, width, height };
}

function resizeCanvas(source: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

function imageDataToTensor(imageData: ImageData, width: number, height: number): ort.Tensor {
  const { data } = imageData;
  const size = width * height;
  const floatData = new Float32Array(3 * size);
  for (let i = 0; i < size; i += 1) {
    const offset = i * 4;
    floatData[i] = data[offset] / 255;
    floatData[i + size] = data[offset + 1] / 255;
    floatData[i + size * 2] = data[offset + 2] / 255;
  }
  return new ort.Tensor("float32", floatData, [1, 3, height, width]);
}

function normalizeInputSize(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_INPUT_SIZE;
  }
  return Math.max(32, Math.round(value));
}

function parseYoloOutput(
  output: ort.Tensor,
  classes: string[],
  threshold: number
): PatchPrediction[] {
  const data = output.data as Float32Array;
  const dims = output.dims ?? [];
  if (!dims.length || data.length === 0) {
    return [];
  }
  let boxes = 0;
  let attributes = 0;
  let layout: "attributes-first" | "boxes-first" = "attributes-first";
  if (dims.length === 3) {
    const [, dim1, dim2] = dims;
    if (dim1 <= dim2) {
      attributes = dim1;
      boxes = dim2;
      layout = "attributes-first";
    } else {
      attributes = dim2;
      boxes = dim1;
      layout = "boxes-first";
    }
  } else if (dims.length === 2) {
    [boxes, attributes] = dims;
    layout = "boxes-first";
  } else {
    return [];
  }
  if (boxes <= 0 || attributes <= 0) {
    return [];
  }
  const classCount = classes.length;
  const predictions: PatchPrediction[] = [];
  const readValue = (attrIndex: number, boxIndex: number) => {
    if (layout === "attributes-first") {
      return data[attrIndex * boxes + boxIndex] ?? 0;
    }
    return data[boxIndex * attributes + attrIndex] ?? 0;
  };

  for (let boxIndex = 0; boxIndex < boxes; boxIndex += 1) {
    const x = readValue(0, boxIndex);
    const y = readValue(1, boxIndex);
    const w = readValue(2, boxIndex);
    const h = readValue(3, boxIndex);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      continue;
    }
    let bestClass = "";
    let bestScore = 0;
    if (attributes === 6 && classCount > 0) {
      const score = readValue(4, boxIndex);
      const classId = Math.round(readValue(5, boxIndex));
      if (classId >= 0 && classId < classCount && score >= threshold) {
        bestClass = classes[classId];
        bestScore = score;
      }
    } else {
      const hasObjectness = attributes === 5 + classCount;
      const classOffset = hasObjectness ? 5 : 4;
      const objectness = hasObjectness ? readValue(4, boxIndex) : 1;
      for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        const score = readValue(classOffset + classIndex, boxIndex) * objectness;
        if (score > bestScore) {
          bestScore = score;
          bestClass = classes[classIndex] ?? "";
        }
      }
    }
    if (!bestClass || bestScore < threshold) {
      continue;
    }
    predictions.push({
      class: bestClass,
      confidence: bestScore,
      cx: x,
      cy: y,
      w,
      h
    });
  }
  return predictions;
}

function applyNms(predictions: PatchPrediction[], iouThreshold: number): PatchPrediction[] {
  const byClass = new Map<string, PatchPrediction[]>();
  predictions.forEach((pred) => {
    const list = byClass.get(pred.class) ?? [];
    list.push(pred);
    byClass.set(pred.class, list);
  });
  const results: PatchPrediction[] = [];
  byClass.forEach((list) => {
    list.sort((a, b) => b.confidence - a.confidence);
    const kept: PatchPrediction[] = [];
    list.forEach((candidate) => {
      const overlaps = kept.some((keptPred) => iou(candidate, keptPred) > iouThreshold);
      if (!overlaps) {
        kept.push(candidate);
      }
    });
    results.push(...kept);
  });
  return results;
}

function iou(a: PatchPrediction, b: PatchPrediction): number {
  const aMinX = a.cx - a.w / 2;
  const aMinY = a.cy - a.h / 2;
  const aMaxX = a.cx + a.w / 2;
  const aMaxY = a.cy + a.h / 2;
  const bMinX = b.cx - b.w / 2;
  const bMinY = b.cy - b.h / 2;
  const bMaxX = b.cx + b.w / 2;
  const bMaxY = b.cy + b.h / 2;
  const interX = Math.max(0, Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX));
  const interY = Math.max(0, Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY));
  const interArea = interX * interY;
  if (interArea <= 0) {
    return 0;
  }
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  return interArea / (areaA + areaB - interArea);
}
