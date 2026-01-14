import {
  AppSettings,
  Building,
  CandidateSample,
  GeoPoint,
  HeatmapCell,
  MapPoint,
  Shape,
  Sign,
  Tree,
  ViewerSample,
  ZoneType
} from "./types";
import { GeoMapper, type ElevationGrid } from "./geo";
import { pointInShape } from "./drawing";
import { inferBuildingHeightInfo } from "./world/height";
import { DEFAULT_SIGN_DIMENSIONS, deriveTreeHeightMeters } from "./obstacles";
import type { TrafficViewerSample } from "./traffic/types";

type BoundingBox = { minX: number; maxX: number; minY: number; maxY: number };

type GridPoint = { x: number; y: number };

type CombinedGridInput = {
  buildings?: Building[];
  trees?: Tree[];
  signs?: Sign[];
  obstacles?: Shape[];
  obstacleHeightM?: number;
};

const FT_TO_METERS = 0.3048;
const DEFAULT_TRAFFIC_CONE_HALF_ANGLE_DEG = 60;
const DEFAULT_OBSTACLE_HEIGHT_M = 1000;
const DEFAULT_SIGN_THICKNESS_M = 0.6;
const ELLIPSE_SEGMENTS = 24;

export function sampleViewerPoints(
  shapes: Shape[],
  settings: AppSettings,
  mapper: GeoMapper
): ViewerSample[] {
  const denseStep = Math.max(1, Math.floor(settings.sampleStepPx / 2)) || 1;
  return samplePoints(shapes, "viewer", settings, mapper, denseStep) as ViewerSample[];
}

export function sampleCandidatePoints(
  shapes: Shape[],
  settings: AppSettings,
  mapper: GeoMapper
): CandidateSample[] {
  const step = Math.max(1, Math.floor(settings.sampleStepPx));
  return samplePoints(shapes, "candidate", settings, mapper, step) as CandidateSample[];
}

export function sampleMapGridPoints(
  settings: AppSettings,
  mapper: GeoMapper,
  stepOverride?: number
): CandidateSample[] {
  const step = Math.max(1, stepOverride ?? Math.floor(settings.sampleStepPx));
  const { width_px, height_px } = mapper.geo.image;
  const samples: CandidateSample[] = [];

  const xPositions: number[] = [];
  for (let x = 0; x < width_px; x += step) {
    xPositions.push(x);
  }
  if (xPositions[xPositions.length - 1] !== width_px - 1) {
    xPositions.push(width_px - 1);
  }

  const yPositions: number[] = [];
  for (let y = 0; y < height_px; y += step) {
    yPositions.push(y);
  }
  if (yPositions[yPositions.length - 1] !== height_px - 1) {
    yPositions.push(height_px - 1);
  }

  for (const y of yPositions) {
    for (const x of xPositions) {
      const { lat, lon } = mapper.pixelToLatLon(x, y);
      const elevationM = mapper.latLonToElevation(lat, lon);
      samples.push({
        pixel: { x, y },
        lat,
        lon,
        elevationM: Number.isFinite(elevationM) ? elevationM : 0
      });
    }
  }

  return samples;
}

export function buildTrafficViewerSamples(
  samples: TrafficViewerSample[] | null | undefined,
  mapper: GeoMapper
): ViewerSample[] {
  if (!samples || samples.length === 0) {
    return [];
  }
  const coneRad = toRad(DEFAULT_TRAFFIC_CONE_HALF_ANGLE_DEG * 2);
  const viewerSamples: ViewerSample[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lon)) {
      continue;
    }
    const weight = Number.isFinite(sample.weight) ? (sample.weight as number) : 0;
    if (weight <= 0) {
      continue;
    }
    const pixel = mapper.latLonToPixel(sample.lat, sample.lon);
    const elevationM = mapper.latLonToElevation(sample.lat, sample.lon);
    const direction = Number.isFinite(sample.heading)
      ? {
          angleRad: toRad((sample.heading as number) - 90),
          coneRad
        }
      : undefined;
    viewerSamples.push({
      pixel,
      lat: sample.lat,
      lon: sample.lon,
      elevationM: Number.isFinite(elevationM) ? elevationM : 0,
      direction,
      weight
    });
  }
  return viewerSamples;
}

