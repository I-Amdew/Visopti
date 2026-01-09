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

export type RoadClass =
  | "motorway"
  | "trunk"
  | "primary"
  | "secondary"
  | "tertiary"
  | "residential"
  | "service"
  | "unclassified"
  | "path"
  | "other";

export interface RoadDirectionLineStyle {
  color?: string;
  widthPx?: number;
  offsetPx?: number;
  dashPx?: number[];
}

export interface RoadHourlyDirectionalScore {
  hour: number;
  forward: number;
  backward: number;
}

export interface RoadTraffic {
  customCarsPerHour?: number;
  hourlyDirectionalScores?: RoadHourlyDirectionalScore[];
}

export interface Road {
  id: string;
  source: RoadSource;
  points: GeoPoint[];
  oneway: boolean;
  class: RoadClass;
  showDirectionLine: boolean;
  directionLine?: RoadDirectionLineStyle;
  traffic?: RoadTraffic;
}

export interface Building {
  id: string;
  footprint: GeoPoint[];
  height?: number;
  tags?: Record<string, string>;
}

export interface TrafficConfig {
  mode: "disabled" | "custom";
  defaultCarsPerHour: number;
  hourlyMultipliers: number[];
}

export interface TrafficViewState {
  layer: "none" | "volume" | "direction";
  hour: number;
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
