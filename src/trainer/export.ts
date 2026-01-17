import { zipSync, strToU8 } from "fflate";
import type { TileSource, TileSourceId } from "../mapTiles";
import { getTileSource } from "../mapTiles";
import type {
  NegativeSample,
  SignLabel,
  TrainerDataset,
  TreeLabel
} from "./dataset/schema";
import { metersPerPixelAtLat } from "./analytics";

const TILE_SIZE = 256;
const DEFAULT_PATCH_SIZE_PX = 512;
const BUNDLE_SCHEMA_VERSION = 1;

export interface ExportProgress {
  completed: number;
  total: number;
  label: string;
}

export interface TrainingBundle {
  schemaVersion: number;
  createdAt: string;
  imagery: {
    providerId: string;
    zoom: number;
  };
  patchSizePx: number;
  samples: TrainingSample[];
  sourceDataset?: TrainerDataset;
}

export interface TrainingSample {
  id: string;
  kind: "tree" | "sign" | "negative";
  labelId?: string;
  regionId?: string;
  centerLat: number;
  centerLon: number;
  zoom: number;
  sizePx: number;
  imagePath: string;
  annotations: TrainingAnnotation[];
}

export type TrainingAnnotation = TreeAnnotation | SignAnnotation;

export interface TreeAnnotation {
  kind: "tree";
  class: TreeLabel["class"];
  centerPx: { x: number; y: number };
  radiusPx: number;
  derivedHeightMeters: number;
}

export interface SignAnnotation {
  kind: "sign";
  class: SignLabel["class"];
  centerPx: { x: number; y: number };
  yawDeg?: number;
}

export async function exportTrainingBundle(
  dataset: TrainerDataset,
  options?: {
    patchSizePx?: number;
    zoom?: number;
    includeSourceDataset?: boolean;
    onProgress?: (progress: ExportProgress) => void;
  }
): Promise<Blob> {
  const tileSource = resolveTileSource(dataset.imagery.providerId);
  const zoom = normalizeZoom(options?.zoom ?? dataset.imagery.zoom, tileSource.maxZoom);
  const patchSizePx = normalizeSizePx(options?.patchSizePx ?? DEFAULT_PATCH_SIZE_PX);

  const samples = buildSamples(dataset, zoom, patchSizePx, tileSource).sort((a, b) =>
    a.id.localeCompare(b.id)
  );

  const total = samples.length;
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    options?.onProgress?.({
      completed: i,
      total,
      label: `Rendering ${sample.id}`
    });
    const canvas = await renderPatchImage({
      centerLatLon: { lat: sample.centerLat, lon: sample.centerLon },
      zoom: sample.zoom,
      sizePx: sample.sizePx,
      tileSource
    });
    files[sample.imagePath] = await canvasToPngBytes(canvas);
    options?.onProgress?.({
      completed: i + 1,
      total,
      label: `Rendered ${sample.id}`
    });
  }

  const bundle: TrainingBundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    imagery: {
      providerId: dataset.imagery.providerId,
      zoom
    },
    patchSizePx,
    samples
  };
  if (options?.includeSourceDataset !== false) {
    bundle.sourceDataset = dataset;
  }

  files["dataset.json"] = strToU8(JSON.stringify(bundle, null, 2));
  options?.onProgress?.({
    completed: total,
    total,
    label: "Zipping bundle"
  });

  const zipped = zipSync(files, { level: 0 });
  const zipData = new Uint8Array(zipped);
  return new Blob([zipData], { type: "application/zip" });
}

export async function renderPatchImage(input: {
  centerLatLon: { lat: number; lon: number };
  zoom: number;
  sizePx: number;
  tileSource: TileSource;
}): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  const sizePx = Math.max(1, Math.floor(input.sizePx));
  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for patch render");
  }
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, sizePx, sizePx);

  const zoom = normalizeZoom(input.zoom, input.tileSource.maxZoom);
  const center = projectLatLon(input.centerLatLon.lat, input.centerLatLon.lon, zoom);
  const half = sizePx / 2;
  const topLeft = { x: center.x - half, y: center.y - half };
  const bottomRight = { x: center.x + half, y: center.y + half };

  const minTileX = Math.floor(topLeft.x / TILE_SIZE);
  const maxTileX = Math.floor((bottomRight.x - 1) / TILE_SIZE);
  const minTileY = Math.floor(topLeft.y / TILE_SIZE);
  const maxTileY = Math.floor((bottomRight.y - 1) / TILE_SIZE);
  const maxTiles = Math.pow(2, zoom);

  const tilePromises: Promise<TileRender | null>[] = [];
  for (let x = minTileX; x <= maxTileX; x += 1) {
    const wrappedX = wrapTile(x, maxTiles);
    for (let y = minTileY; y <= maxTileY; y += 1) {
      if (y < 0 || y >= maxTiles) {
        continue;
      }
      const url = input.tileSource.url
        .replace("{z}", zoom.toString())
        .replace("{x}", wrappedX.toString())
        .replace("{y}", y.toString());
      tilePromises.push(
        loadTileImage(url)
          .then((image) => ({ image, x, y }))
          .catch(() => null)
      );
    }
  }

  const tiles = await Promise.all(tilePromises);
  if (input.tileSource.renderFilter) {
    ctx.save();
    ctx.filter = input.tileSource.renderFilter;
  }
  try {
    tiles.forEach((tile) => {
      if (!tile) return;
      const drawX = tile.x * TILE_SIZE - topLeft.x;
      const drawY = tile.y * TILE_SIZE - topLeft.y;
      ctx.drawImage(tile.image, drawX, drawY, TILE_SIZE, TILE_SIZE);
    });
  } finally {
    if (input.tileSource.renderFilter) {
      ctx.restore();
    }
  }

  return canvas;
}