export function buildCombinedHeightGrid(
  mapper: GeoMapper,
  input: CombinedGridInput
): ElevationGrid {
  const grid = mapper.grid;
  const rows = grid.rows;
  const cols = grid.cols;
  const ground: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const obstacles: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const value = grid.values[r][c];
      ground[r][c] = Number.isFinite(value) ? (value as number) : 0;
    }
  }

  const spacing = estimateGridSpacingMeters(mapper);
  const obstacleHeightM =
    Number.isFinite(input.obstacleHeightM) && (input.obstacleHeightM as number) > 0
      ? (input.obstacleHeightM as number)
      : DEFAULT_OBSTACLE_HEIGHT_M;

  const applyHeight = (row: number, col: number, heightM: number) => {
    if (row < 0 || row >= rows || col < 0 || col >= cols) {
      return;
    }
    const totalHeight = ground[row][col] + heightM;
    if (totalHeight > obstacles[row][col]) {
      obstacles[row][col] = totalHeight;
    }
  };

  const rasterizePolygon = (polygon: GridPoint[], heightM: number) => {
    if (polygon.length < 3) {
      return;
    }
    const bounds = polygonBounds(polygon);
    const minX = clampInt(Math.floor(bounds.minX), 0, cols - 1);
    const maxX = clampInt(Math.ceil(bounds.maxX), 0, cols - 1);
    const minY = clampInt(Math.floor(bounds.minY), 0, rows - 1);
    const maxY = clampInt(Math.ceil(bounds.maxY), 0, rows - 1);
    let touched = false;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (!pointInPolygon({ x, y }, polygon)) {
          continue;
        }
        applyHeight(y, x, heightM);
        touched = true;
      }
    }

    if (!touched) {
      const centroid = polygonCentroid(polygon);
      const row = clampInt(Math.round(centroid.y), 0, rows - 1);
      const col = clampInt(Math.round(centroid.x), 0, cols - 1);
      applyHeight(row, col, heightM);
    }
  };

  const rasterizeEllipse = (center: GridPoint, radiusM: number, heightM: number) => {
    if (!Number.isFinite(radiusM) || radiusM <= 0) {
      applyHeight(Math.round(center.y), Math.round(center.x), heightM);
      return;
    }
    const radiusX = radiusM / spacing.col;
    const radiusY = radiusM / spacing.row;
    const minX = clampInt(Math.floor(center.x - radiusX), 0, cols - 1);
    const maxX = clampInt(Math.ceil(center.x + radiusX), 0, cols - 1);
    const minY = clampInt(Math.floor(center.y - radiusY), 0, rows - 1);
    const maxY = clampInt(Math.ceil(center.y + radiusY), 0, rows - 1);
    let touched = false;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = radiusX === 0 ? 0 : (x - center.x) / radiusX;
        const dy = radiusY === 0 ? 0 : (y - center.y) / radiusY;
        if (dx * dx + dy * dy > 1) {
          continue;
        }
        applyHeight(y, x, heightM);
        touched = true;
      }
    }

    if (!touched) {
      applyHeight(Math.round(center.y), Math.round(center.x), heightM);
    }
  };

  if (input.buildings) {
    for (const building of input.buildings) {
      const footprint = mapPointsToLatLon(building.footprint, mapper);
      if (!footprint || footprint.length < 3) {
        continue;
      }
      const heightInfo = inferBuildingHeightInfo(building);
      const heightM = heightInfo.effectiveHeightMeters;
      if (!Number.isFinite(heightM) || heightM <= 0) {
        continue;
      }
      const polygon = footprint.map((point) => {
        const { row, col } = mapper.latLonToGridCoords(point.lat, point.lon);
        return { x: col, y: row };
      });
      rasterizePolygon(polygon, heightM);
    }
  }

  if (input.trees) {
    for (const tree of input.trees) {
      const location = mapPointToLatLon(tree.location, mapper);
      if (!location) {
        continue;
      }
      const { row, col } = mapper.latLonToGridCoords(location.lat, location.lon);
      const heightM = resolveTreeHeightMeters(tree);
      if (!Number.isFinite(heightM) || heightM <= 0) {
        continue;
      }
      const radiusM = Number.isFinite(tree.baseRadiusMeters) ? tree.baseRadiusMeters : 0;
      rasterizeEllipse({ x: col, y: row }, radiusM, heightM);
    }
  }

  if (input.signs) {
    for (const sign of input.signs) {
      const location = mapPointToLatLon(sign.location, mapper);
      if (!location) {
        continue;
      }
      const { row, col } = mapper.latLonToGridCoords(location.lat, location.lon);
      const { widthM, heightM, clearanceM } = resolveSignDimensions(sign);
      const topHeightM = heightM + clearanceM;
      if (!Number.isFinite(topHeightM) || topHeightM <= 0) {
        continue;
      }
      const depthM = Math.max(DEFAULT_SIGN_THICKNESS_M, widthM * 0.1);
      const yawRad = toRad(Number.isFinite(sign.yawDegrees) ? sign.yawDegrees : 0);
      const angle = resolveGridYaw(yawRad, grid);
      const halfWidth = (widthM / spacing.col) / 2;
      const halfDepth = (depthM / spacing.row) / 2;
      const polygon = buildRotatedRect(
        { x: col, y: row },
        halfWidth,
        halfDepth,
        angle
      );
      rasterizePolygon(polygon, topHeightM);
    }
  }

  if (input.obstacles) {
    for (const shape of input.obstacles) {
      const polygonPx = shapeToPolygonPixels(shape);
      if (polygonPx.length < 3) {
        continue;
      }
      const polygon = polygonPx.map((point) => {
        const { lat, lon } = mapper.pixelToLatLon(point.x, point.y);
        const { row, col } = mapper.latLonToGridCoords(lat, lon);
        return { x: col, y: row };
      });
      rasterizePolygon(polygon, obstacleHeightM);
    }
  }

  let minElevation = Infinity;
  let maxElevation = -Infinity;
  const values: number[][] = Array.from({ length: rows }, (_, r) => {
    const row: number[] = new Array<number>(cols);
    for (let c = 0; c < cols; c += 1) {
      const combined = Math.max(ground[r][c], obstacles[r][c]);
      row[c] = combined;
      if (combined < minElevation) minElevation = combined;
      if (combined > maxElevation) maxElevation = combined;
    }
    return row;
  });

  if (!Number.isFinite(minElevation)) {
    minElevation = 0;
  }
  if (!Number.isFinite(maxElevation)) {
    maxElevation = minElevation;
  }

  return {
    rows,
    cols,
    latitudes: grid.latitudes,
    longitudes: grid.longitudes,
    values,
    latAscending: grid.latAscending,
    lonAscending: grid.lonAscending,
    minElevation,
    maxElevation
  };
}

