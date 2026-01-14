import type { AppSettings, Road, ViewerSample } from "./types";
import type { ElevationGrid, GeoMapper } from "./geo";
import { distanceToPolyline, type Point } from "./roads/geometry";
import { isVisible } from "./visibility";

export interface StructureFace {
  id: number;
  start: Point;
  end: Point;
  center: Point;
  length: number;
  normal: Point;
}

export interface StructureFaceScore {
  face: StructureFace;
  score: number;
}

export interface StructurePlacementResult {
  center: Point;
  rotationDeg: number;
  footprint: Point[];
  faceScores: StructureFaceScore[];
  totalScore: number;
}

export interface StructureCandidateRegion {
  id: string;
  points: Point[];
}

export interface StructureRoadInput {
  points: Point[];
  class?: Road["class"];
}

export type StructureScoreMode = "max" | "topN";

export interface StructureOptimizationInput {
  footprintTemplate: Point[];
  heightM: number;
  candidates: StructureCandidateRegion[];
  viewers: ViewerSample[];
  combinedGrid: ElevationGrid;
  mapper: GeoMapper;
  settings: AppSettings;
  roads?: StructureRoadInput[];
  pinnedFaceId?: number | null;
  squareToRoad?: boolean;
  rotationStepDeg?: number;
  rotationRefineStepDeg?: number;
  placementSamples?: number;
  refineTopK?: number;
  refineStepScale?: number;
  scoreMode?: StructureScoreMode;
  topN?: number;
}

export interface StructureOptimizationResult {
  candidateId: string;
  placement: StructurePlacementResult;
}

const FT_TO_METERS = 0.3048;
const DEFAULT_ROTATION_STEP_DEG = 10;
const DEFAULT_ROTATION_REFINE_STEP_DEG = 2;
const DEFAULT_PLACEMENT_SAMPLES = 30;
const DEFAULT_REFINE_TOP_K = 3;
const DEFAULT_REFINE_STEP_SCALE = 0.5;
const MIN_SAMPLE_STEP_PX = 5;

const MAJOR_ROAD_CLASSES = new Set<Road["class"]>([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link"
]);

export function buildRectFootprintTemplate(widthPx: number, lengthPx: number): Point[] {
  const halfWidth = Math.max(0.5, widthPx / 2);
  const halfLength = Math.max(0.5, lengthPx / 2);
  return [
    { x: -halfWidth, y: -halfLength },
    { x: halfWidth, y: -halfLength },
    { x: halfWidth, y: halfLength },
    { x: -halfWidth, y: halfLength }
  ];
}

export function transformFootprint(
  template: Point[],
  center: Point,
  rotationDeg: number
): Point[] {
  const angle = (rotationDeg * Math.PI) / 180;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return template.map((point) => ({
    x: center.x + point.x * cosA - point.y * sinA,
    y: center.y + point.x * sinA + point.y * cosA
  }));
}

