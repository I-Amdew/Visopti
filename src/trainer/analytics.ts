import type {
  DatasetRegion,
  SignLabel,
  TrainerDataset,
  TreeLabel
} from "./dataset/schema";

const EARTH_RADIUS_M = 6371000;
const FEET_PER_METER = 3.28084;
const DEG_TO_RAD = Math.PI / 180;

export interface HistogramBin {
  min: number;
  max: number;
  count: number;
}

export interface Histogram {
  bins: HistogramBin[];
  min: number;
  max: number;
  maxCount: number;
}

export interface DatasetAnalytics {
  counts: {
    pine: number;
    deciduous: number;
    billboard: number;
    stopSign: number;
    totalTrees: number;
    totalSigns: number;
    totalNegatives: number;
    totalSamples: number;
    denseCoverSamples: number;
    denseCoverPolygons: number;
    regions: number;
  };
  radiusHistogram: Histogram;
  heightHistogram: Histogram;
  scatter: Array<{ x: number; y: number }>;
  treeStats: {
    averageRadiusMeters: number;
    averageHeightMeters: number;
  };
  denseCoverAreaM2: number;
  denseCoverAreaFt2: number;
}

export interface NegativePatchCenter {
  centerLat: number;
  centerLon: number;
}

export function metersPerPixelAtLat(lat: number, zoom: number): number {
  if (!Number.isFinite(lat) || !Number.isFinite(zoom)) {
    return 0;
  }
  const clampedZoom = Math.max(0, Math.round(zoom));
  const latRad = lat * DEG_TO_RAD;
  const circumference = 2 * Math.PI * 6378137;
  return (Math.cos(latRad) * circumference) / (256 * Math.pow(2, clampedZoom));
}

export function computeDatasetAnalytics(dataset: TrainerDataset): DatasetAnalytics {
  const samples = Array.isArray(dataset.samples) ? dataset.samples : [];
  const sampleCounts = countSampleClasses(samples);
  const pine = sampleCounts.tree_pine;
  const deciduous = sampleCounts.tree_deciduous;
  const billboard = sampleCounts.billboard;
  const stopSign = sampleCounts.stop_sign;
  const totalTrees = dataset.trees.length;
  const totalSigns = dataset.signs.length;
  const totalNegatives = sampleCounts.negative;
  const totalSamples = samples.length;
  const denseCoverSamples = sampleCounts.dense_cover;
  const denseCoverPolygons = dataset.denseCover.length;
  const regions = dataset.regions.length;

  const radiusValues = dataset.trees
    .map((tree) => tree.crownRadiusMeters)
    .filter((value) => Number.isFinite(value) && value > 0);
  const heightValues = dataset.trees
    .map((tree) => tree.derivedHeightMeters)
    .filter((value) => Number.isFinite(value) && value > 0);
  const scatter = dataset.trees
    .map((tree) => ({ x: tree.crownRadiusMeters, y: tree.derivedHeightMeters }))
    .filter(
      (point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x > 0 &&
        point.y > 0
    );

  const denseCoverAreaM2 = dataset.denseCover.reduce((sum, dense) => {
    return sum + computePolygonAreaMeters(dense.polygonLatLon);
  }, 0);

  const averageRadiusMeters = average(radiusValues);
  const averageHeightMeters = average(heightValues);

  return {
    counts: {
      pine,
      deciduous,
      billboard,
      stopSign,
      totalTrees,
      totalSigns,
      totalNegatives,
      totalSamples,
      denseCoverSamples,
      denseCoverPolygons,
      regions
    },
    radiusHistogram: buildHistogram(radiusValues, 8),
    heightHistogram: buildHistogram(heightValues, 8),
    scatter,
    treeStats: {
      averageRadiusMeters,
      averageHeightMeters
    },
    denseCoverAreaM2,
    denseCoverAreaFt2: denseCoverAreaM2 * FEET_PER_METER * FEET_PER_METER
  };
}

export function sampleNegativePatches(
  region: DatasetRegion,
  labels: { trees: TreeLabel[]; signs: SignLabel[] },
  patchSizeMeters: number,
  numPatches: number,
  options?: { marginMeters?: number; signBufferMeters?: number; seed?: string }
): NegativePatchCenter[] {
  if (region.boundsPolygonLatLon.length < 3) {
    return [];
  }
  if (!Number.isFinite(patchSizeMeters) || patchSizeMeters <= 0) {
    return [];
  }
  const safeCount = Math.max(0, Math.floor(numPatches));
  if (safeCount === 0) {
    return [];
  }

  const projection = buildLocalProjection(region.boundsPolygonLatLon);
  if (!projection) {
    return [];
  }

  const polygon = region.boundsPolygonLatLon.map((point) => toLocalPoint(point, projection));
  const bounds = computeBounds(polygon);
  if (!bounds) {
    return [];
  }

  const trees = labels.trees
    .map((tree) => ({
      point: toLocalPoint({ lat: tree.centerLat, lon: tree.centerLon }, projection),
      radius: Math.max(0, tree.crownRadiusMeters)
    }))
    .filter((entry) => Number.isFinite(entry.point.x) && Number.isFinite(entry.point.y));

  const signs = labels.signs
    .map((sign) => ({
      point: toLocalPoint({ lat: sign.lat, lon: sign.lon }, projection)
    }))
    .filter((entry) => Number.isFinite(entry.point.x) && Number.isFinite(entry.point.y));

  const marginMeters = Math.max(0, options?.marginMeters ?? 1);
  const signBufferMeters = Math.max(0, options?.signBufferMeters ?? 2);
  const patchRadius = (patchSizeMeters * Math.SQRT2) / 2;
  const seedBase =
    options?.seed ??
    `${region.id}:${labels.trees.map((tree) => tree.id).sort().join(",")}:` +
      `${labels.signs.map((sign) => sign.id).sort().join(",")}`;
  const rng = createSeededRandom(seedBase);

  const results: NegativePatchCenter[] = [];
  const maxAttempts = Math.max(50, safeCount * 60);
  for (let attempt = 0; attempt < maxAttempts && results.length < safeCount; attempt += 1) {
    const candidate = {
      x: bounds.minX + rng() * (bounds.maxX - bounds.minX),
      y: bounds.minY + rng() * (bounds.maxY - bounds.minY)
    };
    if (!pointInPolygon(candidate, polygon)) {
      continue;
    }
    if (intersectsTrees(candidate, patchRadius, trees, marginMeters)) {
      continue;
    }
    if (intersectsSigns(candidate, patchRadius, signs, signBufferMeters)) {
      continue;
    }
    const latLon = toLatLon(candidate, projection);
    results.push({ centerLat: latLon.lat, centerLon: latLon.lon });
  }

  return results;
}

interface LocalPoint {
  x: number;
  y: number;
}

interface LocalProjection {
  originLat: number;
  originLon: number;
  metersPerDegLat: number;
  metersPerDegLon: number;
}

function buildHistogram(values: number[], binCount: number): Histogram {
  if (values.length === 0 || binCount <= 0) {
    return { bins: [], min: 0, max: 0, maxCount: 0 };
  }
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min = 0;
    max = min + 1;
  }
  const bins: HistogramBin[] = [];
  const width = (max - min) / binCount;
  for (let i = 0; i < binCount; i += 1) {
    const start = min + i * width;
    bins.push({ min: start, max: start + width, count: 0 });
  }
  values.forEach((value) => {
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[index].count += 1;
  });
  const maxCount = Math.max(...bins.map((bin) => bin.count), 0);
  return { bins, min, max, maxCount };
}