export function segmentBlockedByObstacle(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  obstacles: Shape[],
  boxes?: BoundingBox[],
  subset?: number[]
): boolean {
  if (obstacles.length === 0) {
    return false;
  }
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(10, Math.ceil(distance / 5));

  if (subset && subset.length > 0) {
    for (const index of subset) {
      const obstacle = obstacles[index];
      const box = boxes ? boxes[index] : shapeBounds(obstacle);
      if (!segmentIntersectsBox(p1, p2, box)) {
        continue;
      }
      for (let i = 1; i < steps; i += 1) {
        const t = i / steps;
        const px = p1.x + dx * t;
        const py = p1.y + dy * t;
        if (pointInShape({ x: px, y: py }, obstacle)) {
          return true;
        }
      }
    }
    return false;
  }

  for (let index = 0; index < obstacles.length; index += 1) {
    const obstacle = obstacles[index];
    const box = boxes ? boxes[index] : shapeBounds(obstacle);
    if (!segmentIntersectsBox(p1, p2, box)) {
      continue;
    }
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const px = p1.x + dx * t;
      const py = p1.y + dy * t;
      if (pointInShape({ x: px, y: py }, obstacle)) {
        return true;
      }
    }
  }
  return false;
}

export function isVisible(
  viewer: ViewerSample,
  target: CandidateSample,
  viewerEyeHeightM: number,
  targetHeightM: number,
  combinedGrid: ElevationGrid,
  mapper: GeoMapper
): boolean {
  if (!Number.isFinite(viewer.lat) || !Number.isFinite(viewer.lon)) {
    return false;
  }
  if (!Number.isFinite(target.lat) || !Number.isFinite(target.lon)) {
    return false;
  }
  const viewerGround = Number.isFinite(viewer.elevationM) ? viewer.elevationM : 0;
  const targetGround = Number.isFinite(target.elevationM) ? target.elevationM : 0;
  const viewerZ = viewerGround + viewerEyeHeightM;
  const targetZ = targetGround + targetHeightM;
  const start = mapper.latLonToGridCoords(viewer.lat, viewer.lon);
  const end = mapper.latLonToGridCoords(target.lat, target.lon);
  const dx = end.col - start.col;
  const dy = end.row - start.row;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return true;
  }
  const step = 0.5;
  const steps = Math.max(2, Math.ceil(distance / step));
  const denom = steps;
  for (let i = 1; i < steps; i += 1) {
    const t = i / denom;
    const row = start.row + dy * t;
    const col = start.col + dx * t;
    const height = sampleGridHeight(combinedGrid, row, col);
    const lineZ = viewerZ + (targetZ - viewerZ) * t;
    if (height - lineZ > 0) {
      return false;
    }
  }
  return true;
}