export function computeStructureFaces(footprint: Point[]): StructureFace[] {
  const points = normalizeRing(footprint);
  if (points.length < 3) {
    return [];
  }
  const clockwise = polygonSignedArea(points) >= 0;
  const faces: StructureFace[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const start = points[i];
    const end = points[(i + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const normal =
      length > 0
        ? {
            x: (clockwise ? dy : -dy) / length,
            y: (clockwise ? -dx : dx) / length
          }
        : { x: 0, y: 0 };
    faces.push({ id: i, start, end, center, length, normal });
  }
  return faces;
}

export function labelFaceDirection(normal: Point): "N" | "E" | "S" | "W" {
  const angle = Math.atan2(normal.x, -normal.y);
  const deg = normalizeRotation((angle * 180) / Math.PI);
  if (deg >= 45 && deg < 135) {
    return "E";
  }
  if (deg >= 135 && deg < 225) {
    return "S";
  }
  if (deg >= 225 && deg < 315) {
    return "W";
  }
  return "N";
}

export function optimizeStructurePlacement(
  input: StructureOptimizationInput
): StructureOptimizationResult | null {
  const footprintTemplate = normalizeRing(input.footprintTemplate);
  if (footprintTemplate.length < 3) {
    return null;
  }
  if (!input.viewers || input.viewers.length === 0) {
    return null;
  }
  const candidates = input.candidates
    .map((candidate) => ({
      ...candidate,
      points: normalizeRing(candidate.points)
    }))
    .filter((candidate) => candidate.points.length >= 3);
  if (candidates.length === 0) {
    return null;
  }

  const rotationStepDeg =
    Number.isFinite(input.rotationStepDeg) && (input.rotationStepDeg as number) > 0
      ? (input.rotationStepDeg as number)
      : DEFAULT_ROTATION_STEP_DEG;
  const rotationRefineStepDeg =
    Number.isFinite(input.rotationRefineStepDeg) && (input.rotationRefineStepDeg as number) > 0
      ? (input.rotationRefineStepDeg as number)
      : DEFAULT_ROTATION_REFINE_STEP_DEG;
  const placementSamples =
    Number.isFinite(input.placementSamples) && (input.placementSamples as number) > 0
      ? Math.max(1, Math.floor(input.placementSamples as number))
      : DEFAULT_PLACEMENT_SAMPLES;
  const refineTopK =
    Number.isFinite(input.refineTopK) && (input.refineTopK as number) > 0
      ? Math.max(1, Math.floor(input.refineTopK as number))
      : DEFAULT_REFINE_TOP_K;
  const refineStepScale =
    Number.isFinite(input.refineStepScale) && (input.refineStepScale as number) > 0
      ? (input.refineStepScale as number)
      : DEFAULT_REFINE_STEP_SCALE;
  const scoreMode = input.scoreMode ?? "max";
  const topN = Math.max(1, Math.floor(input.topN ?? 2));

  const placementResults: Array<{
    candidateId: string;
    candidatePoints: Point[];
    step: number;
    placement: StructurePlacementResult;
  }> = [];

  for (const candidate of candidates) {
    const { samples, step } = samplePointsInPolygon(candidate.points, placementSamples);
    for (const center of samples) {
      const placement = evaluatePlacement({
        center,
        candidatePoints: candidate.points,
        footprintTemplate,
        heightM: input.heightM,
        viewers: input.viewers,
        combinedGrid: input.combinedGrid,
        mapper: input.mapper,
        settings: input.settings,
        roads: input.roads,
        pinnedFaceId: input.pinnedFaceId ?? null,
        squareToRoad: input.squareToRoad ?? false,
        rotationStepDeg,
        rotationRefineStepDeg,
        scoreMode,
        topN
      });
      if (!placement) {
        continue;
      }
      placementResults.push({
        candidateId: candidate.id,
        candidatePoints: candidate.points,
        step,
        placement
      });
    }
  }

  if (placementResults.length === 0) {
    return null;
  }

  placementResults.sort((a, b) => b.placement.totalScore - a.placement.totalScore);
  let bestCandidateId = placementResults[0].candidateId;
  let bestPlacement = placementResults[0].placement;

  const refineCount = Math.min(refineTopK, placementResults.length);
  for (let i = 0; i < refineCount; i += 1) {
    const candidate = placementResults[i];
    const refineStep = Math.max(1, candidate.step * refineStepScale);
    const offsets = [-refineStep, 0, refineStep];
    for (const dx of offsets) {
      for (const dy of offsets) {
        if (dx === 0 && dy === 0) {
          continue;
        }
        const center = {
          x: candidate.placement.center.x + dx,
          y: candidate.placement.center.y + dy
        };
        if (!pointInPolygon(center, candidate.candidatePoints)) {
          continue;
        }
        const placement = evaluatePlacement({
          center,
          candidatePoints: candidate.candidatePoints,
          footprintTemplate,
          heightM: input.heightM,
          viewers: input.viewers,
          combinedGrid: input.combinedGrid,
          mapper: input.mapper,
          settings: input.settings,
          roads: input.roads,
          pinnedFaceId: input.pinnedFaceId ?? null,
          squareToRoad: input.squareToRoad ?? false,
          rotationStepDeg,
          rotationRefineStepDeg,
          scoreMode,
          topN
        });
        if (placement && placement.totalScore > bestPlacement.totalScore) {
          bestPlacement = placement;
          bestCandidateId = candidate.candidateId;
        }
      }
    }
  }

  return {
    candidateId: bestCandidateId,
    placement: bestPlacement
  };
}

type PlacementEvalInput = {
  center: Point;
  candidatePoints: Point[];
  footprintTemplate: Point[];
  heightM: number;
  viewers: ViewerSample[];
  combinedGrid: ElevationGrid;
  mapper: GeoMapper;
  settings: AppSettings;
  roads?: StructureRoadInput[];
  pinnedFaceId: number | null;
  squareToRoad: boolean;
  rotationStepDeg: number;
  rotationRefineStepDeg: number;
  scoreMode: StructureScoreMode;
  topN: number;
};

function evaluatePlacement(input: PlacementEvalInput): StructurePlacementResult | null {
  const orientationCandidates = buildOrientationCandidates(
    input.center,
    input.roads ?? [],
    input.squareToRoad,
    input.rotationStepDeg
  );
  let best: StructurePlacementResult | null = null;
  for (const rotationDeg of orientationCandidates) {
    const candidate = scorePlacement({
      ...input,
      rotationDeg
    });
    if (!candidate) {
      continue;
    }
    if (!best || candidate.totalScore > best.totalScore) {
      best = candidate;
    }
  }

  if (!best || input.squareToRoad) {
    return best;
  }

  const refineAngles = buildRefinedAngles(
    best.rotationDeg,
    input.rotationStepDeg,
    input.rotationRefineStepDeg
  );
  for (const rotationDeg of refineAngles) {
    const candidate = scorePlacement({
      ...input,
      rotationDeg
    });
    if (!candidate) {
      continue;
    }
    if (candidate.totalScore > best.totalScore) {
      best = candidate;
    }
  }
  return best;
}

function scorePlacement(
  input: PlacementEvalInput & { rotationDeg: number }
): StructurePlacementResult | null {
  const footprint = transformFootprint(
    input.footprintTemplate,
    input.center,
    input.rotationDeg
  );
  if (!polygonContainsPolygon(input.candidatePoints, footprint)) {
    return null;
  }
  const faces = computeStructureFaces(footprint);
  if (faces.length === 0) {
    return null;
  }
  const faceScores = scoreFaces(
    faces,
    input.viewers,
    input.combinedGrid,
    input.settings,
    input.mapper,
    input.heightM
  );
  const totalScore = computeTotalScore(
    faceScores,
    input.scoreMode,
    input.topN,
    input.pinnedFaceId
  );
  return {
    center: { ...input.center },
    rotationDeg: normalizeRotation(input.rotationDeg),
    footprint,
    faceScores,
    totalScore
  };
}

function scoreFaces(
  faces: StructureFace[],
  viewers: ViewerSample[],
  combinedGrid: ElevationGrid,
  settings: AppSettings,
  mapper: GeoMapper,
  heightM: number
): StructureFaceScore[] {
  let totalWeight = 0;
  for (const viewer of viewers) {
    const weight = Number.isFinite(viewer.weight) ? (viewer.weight as number) : 1;
    if (weight > 0) {
      totalWeight += weight;
    }
  }
  if (totalWeight <= 0) {
    return faces.map((face) => ({ face, score: 0 }));
  }

  const viewerEyeHeightM = settings.viewerHeightFt * FT_TO_METERS;
  const targetHeightM = Math.max(0.5, heightM * 0.5);
  const scores = faces.map(() => 0);
  const targets = faces.map((face) => {
    const { lat, lon } = mapper.pixelToLatLon(face.center.x, face.center.y);
    const elevationM = mapper.latLonToElevation(lat, lon);
    return {
      face,
      target: {
        pixel: face.center,
        lat,
        lon,
        elevationM: Number.isFinite(elevationM) ? elevationM : 0
      }
    };
  });

  for (const viewer of viewers) {
    const baseWeight = Number.isFinite(viewer.weight) ? (viewer.weight as number) : 1;
    if (baseWeight <= 0) {
      continue;
    }
    for (let i = 0; i < targets.length; i += 1) {
      const entry = targets[i];
      const facingFactor = computeFacingFactor(entry.face, viewer);
      if (facingFactor <= 0) {
        continue;
      }
      const viewConeFactor = computeViewConeFactor(viewer, entry.face.center);
      if (viewConeFactor <= 0) {
        continue;
      }
      const distanceFactor = computeDistanceFactor(viewer, entry.target, settings);
      if (distanceFactor <= 0) {
        continue;
      }
      if (
        !isVisible(
          viewer,
          entry.target,
          viewerEyeHeightM,
          targetHeightM,
          combinedGrid,
          mapper
        )
      ) {
        continue;
      }
      scores[i] += baseWeight * facingFactor * viewConeFactor * distanceFactor;
    }
  }

  return faces.map((face, index) => ({
    face,
    score: scores[index] / totalWeight
  }));
}

function computeFacingFactor(face: StructureFace, viewer: ViewerSample): number {
  const dx = viewer.pixel.x - face.center.x;
  const dy = viewer.pixel.y - face.center.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return 0;
  }
  const dirX = dx / distance;
  const dirY = dy / distance;
  const dot = face.normal.x * dirX + face.normal.y * dirY;
  return Math.max(0, dot);
}

function computeViewConeFactor(viewer: ViewerSample, target: Point): number {
  if (!viewer.direction) {
    return 1;
  }
  const dx = target.x - viewer.pixel.x;
  const dy = target.y - viewer.pixel.y;
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
  target: { lat: number; lon: number },
  settings: AppSettings
): number {
  const maxDistanceFt = Number.isFinite(settings.viewDistanceFt)
    ? (settings.viewDistanceFt as number)
    : 0;
  if (maxDistanceFt <= 0) {
    return 1;
  }
  const distanceM = haversineMeters(viewer.lat, viewer.lon, target.lat, target.lon);
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

function computeTotalScore(
  faceScores: StructureFaceScore[],
  mode: StructureScoreMode,
  topN: number,
  pinnedFaceId: number | null
): number {
  if (faceScores.length === 0) {
    return 0;
  }
  if (pinnedFaceId !== null) {
    const pinned = faceScores.find((entry) => entry.face.id === pinnedFaceId);
    if (pinned) {
      return pinned.score;
    }
  }
  if (mode === "topN") {
    const sorted = [...faceScores].sort((a, b) => b.score - a.score);
    return sorted.slice(0, topN).reduce((sum, entry) => sum + entry.score, 0);
  }
  let best = 0;
  for (const entry of faceScores) {
    if (entry.score > best) {
      best = entry.score;
    }
  }
  return best;
}

function buildOrientationCandidates(
  center: Point,
  roads: StructureRoadInput[],
  squareToRoad: boolean,
  rotationStepDeg: number
): number[] {
  if (squareToRoad) {
    const bearing = resolveNearestRoadBearing(center, roads);
    if (bearing !== null) {
      return uniqueAngles([
        bearing,
        bearing + 90,
        bearing + 180,
        bearing + 270
      ]);
    }
  }
  const step = Math.max(1, rotationStepDeg);
  const angles: number[] = [];
  for (let deg = 0; deg < 360; deg += step) {
    angles.push(normalizeRotation(deg));
  }
  return angles;
}

function resolveNearestRoadBearing(
  center: Point,
  roads: StructureRoadInput[]
): number | null {
  if (!roads || roads.length === 0) {
    return null;
  }
  const major = roads.filter((road) => isMajorRoadClass(road.class));
  const fromMajor = resolveNearestRoadBearingFromSet(center, major);
  if (fromMajor !== null) {
    return fromMajor;
  }
  return resolveNearestRoadBearingFromSet(center, roads);
}

function resolveNearestRoadBearingFromSet(
  center: Point,
  roads: StructureRoadInput[]
): number | null {
  let best: { road: StructureRoadInput; segmentIndex: number; distance: number } | null =
    null;
  for (const road of roads) {
    if (!road.points || road.points.length < 2) {
      continue;
    }
    const hit = distanceToPolyline(center, road.points);
    if (!hit) {
      continue;
    }
    if (!best || hit.distance < best.distance) {
      best = { road, segmentIndex: hit.segmentIndex, distance: hit.distance };
    }
  }
  if (!best) {
    return null;
  }
  const a = best.road.points[best.segmentIndex];
  const b = best.road.points[best.segmentIndex + 1];
  if (!a || !b) {
    return null;
  }
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  return normalizeRotation((angle * 180) / Math.PI);
}

function isMajorRoadClass(roadClass?: Road["class"]): boolean {
  if (!roadClass) {
    return false;
  }
  return MAJOR_ROAD_CLASSES.has(roadClass);
}

function buildRefinedAngles(
  centerDeg: number,
  spanDeg: number,
  stepDeg: number
): number[] {
  const angles: number[] = [];
  if (stepDeg <= 0 || spanDeg <= 0) {
    return angles;
  }
  const start = centerDeg - spanDeg;
  const end = centerDeg + spanDeg;
  for (let deg = start; deg <= end; deg += stepDeg) {
    angles.push(normalizeRotation(deg));
  }
  return uniqueAngles(angles);
}

function samplePointsInPolygon(
  polygon: Point[],
  targetCount: number
): { samples: Point[]; step: number } {
  const bounds = polygonBounds(polygon);
  const area = Math.abs(polygonSignedArea(polygon));
  const rawStep = Math.sqrt(area / Math.max(1, targetCount));
  const step = Math.max(MIN_SAMPLE_STEP_PX, Number.isFinite(rawStep) ? rawStep : MIN_SAMPLE_STEP_PX);
  const samples: Point[] = [];
  for (let y = bounds.minY; y <= bounds.maxY; y += step) {
    for (let x = bounds.minX; x <= bounds.maxX; x += step) {
      const point = { x, y };
      if (pointInPolygon(point, polygon)) {
        samples.push(point);
      }
    }
  }
  if (samples.length === 0) {
    samples.push(polygonCentroid(polygon));
  }
  const maxSamples = Math.max(targetCount * 2, 10);
  if (samples.length > maxSamples) {
    const stride = Math.ceil(samples.length / maxSamples);
    return { samples: samples.filter((_, index) => index % stride === 0), step };
  }
  return { samples, step };
}

function polygonContainsPolygon(container: Point[], subject: Point[]): boolean {
  const containerPoints = normalizeRing(container);
  const subjectPoints = normalizeRing(subject);
  if (containerPoints.length < 3 || subjectPoints.length < 3) {
    return false;
  }
  for (const point of subjectPoints) {
    if (!pointInPolygon(point, containerPoints)) {
      return false;
    }
  }
  for (let i = 0; i < subjectPoints.length; i += 1) {
    const a = subjectPoints[i];
    const b = subjectPoints[(i + 1) % subjectPoints.length];
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!pointInPolygon(midpoint, containerPoints)) {
      return false;
    }
  }
  return true;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (pointOnSegment(point, polygon[j], polygon[i])) {
      return true;
    }
  }
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

function pointOnSegment(point: Point, a: Point, b: Point): boolean {
  const cross = (point.y - a.y) * (b.x - a.x) - (point.x - a.x) * (b.y - a.y);
  if (Math.abs(cross) > 1e-6) {
    return false;
  }
  const dot = (point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y);
  if (dot < 0) {
    return false;
  }
  const lenSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot <= lenSq;
}

function polygonBounds(points: Point[]): { minX: number; maxX: number; minY: number; maxY: number } {
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
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 0;
    minY = 0;
    maxY = 0;
  }
  return { minX, maxX, minY, maxY };
}

function polygonCentroid(points: Point[]): Point {
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

function polygonSignedArea(points: Point[]): number {
  if (points.length < 3) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = (i + 1) % points.length;
    sum += points[i].x * points[next].y - points[next].x * points[i].y;
  }
  return sum / 2;
}

function normalizeRing(points: Point[]): Point[] {
  if (points.length < 2) {
    return points;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const close =
    Math.abs(first.x - last.x) <= 1e-6 && Math.abs(first.y - last.y) <= 1e-6;
  return close ? points.slice(0, -1) : points;
}

function normalizeRotation(deg: number): number {
  let next = deg % 360;
  if (next < 0) {
    next += 360;
  }
  return next;
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

function uniqueAngles(angles: number[]): number[] {
  const rounded = new Set<number>();
  const result: number[] = [];
  for (const angle of angles) {
    const normalized = normalizeRotation(angle);
    const key = Math.round(normalized * 1000) / 1000;
    if (rounded.has(key)) {
      continue;
    }
    rounded.add(key);
    result.push(normalized);
  }
  return result;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