interface TileRender {
  image: HTMLImageElement;
  x: number;
  y: number;
}

const tileCache = new Map<string, Promise<HTMLImageElement>>();

function loadTileImage(url: string): Promise<HTMLImageElement> {
  const cached = tileCache.get(url);
  if (cached) {
    return cached;
  }
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = url;
  });
  tileCache.set(url, promise);
  return promise;
}

function resolveTileSource(providerId: string): TileSource {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === "street" || normalized.includes("osm")) {
    return getTileSource("street");
  }
  if (normalized === "autostreet" || normalized === "auto_street" || normalized === "auto-street") {
    return getTileSource("autoStreet");
  }
  if (normalized === "satellite" || normalized.includes("esri") || normalized.includes("imagery")) {
    return getTileSource("satellite");
  }
  if (isTileSourceId(providerId)) {
    return getTileSource(providerId);
  }
  return getTileSource("satellite");
}

function isTileSourceId(value: string): value is TileSourceId {
  return value === "street" || value === "satellite" || value === "autoStreet";
}

function buildSamples(
  dataset: TrainerDataset,
  zoom: number,
  patchSizePx: number,
  tileSource: TileSource
): TrainingSample[] {
  const treeSamples = [...dataset.trees]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((tree) => createTreeSample(tree, zoom, patchSizePx));
  const signSamples = [...dataset.signs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((sign) => createSignSample(sign, zoom, patchSizePx));
  const negativeSamples = [...dataset.negatives]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((negative) => createNegativeSample(negative, tileSource.maxZoom));
  return [...treeSamples, ...signSamples, ...negativeSamples];
}

function createTreeSample(tree: TreeLabel, zoom: number, patchSizePx: number): TrainingSample {
  const metersPerPixel = metersPerPixelAtLat(tree.centerLat, zoom);
  const radiusPx =
    metersPerPixel > 0 ? tree.crownRadiusMeters / metersPerPixel : 0;
  return {
    id: tree.id,
    kind: "tree",
    labelId: tree.id,
    regionId: tree.regionId,
    centerLat: tree.centerLat,
    centerLon: tree.centerLon,
    zoom,
    sizePx: patchSizePx,
    imagePath: `images/${tree.id}.png`,
    annotations: [
      {
        kind: "tree",
        class: tree.class,
        centerPx: { x: patchSizePx / 2, y: patchSizePx / 2 },
        radiusPx,
        derivedHeightMeters: tree.derivedHeightMeters
      }
    ]
  };
}

function createSignSample(sign: SignLabel, zoom: number, patchSizePx: number): TrainingSample {
  return {
    id: sign.id,
    kind: "sign",
    labelId: sign.id,
    regionId: sign.regionId,
    centerLat: sign.lat,
    centerLon: sign.lon,
    zoom,
    sizePx: patchSizePx,
    imagePath: `images/${sign.id}.png`,
    annotations: [
      {
        kind: "sign",
        class: sign.class,
        centerPx: { x: patchSizePx / 2, y: patchSizePx / 2 },
        yawDeg: sign.yawDeg
      }
    ]
  };
}

function createNegativeSample(
  negative: NegativeSample,
  maxZoom: number
): TrainingSample {
  const zoom = normalizeZoom(negative.zoom, maxZoom);
  const sizePx = normalizeSizePx(negative.sizePx);
  return {
    id: negative.id,
    kind: "negative",
    regionId: negative.regionId,
    centerLat: negative.centerLat,
    centerLon: negative.centerLon,
    zoom,
    sizePx,
    imagePath: `images/${negative.id}.png`,
    annotations: []
  };
}

function normalizeZoom(value: number, maxZoom: number): number {
  if (!Number.isFinite(value)) {
    return Math.max(0, Math.min(19, maxZoom));
  }
  return Math.max(0, Math.min(maxZoom, Math.round(value)));
}

function normalizeSizePx(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PATCH_SIZE_PX;
  }
  return Math.max(64, Math.round(value));
}

function wrapTile(value: number, max: number): number {
  const mod = ((value % max) + max) % max;
  return mod;
}

function projectLatLon(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (!value) {
        reject(new Error("Failed to encode PNG."));
        return;
      }
      resolve(value);
    }, "image/png");
  });
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}