export function computeVisibilityHeatmap(
  viewers: ViewerSample[],
  candidates: CandidateSample[],
  combinedGrid: ElevationGrid,
  settings: AppSettings,
  mapper: GeoMapper
): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  if (candidates.length === 0) {
    return cells;
  }

  let totalWeight = 0;
  for (const viewer of viewers) {
    const weight = Number.isFinite(viewer.weight) ? (viewer.weight as number) : 1;
    if (weight > 0) {
      totalWeight += weight;
    }
  }

  const viewerEyeHeightM = settings.viewerHeightFt * FT_TO_METERS;
  const targetHeightM = settings.siteHeightFt * FT_TO_METERS;

  for (const candidate of candidates) {
    if (totalWeight <= 0 || viewers.length === 0) {
      cells.push({ pixel: candidate.pixel, score: 0 });
      continue;
    }
    let scoreSum = 0;
    for (const viewer of viewers) {
      const baseWeight = Number.isFinite(viewer.weight) ? (viewer.weight as number) : 1;
      if (baseWeight <= 0) {
        continue;
      }
      const viewConeFactor = computeViewConeFactor(viewer, candidate);
      if (viewConeFactor <= 0) {
        continue;
      }
      const distanceFactor = computeDistanceFactor(viewer, candidate, settings);
      if (distanceFactor <= 0) {
        continue;
      }
      if (!isVisible(viewer, candidate, viewerEyeHeightM, targetHeightM, combinedGrid, mapper)) {
        continue;
      }
      scoreSum += baseWeight * viewConeFactor * distanceFactor;
    }
    cells.push({
      pixel: candidate.pixel,
      score: totalWeight > 0 ? scoreSum / totalWeight : 0
    });
  }

  return cells;
}

export function computeShadingOverlay(
  viewers: ViewerSample[],
  candidates: CandidateSample[],
  combinedGrid: ElevationGrid,
  settings: AppSettings,
  mapper: GeoMapper
): HeatmapCell[] {
  if (candidates.length === 0) {
    return [];
  }
  const coverageCells = computeVisibilityHeatmap(viewers, candidates, combinedGrid, settings, mapper);
  const blindCells: HeatmapCell[] = [];
  for (const cell of coverageCells) {
    const blindScore = 1 - cell.score;
    if (blindScore <= 0) {
      continue;
    }
    blindCells.push({ pixel: cell.pixel, score: blindScore });
  }
  return blindCells;
}

