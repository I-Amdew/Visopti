import type {
  GeoBounds,
  GeoPoint,
  GeoProjector,
  MapPoint,
  Sign,
  SignKind,
  Tree,
  TreeType
} from "../types";
import type { TileSourceId } from "../mapTiles";
import {
  DEFAULT_SIGN_DIMENSIONS,
  DEFAULT_SIGN_KIND,
  DEFAULT_SIGN_YAW_DEGREES,
  DEFAULT_TREE_RADIUS_METERS,
  DEFAULT_TREE_TYPE,
  deriveTreeHeightMeters
} from "../obstacles";

export const LABEL_SCHEMA_VERSION = 1;

export interface LabelFrame {
  bounds: GeoBounds;
  size?: { width: number; height: number };
  zoom?: number;
}

export interface LabelImagery {
  basemapId?: TileSourceId;
  label?: string;
  url?: string;
  attribution?: string;
}

export interface LabelDataset {
  schemaVersion: number;
  createdAt: string;
  frame: LabelFrame;
  imagery?: LabelImagery;
  objects: LabelObject[];
}

export interface LabelObjectBase {
  id?: string;
  location: GeoPoint;
  confidence?: number;
}

export interface TreeLabel extends LabelObjectBase {
  kind: "tree";
  type: TreeType;
  crownRadiusMeters: number;
  heightMeters?: number;
}

export interface SignLabel extends LabelObjectBase {
  kind: "sign";
  signKind: SignKind;
  widthMeters: number;
  heightMeters: number;
  bottomClearanceMeters?: number;
  yawDegrees?: number;
}

export type LabelObject = TreeLabel | SignLabel;

export function buildLabelDataset(input: {
  bounds: GeoBounds;
  frameSize?: { width: number; height: number } | null;
  zoom?: number | null;
  imagery?: LabelImagery;
  trees: Tree[];
  signs: Sign[];
  projector?: GeoProjector | null;
}): { dataset: LabelDataset; warnings: string[] } {
  const warnings: string[] = [];
  const objects: LabelObject[] = [];

  input.trees.forEach((tree) => {
    const location = resolveLatLon(tree.location, input.projector ?? null);
    if (!location) {
      warnings.push(`Tree ${tree.id} skipped (no lat/lon).`);
      return;
    }
    const type = normalizeTreeType(tree.type) ?? DEFAULT_TREE_TYPE;
    const radius = normalizePositiveNumber(tree.baseRadiusMeters, DEFAULT_TREE_RADIUS_METERS);
    if (!Number.isFinite(tree.baseRadiusMeters) || tree.baseRadiusMeters <= 0) {
      warnings.push(`Tree ${tree.id} radius defaulted.`);
    }
    const entry: TreeLabel = {
      kind: "tree",
      id: tree.id,
      location,
      type,
      crownRadiusMeters: radius
    };
    if (Number.isFinite(tree.heightMeters) && tree.heightMeters > 0) {
      entry.heightMeters = tree.heightMeters;
    }
    objects.push(entry);
  });

  input.signs.forEach((sign) => {
    const location = resolveLatLon(sign.location, input.projector ?? null);
    if (!location) {
      warnings.push(`Sign ${sign.id} skipped (no lat/lon).`);
      return;
    }
    const signKind = normalizeSignKind(sign.kind) ?? DEFAULT_SIGN_KIND;
    const defaults = DEFAULT_SIGN_DIMENSIONS[signKind];
    const widthMeters = normalizePositiveNumber(sign.widthMeters, defaults.widthMeters);
    const heightMeters = normalizePositiveNumber(sign.heightMeters, defaults.heightMeters);
    const bottomClearanceMeters = normalizeNonNegativeNumber(
      sign.bottomClearanceMeters,
      defaults.bottomClearanceMeters
    );
    const yawDegrees = normalizeNumber(sign.yawDegrees, DEFAULT_SIGN_YAW_DEGREES);
    objects.push({
      kind: "sign",
      id: sign.id,
      location,
      signKind,
      widthMeters,
      heightMeters,
      bottomClearanceMeters,
      yawDegrees
    });
  });

  const dataset: LabelDataset = {
    schemaVersion: LABEL_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    frame: {
      bounds: input.bounds,
      size: input.frameSize ?? undefined,
      zoom: Number.isFinite(input.zoom) ? (input.zoom as number) : undefined
    },
    imagery: input.imagery,
    objects
  };

  return { dataset, warnings };
}

