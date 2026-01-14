import type {
  Building,
  GeoBounds,
  GeoPoint,
  GeoProjector,
  MapPoint,
  Road,
  Shape,
  Sign,
  SignHeightSource,
  SignKind,
  StructureParams,
  TrafficSignal,
  Tree,
  TreeHeightSource,
  TreeType
} from "../types";
import type { RoadClass, RoadOneway, RoadSource } from "../types";
import { buildCandidateRegionsFromShapes } from "./candidates";
import { inferBuildingHeightInfo, type BuildingHeightInfo } from "./height";
import {
  DEFAULT_SIGN_DIMENSIONS,
  DEFAULT_SIGN_HEIGHT_SOURCE,
  DEFAULT_SIGN_KIND,
  DEFAULT_SIGN_YAW_DEGREES,
  DEFAULT_TREE_HEIGHT_SOURCE,
  DEFAULT_TREE_RADIUS_METERS,
  DEFAULT_TREE_TYPE,
  deriveTreeHeightMeters
} from "../obstacles";

export type WorldFeatureKind =
  | "road"
  | "building"
  | "tree"
  | "sign"
  | "traffic_signal"
  | "candidate"
  | "structure";

export interface LockedFrame {
  bounds: GeoBounds;
  size: { width: number; height: number };
}

export interface RenderPoint {
  x: number;
  y: number;
}

export interface WorldModel {
  frame: LockedFrame | null;
  roads: RoadFeature[];
  buildings: BuildingFeature[];
  trees: TreeFeature[];
  signs: SignFeature[];
  trafficSignals: TrafficSignalFeature[];
  candidates: CandidateRegion[];
  structure: StructureModel | null;
  meta: {
    createdAt: string;
    version: number;
  };
}

export interface RoadFeature {
  kind: "road";
  id: string;
  source?: RoadSource;
  name?: string;
  class?: RoadClass;
  oneway?: RoadOneway;
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  lanesInferred?: boolean;
  geometry: { points: GeoPoint[] };
  render?: RenderPoint[];
}

export interface BuildingFeature {
  kind: "building";
  id: string;
  name?: string;
  footprint: GeoPoint[];
  height: BuildingHeightInfo;
  tags?: Record<string, string>;
  render?: RenderPoint[];
}

export interface TreeFeature {
  kind: "tree";
  id: string;
  location: GeoPoint;
  type: TreeType;
  baseRadiusMeters: number;
  heightMeters: number;
  heightSource: TreeHeightSource;
  render?: RenderPoint;
}

export interface SignFeature {
  kind: "sign";
  id: string;
  location: GeoPoint;
  signKind: SignKind;
  widthMeters: number;
  heightMeters: number;
  bottomClearanceMeters: number;
  yawDegrees: number;
  heightSource: SignHeightSource;
  render?: RenderPoint;
}

export interface TrafficSignalFeature {
  kind: "traffic_signal";
  id: string;
  location: GeoPoint;
  render?: RenderPoint;
}

export interface CandidateRegion {
  kind: "candidate";
  id: string;
  name: string;
  visible: boolean;
  polygon: GeoPoint[];
  areaM2: number;
  perimeterM: number;
  render?: RenderPoint[];
  sourceShapeId?: string;
}

export interface StructureModel {
  kind: "structure";
  id: string;
  footprint: GeoPoint[];
  heightMeters: number;
  render?: RenderPoint[];
}

export interface BuildWorldModelInput {
  project: {
    bounds?: GeoBounds | null;
    shapes?: Shape[];
    structure?: StructureParams;
    autoRoads?: Road[];
    autoBuildings?: Building[];
    customRoads?: Road[];
    autoData?: { roads?: Road[]; buildings?: Building[] } | null;
    trees?: Tree[];
    signs?: Sign[];
    trafficSignals?: TrafficSignal[];
  };
  frame?: LockedFrame | null;
  geoProjector?: GeoProjector | null;
  roadMode?: "auto" | "custom";
  now?: Date;
}

const WORLD_MODEL_VERSION = 2;
const FEET_TO_METERS = 0.3048;