function samplePoints(
  shapes: Shape[],
  type: ZoneType,
  settings: AppSettings,
  mapper: GeoMapper,
  stepOverride?: number
): (ViewerSample | CandidateSample)[] {
  const relevant = shapes.filter((shape) => shape.type === type && shape.visible !== false);
  const samples: (ViewerSample | CandidateSample)[] = [];
  const step = Math.max(1, stepOverride ?? Math.floor(settings.sampleStepPx));

  for (const shape of relevant) {
    const bounds = shapeBounds(shape);
    const minX = Math.max(0, Math.floor(bounds.minX));
    const maxX = Math.min(mapper.geo.image.width_px - 1, Math.ceil(bounds.maxX));
    const minY = Math.max(0, Math.floor(bounds.minY));
    const maxY = Math.min(mapper.geo.image.height_px - 1, Math.ceil(bounds.maxY));
    const viewerDirection = shape.type === "viewer" ? shape.direction : undefined;
    let addedForShape = false;

    for (let y = minY; y <= maxY; y += step) {
      for (let x = minX; x <= maxX; x += step) {
        const point = { x, y };
        if (!pointInShape(point, shape)) {
          continue;
        }
        const { lat, lon } = mapper.pixelToLatLon(x, y);
        const elevationM = mapper.latLonToElevation(lat, lon);
        const sample: ViewerSample | CandidateSample = {
          pixel: { x, y },
          lat,
          lon,
          elevationM: Number.isFinite(elevationM) ? elevationM : 0
        };
        if (type === "viewer" && viewerDirection) {
          (sample as ViewerSample).direction = viewerDirection;
        }
        if (type === "viewer") {
          (sample as ViewerSample).weight = 1;
        }
        samples.push(sample);
        addedForShape = true;
      }
    }

    // Ensure very small shapes contribute at least their centroid
    if (!addedForShape) {
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      const clampedX = Math.min(Math.max(cx, 0), mapper.geo.image.width_px - 1);
      const clampedY = Math.min(Math.max(cy, 0), mapper.geo.image.height_px - 1);
      const { lat, lon } = mapper.pixelToLatLon(clampedX, clampedY);
      const elevationM = mapper.latLonToElevation(lat, lon);
      const sample: ViewerSample | CandidateSample = {
        pixel: { x: clampedX, y: clampedY },
        lat,
        lon,
        elevationM: Number.isFinite(elevationM) ? elevationM : 0
      };
      if (type === "viewer" && viewerDirection) {
        (sample as ViewerSample).direction = viewerDirection;
      }
      if (type === "viewer") {
        (sample as ViewerSample).weight = 1;
      }
      samples.push(sample);
    }
  }

  return samples;
}

function computeViewConeFactor(viewer: ViewerSample, candidate: CandidateSample): number {
  if (!viewer.direction) {
    return 1;
  }
  const dx = candidate.pixel.x - viewer.pixel.x;
  const dy = candidate.pixel.y - viewer.pixel.y;
  const angle = Math.atan2(dy, dx);
  const delta = Math.abs(normalizeAngle(angle - viewer.direction.angleRad));
  const halfCone = Math.max(0, viewer.direction.coneRad / 2);
  if (halfCone <= 0) {
    return 1;
  }
  if (delta <= halfCone) {
    return 1;
  }
  const maxDelta = Math.PI;
  const t = (delta - halfCone) / Math.max(1e-6, maxDelta - halfCone);
  return clamp(1 - t, 0, 1);
}

