export interface LatLon {
  lat: number;
  lon: number;
}

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
  | "track"
  | "path"
  | "footway"
  | "cycleway"
  | "pedestrian"
  | "other";

export type RoadDirection = "both" | "forward" | "backward";

export interface RoadTraffic {
  basis: "simulated";
  hourly?: number[];
}

export interface Road {
  id: string;
  points: LatLon[];
  class: RoadClass;
  oneway: RoadDirection;
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  lanesInferred?: boolean;
  turnLanes?: string;
  turnLanesForward?: string;
  turnLanesBackward?: string;
  name?: string;
  showDirectionLine: boolean;
  traffic: RoadTraffic;
}

export interface Building {
  id: string;
  footprint: LatLon[];
  heightM?: number;
  name?: string;
  tags?: Record<string, string>;
}

export type TreeType = "pine" | "deciduous";

export interface Tree {
  id: string;
  location: LatLon;
  type: TreeType;
  baseRadiusMeters: number;
  heightMeters?: number;
}

export type SignKind = "billboard" | "sign";

export interface Sign {
  id: string;
  location: LatLon;
  kind: SignKind;
  widthMeters?: number;
  heightMeters?: number;
  bottomClearanceMeters?: number;
  yawDegrees?: number;
}

export interface TrafficSignal {
  id: string;
  location: LatLon;
}
