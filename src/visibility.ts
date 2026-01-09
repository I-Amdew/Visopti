import {
  AppSettings,
  CandidateSample,
  HeatmapCell,
  Shape,
  ViewerSample,
  ZoneType
} from "./types";
import { GeoMapper } from "./geo";
import { pointInShape } from "./drawing";

type BoundingBox = { minX: number; maxX: number; minY: number; maxY: number };

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
        elevationM
      });
    }
  }

  return samples;
}

function samplePoints(
  shapes: Shape[],
  type: ZoneType,
  settings: AppSettings,
  mapper: GeoMapper,
  stepOverride?: number
): (ViewerSample | CandidateSample)[] {
  const relevant = shapes.filter((shape) => shape.type === type);
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
        const sample: ViewerSample | CandidateSample = { pixel: { x, y }, lat, lon, elevationM };
        if (type === "viewer" && viewerDirection) {
          (sample as ViewerSample).direction = viewerDirection;
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
        elevationM
      };
      if (type === "viewer" && viewerDirection) {
        (sample as ViewerSample).direction = viewerDirection;
      }
      samples.push(sample);
    }
  }

  return samples;
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

export function lineOfSightFraction(
  viewer: ViewerSample,
  candidate: CandidateSample,
  settings: AppSettings,
  mapper: GeoMapper,
  obstacles: Shape[],
  obstacleBoxes: BoundingBox[] | undefined,
  targetHeightFt: number,
  subset?: number[]
): number {
  if (
    viewer.direction &&
    !isWithinDirectionalCone(viewer.direction, viewer.pixel, candidate.pixel)
  ) {
    return 0;
  }
  if (segmentBlockedByObstacle(viewer.pixel, candidate.pixel, obstacles, obstacleBoxes, subset)) {
    return 0;
  }
  const ftToM = 0.3048;
  const viewerZ = viewer.elevationM + settings.viewerHeightFt * ftToM;
  const targetHeightM = targetHeightFt * ftToM;
  const slices = 4;
  const denom = slices - 1;
  let visibleSlices = 0;
  for (let slice = 0; slice < slices; slice += 1) {
    const fraction = denom === 0 ? 1 : slice / denom;
    const targetZ = candidate.elevationM + targetHeightM * fraction;
    if (hasClearLine(viewer, candidate, viewerZ, targetZ, mapper)) {
      visibleSlices += 1;
    }
  }
  return visibleSlices / slices;
}

function hasClearLine(
  viewer: ViewerSample,
  candidate: CandidateSample,
  viewerZ: number,
  candidateZ: number,
  mapper: GeoMapper
): boolean {
  const dx = candidate.pixel.x - viewer.pixel.x;
  const dy = candidate.pixel.y - viewer.pixel.y;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(24, Math.ceil(distance / 5));
  const startLL = mapper.pixelToLatLon(viewer.pixel.x, viewer.pixel.y);
  const endLL = mapper.pixelToLatLon(candidate.pixel.x, candidate.pixel.y);
  const latDelta = endLL.lat - startLL.lat;
  const lonDelta = endLL.lon - startLL.lon;
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const lat = startLL.lat + latDelta * t;
    const lon = startLL.lon + lonDelta * t;
    const terrain = mapper.latLonToElevation(lat, lon);
    const lineZ = viewerZ + (candidateZ - viewerZ) * t;
    if (terrain > lineZ) {
      return false;
    }
  }
  return true;
}

function isWithinDirectionalCone(
  direction: { angleRad: number; coneRad: number },
  origin: { x: number; y: number },
  target: { x: number; y: number }
): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const angle = Math.atan2(dy, dx);
  const delta = normalizeAngle(angle - direction.angleRad);
  return Math.abs(delta) <= direction.coneRad / 2;
}

export function computeVisibilityHeatmap(
  viewers: ViewerSample[],
  candidates: CandidateSample[],
  obstacles: Shape[],
  settings: AppSettings,
  mapper: GeoMapper
): HeatmapCell[] {
  const totalViewers = viewers.length;
  const cells: HeatmapCell[] = [];
  const obstacleBoxes = obstacles.map(shapeBounds);
  if (candidates.length === 0) {
    return cells;
  }

  for (const candidate of candidates) {
    let visibleCount = 0;
    if (totalViewers === 0) {
      cells.push({ pixel: candidate.pixel, score: 0 });
      continue;
    }
    for (const viewer of viewers) {
      visibleCount += lineOfSightFraction(
        viewer,
        candidate,
        settings,
        mapper,
        obstacles,
        obstacleBoxes,
        settings.siteHeightFt
      );
    }
    cells.push({ pixel: candidate.pixel, score: visibleCount / totalViewers });
  }

  return cells;
}

export function computeShadingOverlay(
  viewers: ViewerSample[],
  candidates: CandidateSample[],
  obstacles: Shape[],
  settings: AppSettings,
  mapper: GeoMapper
): HeatmapCell[] {
  if (candidates.length === 0) {
    return [];
  }
  const coverageCells = computeVisibilityHeatmap(viewers, candidates, obstacles, settings, mapper);
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
