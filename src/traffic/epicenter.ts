import type { Building, LatLon, Road } from "./types";
import { resolveLaneCounts } from "./lanes";

const METERS_PER_DEG_LAT = 111_320;
const MIN_METERS_PER_DEG_LON = 1e-6;

const ROAD_CLASS_WEIGHTS: Record<string, number> = {
  motorway: 1.6,
  motorway_link: 1.3,
  trunk: 1.45,
  trunk_link: 1.25,
  primary: 1.3,
  primary_link: 1.15,
  secondary: 1.15,
  secondary_link: 1.05,
  tertiary: 1.0,
  tertiary_link: 0.95,
  residential: 0.85,
  unclassified: 0.8,
  service: 0.7,
  living_street: 0.55,
  track: 0.4,
  path: 0.25,
  cycleway: 0.25,
  footway: 0.2,
  pedestrian: 0.25,
  construction: 0.35,
  unknown: 0.7
};

export interface JobCenterEpicenterInput {
  simBounds: { north: number; south: number; east: number; west: number };
  roads: Road[];
  buildings?: Building[];
}

export interface JobCenterEpicenter {
  lat: number;
  lon: number;
  weight: number;
  reason: string;
}

export function inferJobCenterEpicenters({
  simBounds,
  roads,
  buildings
}: JobCenterEpicenterInput): JobCenterEpicenter[] {
  const latSpan = simBounds.north - simBounds.south;
  const lonSpan = simBounds.east - simBounds.west;
  if (!(latSpan > 0) || !(lonSpan > 0)) {
    return [];
  }

  const latMid = (simBounds.north + simBounds.south) / 2;
  const widthM = Math.abs(lonSpan) * metersPerDegreeLon(latMid);
  const heightM = Math.abs(latSpan) * METERS_PER_DEG_LAT;
  if (!(widthM > 0) || !(heightM > 0)) {
    return [];
  }

  const cellSizeM = clamp(Math.min(widthM, heightM) / 6, 200, 900);
  const rows = clampInt(Math.round(heightM / cellSizeM), 4, 18);
  const cols = clampInt(Math.round(widthM / cellSizeM), 4, 18);
  const buildingScores = new Array(rows * cols).fill(0);
  const roadScores = new Array(rows * cols).fill(0);

  const footprintBuildings = buildings ?? [];
  for (const building of footprintBuildings) {
    const centroid = getBuildingCentroid(building);
    if (!centroid) {
      continue;
    }
    const areaM2 = getBuildingAreaM2(building);
    const heightM = inferBuildingHeight(areaM2);
    const weight = areaM2 > 0 ? areaM2 * heightM : 80;
    const idx = gridIndexForPoint(centroid, simBounds, rows, cols);
    buildingScores[idx] += weight;
  }

  for (const road of roads) {
    if (!road.points || road.points.length < 2) {
      continue;
    }
    const laneCounts = resolveLaneCounts(road);
    const laneWeight = Math.max(1, laneCounts.total);
    const classWeight = roadClassWeight(road.class);
    for (let i = 0; i < road.points.length - 1; i += 1) {
      const start = road.points[i];
      const end = road.points[i + 1];
      const mid = { lat: (start.lat + end.lat) / 2, lon: (start.lon + end.lon) / 2 };
      const lengthM = segmentLengthMeters(start, end);
      const weight = lengthM * laneWeight * classWeight;
      if (weight <= 0) {
        continue;
      }
      const idx = gridIndexForPoint(mid, simBounds, rows, cols);
      roadScores[idx] += weight;
    }
  }

  const buildingMax = Math.max(0, ...buildingScores);
  const roadMax = Math.max(0, ...roadScores);
  if (buildingMax === 0 && roadMax === 0) {
    return [];
  }
  const buildingShare = buildingMax > 0 ? 0.65 : 0;
  const roadShare = roadMax > 0 ? (buildingMax > 0 ? 0.35 : 1) : 0;

  const candidates: Array<{ row: number; col: number; score: number }> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const idx = row * cols + col;
      const buildingScore = buildingMax > 0 ? buildingScores[idx] / buildingMax : 0;
      const roadScore = roadMax > 0 ? roadScores[idx] / roadMax : 0;
      const score = buildingScore * buildingShare + roadScore * roadShare;
      if (score > 0) {
        candidates.push({ row, col, score });
      }
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.row !== b.row) {
      return a.row - b.row;
    }
    return a.col - b.col;
  });

  const selected: Array<{ row: number; col: number; score: number }> = [];
  const minSeparationM = cellSizeM * 1.5;
  for (const candidate of candidates) {
    if (selected.length === 0) {
      selected.push(candidate);
    } else if (selected.length === 1) {
      const first = selected[0];
      const dist = gridCellDistanceMeters(first, candidate, simBounds, rows, cols);
      if (dist >= minSeparationM) {
        selected.push(candidate);
      }
    }
    if (selected.length >= 2) {
      break;
    }
  }
  if (!selected.length) {
    return [];
  }

  const totalScore = selected.reduce((sum, cell) => sum + cell.score, 0);
  return selected.map((cell) => {
    const point = gridCellCenter(cell, simBounds, rows, cols);
    const buildingScore = buildingScores[cell.row * cols + cell.col];
    const roadScore = roadScores[cell.row * cols + cell.col];
    const reason = buildingScore >= roadScore ? "buildings" : "roads";
    return {
      lat: point.lat,
      lon: point.lon,
      weight: totalScore > 0 ? cell.score / totalScore : 1 / selected.length,
      reason
    };
  });
}

