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
  name?: string;
  showDirectionLine: boolean;
  traffic: RoadTraffic;
}

export interface Building {
  id: string;
  footprint: LatLon[];
  heightM?: number;
  name?: string;
}