export function buildWorldModelFromProject(input: BuildWorldModelInput): WorldModel {
  const projector = input.geoProjector ?? null;
  const frame = input.frame ?? resolveFrameFromProjector(projector);
  const now = input.now ?? new Date();
  const roadMode = input.roadMode ?? "auto";
  const project = input.project;
  const shapes = project.shapes ?? [];
  const autoRoads = project.autoRoads ?? project.autoData?.roads ?? [];
  const autoBuildings = project.autoBuildings ?? project.autoData?.buildings ?? [];
  const customRoads = project.customRoads ?? [];
  const trees = project.trees ?? [];
  const signs = project.signs ?? [];
  const trafficSignals = project.trafficSignals ?? [];
  const roads = roadMode === "custom" ? customRoads : autoRoads;

  const roadFeatures = roads
    .map((road) => buildRoadFeature(road, projector))
    .filter((road): road is RoadFeature => !!road);

  const buildingFeatures = autoBuildings
    .map((building) => buildBuildingFeature(building, projector))
    .filter((building): building is BuildingFeature => !!building);

  const candidates = buildCandidateRegionsFromShapes(shapes, projector);

  const structure = buildStructureModel(project.structure, frame, projector);

  return {
    frame,
    roads: roadFeatures,
    buildings: buildingFeatures,
    trees: trees
      .map((tree) => buildTreeFeature(tree, projector))
      .filter((tree): tree is TreeFeature => !!tree),
    signs: signs
      .map((sign) => buildSignFeature(sign, projector))
      .filter((sign): sign is SignFeature => !!sign),
    trafficSignals: trafficSignals
      .map((signal) => buildTrafficSignalFeature(signal, projector))
      .filter((signal): signal is TrafficSignalFeature => !!signal),
    candidates,
    structure,
    meta: {
      createdAt: now.toISOString(),
      version: WORLD_MODEL_VERSION
    }
  };
}

function buildRoadFeature(road: Road, projector: GeoProjector | null): RoadFeature | null {
  const points = mapPointsToLatLon(road.points, projector);
  if (!points || points.length < 2) {
    return null;
  }
  const render = projector ? points.map((point) => projector.latLonToPixel(point.lat, point.lon)) : undefined;
  return {
    kind: "road",
    id: road.id,
    source: road.source,
    name: road.name,
    class: road.class,
    oneway: road.oneway,
    lanes: road.lanes,
    lanesForward: road.lanesForward,
    lanesBackward: road.lanesBackward,
    lanesInferred: road.lanesInferred,
    geometry: { points },
    render
  };
}

function buildBuildingFeature(
  building: Building,
  projector: GeoProjector | null
): BuildingFeature | null {
  const footprint = mapPointsToLatLon(building.footprint, projector);
  if (!footprint || footprint.length < 3) {
    return null;
  }
  const render = projector
    ? footprint.map((point) => projector.latLonToPixel(point.lat, point.lon))
    : undefined;
  const height = inferBuildingHeightInfo(building);
  const name = building.tags?.name;
  return {
    kind: "building",
    id: building.id,
    name,
    footprint,
    height,
    tags: building.tags,
    render
  };
}

function buildTreeFeature(tree: Tree, projector: GeoProjector | null): TreeFeature | null {
  const location = mapPointToLatLon(tree.location, projector);
  if (!location) {
    return null;
  }
  const type = normalizeTreeType(tree.type) ?? DEFAULT_TREE_TYPE;
  const baseRadiusMeters = normalizePositiveNumber(
    tree.baseRadiusMeters,
    DEFAULT_TREE_RADIUS_METERS
  );
  const derivedHeight = deriveTreeHeightMeters(baseRadiusMeters);
  const heightSource = normalizeTreeHeightSource(tree.heightSource) ?? DEFAULT_TREE_HEIGHT_SOURCE;
  const hasCustomHeight = heightSource !== "derived" && isPositiveNumber(tree.heightMeters);
  const heightMeters = hasCustomHeight
    ? (tree.heightMeters as number)
    : derivedHeight;
  const resolvedHeightSource = hasCustomHeight ? heightSource : "derived";
  const render = projector
    ? projector.latLonToPixel(location.lat, location.lon)
    : undefined;
  return {
    kind: "tree",
    id: tree.id,
    location,
    type,
    baseRadiusMeters,
    heightMeters,
    heightSource: resolvedHeightSource,
    render
  };
}

