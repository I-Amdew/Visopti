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
