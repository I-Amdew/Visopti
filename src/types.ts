import type { TileSourceId } from "./mapTiles";

export type ZoneType = "obstacle" | "candidate" | "viewer";

export interface ShapeBase {
  id: string;
  type: ZoneType;
  alpha: number;
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

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type MapPoint = { x: number; y: number } | GeoPoint;

export interface AppSettings {
  siteHeightFt: number;
  viewerHeightFt: number;
  topoSpacingFt: number;
  sampleStepPx: number;
  overlays: OverlaySettings;
  opacity: OpacitySettings;
}

export interface ViewerSample {
  pixel: { x: number; y: number };
  lat: number;
  lon: number;
  elevationM: number;
  direction?: ViewerDirection;
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

export interface Road {
  id: string;
  source?: RoadSource;
  points: MapPoint[];
  oneway?: RoadOneway;
  class?: RoadClass;
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
  tags?: Record<string, string>;
}

export interface TrafficConfig {
  preset: string;
  hour: number;
  detail: number;
  showOverlay: boolean;
  showDirectionArrows: boolean;
  seed: number;
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
}

export interface ProjectPayload {
  schemaVersion: number;
  bounds: GeoBounds | null;
  basemapId: TileSourceId;
  settings: AppSettings;
  shapes: Shape[];
  autoRoads?: Road[];
  autoBuildings?: Building[];
  customRoads?: Road[];
  trafficConfig?: TrafficConfig;
  trafficView?: TrafficViewState;
}

export interface ProjectState {
  bounds: GeoBounds | null;
  basemapId: TileSourceId;
  settings: AppSettings;
  shapes: Shape[];
  autoRoads: Road[];
  autoBuildings: Building[];
  customRoads: Road[];
  trafficConfig: TrafficConfig;
  trafficView: TrafficViewState;
}

export type AutosavePayload = ProjectPayload;