function getBuildingCentroid(building: Building): LatLon | null {
  if (building.centroid) {
    return building.centroid;
  }
  const points = building.outline || building.points || building.polygon;
  if (!points || points.length === 0) {
    return null;
  }
  let sumLat = 0;
  let sumLon = 0;
  for (const point of points) {
    sumLat += point.lat;
    sumLon += point.lon;
  }
  return { lat: sumLat / points.length, lon: sumLon / points.length };
}

function getBuildingAreaM2(building: Building): number {
  const points = building.outline || building.points || building.polygon;
  if (!points || points.length < 3) {
    return 0;
  }
  let refLat = 0;
  let refLon = 0;
  for (const point of points) {
    refLat += point.lat;
    refLon += point.lon;
  }
  refLat /= points.length;
  refLon /= points.length;
  const metersPerLon = metersPerDegreeLon(refLat);
  let areaSum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const x1 = (current.lon - refLon) * metersPerLon;
    const y1 = (current.lat - refLat) * METERS_PER_DEG_LAT;
    const x2 = (next.lon - refLon) * metersPerLon;
    const y2 = (next.lat - refLat) * METERS_PER_DEG_LAT;
    areaSum += x1 * y2 - x2 * y1;
  }
  return Math.abs(areaSum) / 2;
}

function inferBuildingHeight(areaM2: number): number {
  if (areaM2 <= 0) {
    return 8;
  }
  const scale = Math.sqrt(areaM2);
  return clamp(3 + scale * 0.18, 6, 55);
}

function gridIndexForPoint(
  point: LatLon,
  bounds: { north: number; south: number; east: number; west: number },
  rows: number,
  cols: number
): number {
  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;
  const row = clampInt(Math.floor(((point.lat - bounds.south) / latSpan) * rows), 0, rows - 1);
  const col = clampInt(Math.floor(((point.lon - bounds.west) / lonSpan) * cols), 0, cols - 1);
  return row * cols + col;
}

function gridCellCenter(
  cell: { row: number; col: number },
  bounds: { north: number; south: number; east: number; west: number },
  rows: number,
  cols: number
): LatLon {
  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;
  return {
    lat: bounds.south + ((cell.row + 0.5) / rows) * latSpan,
    lon: bounds.west + ((cell.col + 0.5) / cols) * lonSpan
  };
}

function gridCellDistanceMeters(
  a: { row: number; col: number },
  b: { row: number; col: number },
  bounds: { north: number; south: number; east: number; west: number },
  rows: number,
  cols: number
): number {
  const pointA = gridCellCenter(a, bounds, rows, cols);
  const pointB = gridCellCenter(b, bounds, rows, cols);
  return segmentLengthMeters(pointA, pointB);
}

function roadClassWeight(roadClass?: string): number {
  if (!roadClass) {
    return ROAD_CLASS_WEIGHTS.unknown;
  }
  const normalized = roadClass.toLowerCase();
  return ROAD_CLASS_WEIGHTS[normalized] ?? ROAD_CLASS_WEIGHTS.unknown;
}

function segmentLengthMeters(start: LatLon, end: LatLon): number {
  const midLat = (start.lat + end.lat) / 2;
  const dx = (end.lon - start.lon) * metersPerDegreeLon(midLat);
  const dy = (end.lat - start.lat) * METERS_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

function metersPerDegreeLon(lat: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.max(MIN_METERS_PER_DEG_LON, METERS_PER_DEG_LAT * Math.cos(rad));
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