export function parseLabelDataset(raw: unknown): { dataset: LabelDataset; warnings: string[] } {
  if (!isRecord(raw)) {
    throw new Error("Invalid label dataset.");
  }
  const warnings: string[] = [];
  const schemaVersion = normalizeNumber(raw.schemaVersion, LABEL_SCHEMA_VERSION);
  const frame = readFrame(raw.frame, warnings);
  if (!frame) {
    throw new Error("Label dataset missing frame bounds.");
  }
  const imagery = readImagery(raw.imagery);
  const createdAt =
    typeof raw.createdAt === "string" && raw.createdAt.trim()
      ? raw.createdAt
      : new Date().toISOString();
  const objects: LabelObject[] = [];
  const rawObjects = Array.isArray(raw.objects) ? raw.objects : [];
  rawObjects.forEach((obj, index) => {
    const parsed = readLabelObject(obj, warnings, index);
    if (parsed) {
      objects.push(parsed);
    }
  });

  return {
    dataset: {
      schemaVersion,
      createdAt,
      frame,
      imagery,
      objects
    },
    warnings
  };
}

export function buildPredictionFeatures(
  dataset: LabelDataset,
  options: { createId: (prefix: string) => string }
): { trees: Tree[]; signs: Sign[]; warnings: string[] } {
  const warnings: string[] = [];
  const trees: Tree[] = [];
  const signs: Sign[] = [];
  dataset.objects.forEach((obj) => {
    if (obj.kind === "tree") {
      const radius = normalizePositiveNumber(obj.crownRadiusMeters, DEFAULT_TREE_RADIUS_METERS);
      if (!Number.isFinite(obj.crownRadiusMeters) || obj.crownRadiusMeters <= 0) {
        warnings.push("Tree prediction radius defaulted.");
      }
      const heightMeters = normalizePositiveNumber(
        obj.heightMeters,
        deriveTreeHeightMeters(radius)
      );
      const id = normalizeId(obj.id) ?? options.createId("ml-tree");
      trees.push({
        id,
        location: obj.location,
        type: normalizeTreeType(obj.type) ?? DEFAULT_TREE_TYPE,
        baseRadiusMeters: radius,
        heightMeters,
        heightSource: "ml"
      });
      return;
    }

    const signKind = normalizeSignKind(obj.signKind) ?? DEFAULT_SIGN_KIND;
    const defaults = DEFAULT_SIGN_DIMENSIONS[signKind];
    const widthMeters = normalizePositiveNumber(obj.widthMeters, defaults.widthMeters);
    const heightMeters = normalizePositiveNumber(obj.heightMeters, defaults.heightMeters);
    const bottomClearanceMeters = normalizeNonNegativeNumber(
      obj.bottomClearanceMeters,
      defaults.bottomClearanceMeters
    );
    const yawDegrees = normalizeNumber(obj.yawDegrees, DEFAULT_SIGN_YAW_DEGREES);
    const id = normalizeId(obj.id) ?? options.createId("ml-sign");
    signs.push({
      id,
      location: obj.location,
      kind: signKind,
      widthMeters,
      heightMeters,
      bottomClearanceMeters,
      yawDegrees,
      heightSource: "ml"
    });
  });

  return { trees, signs, warnings };
}

function resolveLatLon(point: MapPoint, projector: GeoProjector | null): GeoPoint | null {
  if ("lat" in point && "lon" in point) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      return null;
    }
    return { lat: point.lat, lon: point.lon };
  }
  if ("x" in point && "y" in point) {
    if (!projector) {
      return null;
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    return projector.pixelToLatLon(point.x, point.y);
  }
  return null;
}

function readFrame(value: unknown, warnings: string[]): LabelFrame | null {
  if (!isRecord(value)) {
    return null;
  }
  const bounds = readBounds(value.bounds);
  if (!bounds) {
    warnings.push("Frame bounds missing.");
    return null;
  }
  const size = readSize(value.size);
  const zoom = normalizeNumber(value.zoom, NaN);
  return {
    bounds,
    size: size ?? undefined,
    zoom: Number.isFinite(zoom) ? zoom : undefined
  };
}

