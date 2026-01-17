export type PredictionClass =
  | "tree_pine"
  | "tree_deciduous"
  | "dense_cover"
  | "billboard"
  | "stop_sign";

export interface Prediction {
  id: string;
  class: PredictionClass;
  centerLat: number;
  centerLon: number;
  crownRadiusMeters?: number;
  polygonLatLon?: Array<{ lat: number; lon: number }>;
  yawDeg?: number;
  confidence: number;
  regionHintId?: string;
}

export interface PredictionSet {
  version: 1;
  imagery: { providerId: string; zoom: number };
  predictions: Prediction[];
}

export interface PredictionSetParseResult {
  set: PredictionSet;
  invalidCount: number;
}

const PREDICTION_CLASSES = new Set<PredictionClass>([
  "tree_pine",
  "tree_deciduous",
  "dense_cover",
  "billboard",
  "stop_sign"
]);

export function parsePredictionSet(raw: unknown): PredictionSetParseResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<PredictionSet>;
  if (record.version !== 1) {
    return null;
  }
  if (!record.imagery || typeof record.imagery !== "object") {
    return null;
  }
  const imagery = record.imagery as { providerId?: unknown; zoom?: unknown };
  if (typeof imagery.providerId !== "string" || !isFiniteNumber(imagery.zoom)) {
    return null;
  }
  if (!Array.isArray(record.predictions)) {
    return null;
  }
  let invalidCount = 0;
  const predictions = record.predictions
    .map((prediction) => {
      const parsed = parsePrediction(prediction);
      if (!parsed) {
        invalidCount += 1;
      }
      return parsed;
    })
    .filter((value): value is Prediction => Boolean(value));
  if (predictions.length === 0) {
    return null;
  }
  return {
    set: {
      version: 1,
      imagery: {
        providerId: imagery.providerId,
        zoom: imagery.zoom
      },
      predictions
    },
    invalidCount
  };
}

function parsePrediction(raw: unknown): Prediction | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<Prediction>;
  if (typeof record.id !== "string" || !record.id.trim()) {
    return null;
  }
  if (typeof record.class !== "string" || !isPredictionClass(record.class)) {
    return null;
  }
  if (!isFiniteNumber(record.centerLat) || !isFiniteNumber(record.centerLon)) {
    return null;
  }
  if (!isFiniteNumber(record.confidence)) {
    return null;
  }
  if (record.confidence < 0 || record.confidence > 1) {
    return null;
  }

  const parsed: Prediction = {
    id: record.id,
    class: record.class,
    centerLat: record.centerLat,
    centerLon: record.centerLon,
    confidence: record.confidence
  };

  if (isFiniteNumber(record.crownRadiusMeters)) {
    parsed.crownRadiusMeters = record.crownRadiusMeters;
  }
  if (isFiniteNumber(record.yawDeg)) {
    parsed.yawDeg = record.yawDeg;
  }
  if (typeof record.regionHintId === "string") {
    parsed.regionHintId = record.regionHintId;
  }
  if (Array.isArray(record.polygonLatLon)) {
    const polygon = parsePolygon(record.polygonLatLon);
    if (polygon) {
      parsed.polygonLatLon = polygon;
    }
  }

  return parsed;
}

function parsePolygon(raw: Array<unknown>): Array<{ lat: number; lon: number }> | null {
  const points: Array<{ lat: number; lon: number }> = [];
  for (const point of raw) {
    if (!point || typeof point !== "object") {
      return null;
    }
    const record = point as { lat?: unknown; lon?: unknown };
    if (!isFiniteNumber(record.lat) || !isFiniteNumber(record.lon)) {
      return null;
    }
    points.push({ lat: record.lat, lon: record.lon });
  }
  return points.length >= 3 ? points : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPredictionClass(value: string): value is PredictionClass {
  return PREDICTION_CLASSES.has(value as PredictionClass);
}
