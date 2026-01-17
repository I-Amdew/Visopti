import type { TileSourceId } from "./mapTiles";

export type ZoneType = "obstacle" | "candidate" | "viewer";

export interface ShapeBase {
  id: string;
  name: string;
  type: ZoneType;
  alpha: number;
  color?: string;
  visible: boolean;
  direction?: ViewerDirection;
  viewerAnchor?: { x: number; y: number };
}

export interface RectShape extends ShapeBase {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EllipseShape extends ShapeBase {
  kind: "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PolygonShape extends ShapeBase {
  kind: "polygon";
  points: { x: number; y: number }[];
}

export type Shape = RectShape | EllipseShape | PolygonShape;

export interface GeoReference {
  image: {
    width_px: number;
    height_px: number;
    filename?: string;
  };
  bounds: {
    lat_max_north: number;
    lat_min_south: number;
    lon_min_west: number;
    lon_max_east: number;
  };
}

export interface GeoBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface GeoProjector {
  latLonToPixel(lat: number, lon: number): { x: number; y: number };
  pixelToLatLon(x: number, y: number): { lat: number; lon: number };
  bounds: GeoBounds;
  size: { width: number; height: number };
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type MapPoint = { x: number; y: number } | GeoPoint;

export interface FrameSettings {
  maxSideFt: number;
  minSideFt: number;
}

export interface AppSettings {
  siteHeightFt: number;
  viewerHeightFt: number;
  viewDistanceFt: number;
  topoSpacingFt: number;
  sampleStepPx: number;
  forestK: number;
  denseCoverDensity: number;
  frame: FrameSettings;
  overlays: OverlaySettings;
  opacity: OpacitySettings;
}

export interface StructureFootprintV1 {
  widthFt: number;
  lengthFt: number;
}

export interface StructureFootprint {
  points: { x: number; y: number }[];
}

export interface StructureCenter {
  x: number;
  y: number;
}

export interface StructureParamsV1 {
  heightFt: number;
  footprint: StructureFootprintV1;
  placeAtCenter: boolean;
  centerPx: StructureCenter;
  rotationDeg: number;
}

export type StructureMode = "parametric" | "imported";

export interface ImportedModelRef {
  assetId: string;
  name: string;
  format: "glb" | "gltf" | "obj" | "stl";
  scale: number;
  rotationDeg: number;
  offset: { x: number; y: number; z: number };
  footprintProxy?: { points: { x: number; y: number }[] };
}

export interface FacePriorityArc {
  primaryEdgeIndex: number;
  arcDeg: 180 | 270;
}

export interface StructureParamsV2 {
  version: 2;
  mode: StructureMode;
  footprint: StructureFootprint;
  heightMeters: number;
  placeAtCenter: boolean;
  centerPx: StructureCenter;
  rotationDeg: number;
  facePriority?: FacePriorityArc;
  legacyWidthFt?: number;
  legacyLengthFt?: number;
  imported?: ImportedModelRef;
}

export type StructureParams = StructureParamsV2;

export interface ViewerSample {
  pixel: { x: number; y: number };
  lat: number;
  lon: number;
  elevationM: number;
  direction?: ViewerDirection;
  weight?: number;
}

export interface CandidateSample {
  pixel: { x: number; y: number };
  lat: number;
  lon: number;
  elevationM: number;
}

export interface HeatmapCell {
  pixel: { x: number; y: number };
  score: number; // 0..1
}

export interface OverlaySettings {
  showViewers: boolean;
  showCandidates: boolean;
  showObstacles: boolean;
  showContours: boolean;
}

export interface OpacitySettings {
  viewer: number;
  candidate: number;
  obstacle: number;
  heatmap: number;
  shading: number;
  contours: number;
}

export interface ViewerDirection {
  angleRad: number;
  coneRad: number;
}

export type RoadSource = "osm" | "custom";

export type RoadOneway = boolean | -1 | 0 | 1;

export type RoadClass =
  | "motorway"
  | "trunk"
  | "primary"
  | "secondary"
  | "tertiary"
  | "residential"
  | "service"
  | "unclassified"
  | "living_street"
  | "motorway_link"
  | "trunk_link"
  | "primary_link"
  | "secondary_link"
  | "tertiary_link"
  | "track"
  | "path"
  | "cycleway"
  | "footway"
  | "pedestrian"
  | "construction"
  | "other";

export interface RoadHourlyDirectionalScore {
  hour: number;
  forward: number;
  backward: number;
}

export interface RoadTraffic {
  customCarsPerHour?: number;
  hourlyDirectionalScores?: RoadHourlyDirectionalScore[];
  forward?: number;
  backward?: number;
}

export interface RoadCustomTraffic {
  forward?: number | null;
  backward?: number | null;
}

export type TrafficFlowDensity = "low" | "medium" | "high";

export interface Road {
  id: string;
  source?: RoadSource;
  points: MapPoint[];
  oneway?: RoadOneway;
  class?: RoadClass;
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  lanesInferred?: boolean;
  turnLanes?: string;
  turnLanesForward?: string;
  turnLanesBackward?: string;
  name?: string;
  showDirectionLine?: boolean;
  directionLine?: MapPoint[];
  traffic?: RoadTraffic;
  customTraffic?: RoadCustomTraffic;
}

export interface Building {
  id: string;
  footprint: MapPoint[];
  height?: number;
  inferredHeightMeters?: number;
  heightSource?: BuildingHeightSource;
  confidence?: number;
  userOverrideMeters?: number;
  effectiveHeightMeters?: number;
  tags?: Record<string, string>;
}

export type BuildingHeightSource =
  | "osm_height"
  | "osm_levels"
  | "default"
  | "external_api"
  | (string & {});

export type TreeType = "pine" | "deciduous";
export type TreeHeightSource = "derived" | "user_override" | "ml" | "osm";

export interface Tree {
  id: string;
  location: MapPoint;
  type: TreeType;
  baseRadiusMeters: number;
  heightMeters: number;
  heightSource: TreeHeightSource;
}

export interface DenseCover {
  id: string;
  polygonLatLon: GeoPoint[];
  density: number;
  mode: "dense_cover";
}

export type SignKind = "billboard" | "sign";
export type SignHeightSource = "default" | "user_override" | "osm" | "ml";

export interface Sign {
  id: string;
  location: MapPoint;
  kind: SignKind;
  widthMeters: number;
  heightMeters: number;
  bottomClearanceMeters: number;
  yawDegrees: number;
  heightSource: SignHeightSource;
}

export interface TrafficSignal {
  id: string;
  location: MapPoint;
}

export interface TrafficConfig {
  preset: string;
  hour: number;
  detail: number;
  showOverlay: boolean;
  showDirectionArrows: boolean;
  flowDensity: TrafficFlowDensity;
  seed: number;
  centralShare: number;
}

export interface TrafficDirectionalScores {
  forward?: number;
  reverse?: number;
  total?: number;
}

export type TrafficByHour = Record<number, TrafficDirectionalScores>;
export type TrafficByPreset = Record<string, TrafficByHour>;
export type TrafficByRoadId = Record<string, TrafficByPreset>;

export interface TrafficViewState {
  preset: string;
  hour: number;
  showDirection: boolean;
  flowDensity: TrafficFlowDensity;
}

export interface ProjectPayload {
  schemaVersion: number;
  bounds: GeoBounds | null;
  basemapId: TileSourceId;
  settings: AppSettings;
  shapes: Shape[];
  denseCover?: DenseCover[];
  structure?: StructureParams;
  autoRoads?: Road[];
  autoBuildings?: Building[];
  autoTrees?: Tree[];
  autoSigns?: Sign[];
  autoTrafficSignals?: TrafficSignal[];
  customRoads?: Road[];
  trees?: Tree[];
  signs?: Sign[];
  trafficConfig?: TrafficConfig;
  trafficView?: TrafficViewState;
}

export interface ProjectState {
  bounds: GeoBounds | null;
  basemapId: TileSourceId;
  settings: AppSettings;
  shapes: Shape[];
  denseCover: DenseCover[];
  structure: StructureParams;
  autoRoads: Road[];
  autoBuildings: Building[];
  autoTrees: Tree[];
  autoSigns: Sign[];
  autoTrafficSignals: TrafficSignal[];
  customRoads: Road[];
  trees: Tree[];
  signs: Sign[];
  trafficConfig: TrafficConfig;
  trafficView: TrafficViewState;
}

export type AutosavePayload = ProjectPayload;