function buildSignFeature(sign: Sign, projector: GeoProjector | null): SignFeature | null {
  const location = mapPointToLatLon(sign.location, projector);
  if (!location) {
    return null;
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
  const heightSource = normalizeSignHeightSource(sign.heightSource) ?? DEFAULT_SIGN_HEIGHT_SOURCE;
  const resolvedHeightSource = isPositiveNumber(sign.heightMeters)
    ? heightSource
    : DEFAULT_SIGN_HEIGHT_SOURCE;
  const render = projector
    ? projector.latLonToPixel(location.lat, location.lon)
    : undefined;
  return {
    kind: "sign",
    id: sign.id,
    location,
    signKind,
    widthMeters,
    heightMeters,
    bottomClearanceMeters,
    yawDegrees,
    heightSource: resolvedHeightSource,
    render
  };
}

function buildTrafficSignalFeature(
  signal: TrafficSignal,
  projector: GeoProjector | null
): TrafficSignalFeature | null {
  const location = mapPointToLatLon(signal.location, projector);
  if (!location) {
    return null;
  }
  const render = projector
    ? projector.latLonToPixel(location.lat, location.lon)
    : undefined;
  return {
    kind: "traffic_signal",
    id: signal.id,
    location,
    render
  };
}

function buildStructureModel(
  structure: StructureParams | undefined,
  frame: LockedFrame | null,
  projector: GeoProjector | null
): StructureModel | null {
  if (!structure || !frame || !projector) {
    return null;
  }
  const metersPerPixel = resolveMetersPerPixel(frame.bounds, frame.size);
  if (!metersPerPixel) {
    return null;
  }
  const widthM = Math.max(1, structure.footprint.widthFt) * FEET_TO_METERS;
  const lengthM = Math.max(1, structure.footprint.lengthFt) * FEET_TO_METERS;
  const heightMeters = Math.max(1, structure.heightFt) * FEET_TO_METERS;
  const halfWidth = (widthM / metersPerPixel.x) / 2;
  const halfLength = (lengthM / metersPerPixel.y) / 2;
  const angle = (structure.rotationDeg * Math.PI) / 180;
  const axisX = { x: Math.cos(angle), y: Math.sin(angle) };
  const axisY = { x: -Math.sin(angle), y: Math.cos(angle) };
  const center = structure.centerPx;
  const render: RenderPoint[] = [
    {
      x: center.x + axisX.x * -halfWidth + axisY.x * -halfLength,
      y: center.y + axisX.y * -halfWidth + axisY.y * -halfLength
    },
    {
      x: center.x + axisX.x * halfWidth + axisY.x * -halfLength,
      y: center.y + axisX.y * halfWidth + axisY.y * -halfLength
    },
    {
      x: center.x + axisX.x * halfWidth + axisY.x * halfLength,
      y: center.y + axisX.y * halfWidth + axisY.y * halfLength
    },
    {
      x: center.x + axisX.x * -halfWidth + axisY.x * halfLength,
      y: center.y + axisX.y * -halfWidth + axisY.y * halfLength
    }
  ];
  const footprint = render.map((point) => projector.pixelToLatLon(point.x, point.y));
  return {
    kind: "structure",
    id: "structure:primary",
    footprint,
    heightMeters,
    render
  };
}

function normalizeTreeType(value: Tree["type"] | undefined): TreeType | null {
  if (value === "pine" || value === "deciduous") {
    return value;
  }
  return null;
}

function normalizeTreeHeightSource(
  value: Tree["heightSource"] | undefined
): TreeHeightSource | null {
  if (value === "derived" || value === "user_override" || value === "ml" || value === "osm") {
    return value;
  }
  return null;
}

function normalizeSignKind(value: Sign["kind"] | undefined): SignKind | null {
  if (value === "billboard" || value === "sign") {
    return value;
  }
  return null;
}

function normalizeSignHeightSource(
  value: Sign["heightSource"] | undefined
): SignHeightSource | null {
  if (value === "default" || value === "user_override" || value === "osm" || value === "ml") {
    return value;
  }
  return null;
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return fallback;
  }
  return value as number;
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value as number) < 0) {
    return fallback;
  }
  return value as number;
}

function normalizeNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value as number;
}

function isPositiveNumber(value: number | undefined): boolean {
  return Number.isFinite(value) && (value as number) > 0;
}

function mapPointsToLatLon(points: MapPoint[], projector: GeoProjector | null): GeoPoint[] | null {
  const mapped: GeoPoint[] = [];
  for (const point of points) {
    const resolved = mapPointToLatLon(point, projector);
    if (!resolved) {
      return null;
    }
    mapped.push(resolved);
  }
  return mapped;
}

function mapPointToLatLon(point: MapPoint, projector: GeoProjector | null): GeoPoint | null {
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

function resolveFrameFromProjector(projector: GeoProjector | null): LockedFrame | null {
  if (!projector) {
    return null;
  }
  return {
    bounds: projector.bounds,
    size: { width: projector.size.width, height: projector.size.height }
  };
}

function resolveMetersPerPixel(
  bounds: GeoBounds,
  size: { width: number; height: number }
): { x: number; y: number } | null {
  const latMid = (bounds.north + bounds.south) / 2;
  const lonMid = (bounds.east + bounds.west) / 2;
  const widthM = haversineMeters(latMid, bounds.west, latMid, bounds.east);
  const heightM = haversineMeters(bounds.north, lonMid, bounds.south, lonMid);
  if (!Number.isFinite(widthM) || !Number.isFinite(heightM) || widthM <= 0 || heightM <= 0) {
    return null;
  }
  if (size.width <= 0 || size.height <= 0) {
    return null;
  }
  return { x: widthM / size.width, y: heightM / size.height };
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