function computeDistanceFactor(
  viewer: ViewerSample,
  candidate: CandidateSample,
  settings: AppSettings
): number {
  const maxDistanceFt = Number.isFinite(settings.viewDistanceFt)
    ? (settings.viewDistanceFt as number)
    : 0;
  if (maxDistanceFt <= 0) {
    return 1;
  }
  const distanceM = haversineMeters(viewer.lat, viewer.lon, candidate.lat, candidate.lon);
  const distanceFt = distanceM / FT_TO_METERS;
  if (!Number.isFinite(distanceFt)) {
    return 1;
  }
  if (distanceFt <= maxDistanceFt) {
    return 1;
  }
  const excess = distanceFt - maxDistanceFt;
  return clamp(1 - excess / maxDistanceFt, 0, 1);
}

function shapeToPolygonPixels(shape: Shape): GridPoint[] {
  if (shape.kind === "polygon") {
    return shape.points.map((point) => ({ x: point.x, y: point.y }));
  }
  if (shape.kind === "rect") {
    const x0 = shape.x;
    const y0 = shape.y;
    const x1 = shape.x + shape.width;
    const y1 = shape.y + shape.height;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    return [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY }
    ];
  }
  const centerX = shape.x + shape.width / 2;
  const centerY = shape.y + shape.height / 2;
  const radiusX = Math.abs(shape.width) / 2;
  const radiusY = Math.abs(shape.height) / 2;
  const points: GridPoint[] = [];
  for (let i = 0; i < ELLIPSE_SEGMENTS; i += 1) {
    const angle = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
    points.push({
      x: centerX + Math.cos(angle) * radiusX,
      y: centerY + Math.sin(angle) * radiusY
    });
  }
  return points;
}

function polygonBounds(points: GridPoint[]): BoundingBox {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, maxX, minY, maxY };
}

function polygonCentroid(points: GridPoint[]): GridPoint {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  return { x: sumX / points.length, y: sumY / points.length };
}

function pointInPolygon(point: GridPoint, polygon: GridPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function buildRotatedRect(
  center: GridPoint,
  halfWidth: number,
  halfDepth: number,
  angleRad: number
): GridPoint[] {
  const corners: GridPoint[] = [
    { x: -halfWidth, y: -halfDepth },
    { x: halfWidth, y: -halfDepth },
    { x: halfWidth, y: halfDepth },
    { x: -halfWidth, y: halfDepth }
  ];
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  return corners.map((corner) => ({
    x: center.x + corner.x * cosA - corner.y * sinA,
    y: center.y + corner.x * sinA + corner.y * cosA
  }));
}

function resolveTreeHeightMeters(tree: Tree): number {
  const height = Number.isFinite(tree.heightMeters) ? (tree.heightMeters as number) : 0;
  if (tree.heightSource === "derived" || height <= 0) {
    const radiusM = Number.isFinite(tree.baseRadiusMeters) ? tree.baseRadiusMeters : 0;
    return deriveTreeHeightMeters(radiusM);
  }
  return height;
}

function resolveSignDimensions(sign: Sign): {
  widthM: number;
  heightM: number;
  clearanceM: number;
} {
  const defaults = DEFAULT_SIGN_DIMENSIONS[sign.kind];
  const widthM =
    Number.isFinite(sign.widthMeters) && (sign.widthMeters as number) > 0
      ? (sign.widthMeters as number)
      : defaults.widthMeters;
  const heightM =
    Number.isFinite(sign.heightMeters) && (sign.heightMeters as number) > 0
      ? (sign.heightMeters as number)
      : defaults.heightMeters;
  const clearanceM =
    Number.isFinite(sign.bottomClearanceMeters) && (sign.bottomClearanceMeters as number) >= 0
      ? (sign.bottomClearanceMeters as number)
      : defaults.bottomClearanceMeters;
  return { widthM, heightM, clearanceM };
}

function resolveGridYaw(yawRad: number, grid: ElevationGrid): number {
  const axisFlipX = grid.lonAscending ? 1 : -1;
  const axisFlipY = grid.latAscending ? -1 : 1;
  const vx = Math.cos(yawRad);
  const vy = Math.sin(yawRad);
  const vxGrid = axisFlipX * vx;
  const vyGrid = axisFlipY * vy;
  return Math.atan2(vyGrid, vxGrid);
}

function estimateGridSpacingMeters(mapper: GeoMapper): { row: number; col: number } {
  const grid = mapper.grid;
  const rowSpacing =
    grid.rows > 1
      ? haversineMeters(
          grid.latitudes[0],
          mapper.bounds.west,
          grid.latitudes[1],
          mapper.bounds.west
        )
      : 1;
  const colSpacing =
    grid.cols > 1
      ? haversineMeters(
          mapper.bounds.north,
          grid.longitudes[0],
          mapper.bounds.north,
          grid.longitudes[1]
        )
      : 1;
  return {
    row: Number.isFinite(rowSpacing) && rowSpacing > 0 ? rowSpacing : 1,
    col: Number.isFinite(colSpacing) && colSpacing > 0 ? colSpacing : 1
  };
}

function mapPointsToLatLon(points: MapPoint[], mapper: GeoMapper): GeoPoint[] | null {
  const mapped: GeoPoint[] = [];
  for (const point of points) {
    const resolved = mapPointToLatLon(point, mapper);
    if (!resolved) {
      return null;
    }
    mapped.push(resolved);
  }
  return mapped;
}

function mapPointToLatLon(point: MapPoint, mapper: GeoMapper): GeoPoint | null {
  if ("lat" in point && "lon" in point) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      return null;
    }
    return { lat: point.lat, lon: point.lon };
  }
  if ("x" in point && "y" in point) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    return mapper.pixelToLatLon(point.x, point.y);
  }
  return null;
}