function readImagery(value: unknown): LabelImagery | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const imagery: LabelImagery = {};
  if (typeof value.basemapId === "string") {
    imagery.basemapId = value.basemapId as TileSourceId;
  }
  if (typeof value.label === "string") {
    imagery.label = value.label;
  }
  if (typeof value.url === "string") {
    imagery.url = value.url;
  }
  if (typeof value.attribution === "string") {
    imagery.attribution = value.attribution;
  }
  return Object.keys(imagery).length > 0 ? imagery : undefined;
}

function readBounds(value: unknown): GeoBounds | null {
  if (!isRecord(value)) {
    return null;
  }
  const north = normalizeNumber(value.north, NaN);
  const south = normalizeNumber(value.south, NaN);
  const east = normalizeNumber(value.east, NaN);
  const west = normalizeNumber(value.west, NaN);
  if (
    !Number.isFinite(north) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(west)
  ) {
    return null;
  }
  return { north, south, east, west };
}

function readSize(value: unknown): { width: number; height: number } | null {
  if (!isRecord(value)) {
    return null;
  }
  const width = normalizeNumber(value.width, NaN);
  const height = normalizeNumber(value.height, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return { width, height };
}

function readLabelObject(
  value: unknown,
  warnings: string[],
  index: number
): LabelObject | null {
  if (!isRecord(value)) {
    warnings.push(`Object ${index + 1} is not valid.`);
    return null;
  }
  const kind = value.kind;
  const location = readGeoPoint(value.location);
  if (!location) {
    warnings.push(`Object ${index + 1} missing location.`);
    return null;
  }
  const confidence = normalizeNumber(value.confidence, NaN);
  const base: LabelObjectBase = {
    id: normalizeId(value.id) ?? undefined,
    location,
    confidence: Number.isFinite(confidence) ? confidence : undefined
  };

  if (kind === "tree") {
    const type = normalizeTreeType(value.type) ?? DEFAULT_TREE_TYPE;
    const crownRadiusMeters = normalizePositiveNumber(
      value.crownRadiusMeters,
      DEFAULT_TREE_RADIUS_METERS
    );
    if (!Number.isFinite(value.crownRadiusMeters) || value.crownRadiusMeters <= 0) {
      warnings.push(`Tree ${index + 1} radius defaulted.`);
    }
    const heightMeters = normalizePositiveNumber(value.heightMeters, NaN);
    return {
      ...base,
      kind: "tree",
      type,
      crownRadiusMeters,
      heightMeters: Number.isFinite(heightMeters) ? heightMeters : undefined
    };
  }

  if (kind === "sign") {
    const signKind = normalizeSignKind(value.signKind) ?? DEFAULT_SIGN_KIND;
    const defaults = DEFAULT_SIGN_DIMENSIONS[signKind];
    const widthMeters = normalizePositiveNumber(value.widthMeters, defaults.widthMeters);
    const heightMeters = normalizePositiveNumber(value.heightMeters, defaults.heightMeters);
    const bottomClearanceMeters = normalizeNonNegativeNumber(
      value.bottomClearanceMeters,
      defaults.bottomClearanceMeters
    );
    const yawDegrees = normalizeNumber(value.yawDegrees, DEFAULT_SIGN_YAW_DEGREES);
    return {
      ...base,
      kind: "sign",
      signKind,
      widthMeters,
      heightMeters,
      bottomClearanceMeters,
      yawDegrees
    };
  }

  warnings.push(`Object ${index + 1} has unknown kind.`);
  return null;
}

function readGeoPoint(value: unknown): GeoPoint | null {
  if (!isRecord(value)) {
    return null;
  }
  const lat = normalizeNumber(value.lat, NaN);
  const lon = normalizeNumber(value.lon, NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat, lon };
}

function normalizeTreeType(value: unknown): TreeType | null {
  if (value === "pine" || value === "deciduous") {
    return value;
  }
  return null;
}

function normalizeSignKind(value: unknown): SignKind | null {
  if (value === "billboard" || value === "sign") {
    return value;
  }
  return null;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (!Number.isFinite(value as number) || (value as number) <= 0) {
    return fallback;
  }
  return value as number;
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  if (!Number.isFinite(value as number) || (value as number) < 0) {
    return fallback;
  }
  return value as number;
}

function normalizeNumber(value: unknown, fallback: number): number {
  if (!Number.isFinite(value as number)) {
    return fallback;
  }
  return value as number;
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