function countSampleClasses(samples: TrainerDataset["samples"]): Record<string, number> {
  const counts: Record<string, number> = {
    tree_pine: 0,
    tree_deciduous: 0,
    dense_cover: 0,
    billboard: 0,
    stop_sign: 0,
    negative: 0
  };
  samples.forEach((sample) => {
    if (sample.class in counts) {
      counts[sample.class] += 1;
    }
  });
  return counts;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function computePolygonAreaMeters(points: Array<{ lat: number; lon: number }>): number {
  if (points.length < 3) {
    return 0;
  }
  const projection = buildLocalProjection(points);
  if (!projection) {
    return 0;
  }
  const local = points.map((point) => toLocalPoint(point, projection));
  let areaSum = 0;
  for (let i = 0; i < local.length; i += 1) {
    const current = local[i];
    const next = local[(i + 1) % local.length];
    areaSum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(areaSum) / 2;
}

function buildLocalProjection(points: Array<{ lat: number; lon: number }>): LocalProjection | null {
  const origin = averageLatLon(points);
  if (!origin) {
    return null;
  }
  const metersPerDegLat = EARTH_RADIUS_M * DEG_TO_RAD;
  const metersPerDegLon = metersPerDegLat * Math.cos(origin.lat * DEG_TO_RAD);
  if (!Number.isFinite(metersPerDegLon) || Math.abs(metersPerDegLon) < 1e-6) {
    return null;
  }
  return {
    originLat: origin.lat,
    originLon: origin.lon,
    metersPerDegLat,
    metersPerDegLon
  };
}

function averageLatLon(points: Array<{ lat: number; lon: number }>): { lat: number; lon: number } | null {
  if (points.length === 0) {
    return null;
  }
  let latSum = 0;
  let lonSum = 0;
  points.forEach((point) => {
    latSum += point.lat;
    lonSum += point.lon;
  });
  return { lat: latSum / points.length, lon: lonSum / points.length };
}

function toLocalPoint(point: { lat: number; lon: number }, projection: LocalProjection): LocalPoint {
  return {
    x: (point.lon - projection.originLon) * projection.metersPerDegLon,
    y: (point.lat - projection.originLat) * projection.metersPerDegLat
  };
}

function toLatLon(point: LocalPoint, projection: LocalProjection): { lat: number; lon: number } {
  return {
    lat: projection.originLat + point.y / projection.metersPerDegLat,
    lon: projection.originLon + point.x / projection.metersPerDegLon
  };
}

function computeBounds(points: LocalPoint[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} | null {
  if (points.length === 0) {
    return null;
  }
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, maxX, minY, maxY };
}

function pointInPolygon(point: LocalPoint, polygon: LocalPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function intersectsTrees(
  point: LocalPoint,
  patchRadius: number,
  trees: Array<{ point: LocalPoint; radius: number }>,
  marginMeters: number
): boolean {
  for (const tree of trees) {
    const limit = tree.radius + patchRadius + marginMeters;
    const distance = Math.hypot(point.x - tree.point.x, point.y - tree.point.y);
    if (distance <= limit) {
      return true;
    }
  }
  return false;
}

function intersectsSigns(
  point: LocalPoint,
  patchRadius: number,
  signs: Array<{ point: LocalPoint }>,
  signBufferMeters: number
): boolean {
  for (const sign of signs) {
    const limit = signBufferMeters + patchRadius;
    const distance = Math.hypot(point.x - sign.point.x, point.y - sign.point.y);
    if (distance <= limit) {
      return true;
    }
  }
  return false;
}

function createSeededRandom(seed: string): () => number {
  let value = hashString(seed);
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