function sampleGridHeight(grid: ElevationGrid, row: number, col: number): number {
  const rows = grid.rows;
  const cols = grid.cols;
  const safeRow = clamp(row, 0, rows - 1);
  const safeCol = clamp(col, 0, cols - 1);
  const r0 = Math.floor(safeRow);
  const c0 = Math.floor(safeCol);
  const r1 = clampInt(r0 + 1, 0, rows - 1);
  const c1 = clampInt(c0 + 1, 0, cols - 1);
  const rt = safeRow - r0;
  const ct = safeCol - c0;
  const v00 = Number.isFinite(grid.values[r0][c0]) ? grid.values[r0][c0] : 0;
  const v01 = Number.isFinite(grid.values[r0][c1]) ? grid.values[r0][c1] : 0;
  const v10 = Number.isFinite(grid.values[r1][c0]) ? grid.values[r1][c0] : 0;
  const v11 = Number.isFinite(grid.values[r1][c1]) ? grid.values[r1][c1] : 0;
  const top = v00 + (v01 - v00) * ct;
  const bottom = v10 + (v11 - v10) * ct;
  return top + (bottom - top) * rt;
}

function segmentIntersectsBox(
  start: { x: number; y: number },
  end: { x: number; y: number },
  box: BoundingBox
): boolean {
  const segMinX = Math.min(start.x, end.x);
  const segMaxX = Math.max(start.x, end.x);
  const segMinY = Math.min(start.y, end.y);
  const segMaxY = Math.max(start.y, end.y);
  return (
    segMaxX >= box.minX &&
    segMinX <= box.maxX &&
    segMaxY >= box.minY &&
    segMinY <= box.maxY
  );
}

function shapeBounds(shape: Shape): BoundingBox {
  if (shape.kind === "rect") {
    return {
      minX: shape.x,
      maxX: shape.x + shape.width,
      minY: shape.y,
      maxY: shape.y + shape.height
    };
  }
  if (shape.kind === "ellipse") {
    return {
      minX: shape.x,
      maxX: shape.x + shape.width,
      minY: shape.y,
      maxY: shape.y + shape.height
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of shape.points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, maxX, minY, maxY };
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) {
    a -= Math.PI * 2;
  }
  while (a < -Math.PI) {
    a += Math.PI * 2;
  }
  return a;
}
