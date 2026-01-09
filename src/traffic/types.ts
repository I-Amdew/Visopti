export type RoadId = string;

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
  | "unknown"
  | string;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RoadPoint extends LatLon {
  nodeId?: string | number;
}

export interface Road {
  id: RoadId;
  points: RoadPoint[];
  oneway?: boolean | "yes" | "no" | "1" | "0" | "-1" | "true" | "false" | 1 | 0 | -1;
  class?: RoadClass;
}

export interface Building {
  id: string;
  centroid?: LatLon;
  outline?: LatLon[];
  points?: LatLon[];
  polygon?: LatLon[];
}

export type TrafficPresetName = "am" | "pm" | "neutral";

export interface TrafficConfig {
  epicenter: LatLon;
  epicenterRadiusM: number;
  kRoutes?: number;
  tripCount?: number;
}

export interface DirectionalHourlyScore {
  forward: number[];
  backward: number[];
}

export interface TrafficRoadScore {
  hourlyScore: DirectionalHourlyScore;
}

export interface TrafficSimResult {
  roadTraffic: Record<RoadId, TrafficRoadScore>;
  meta: {
    trips: number;
    kRoutes: number;
    durationMs: number;
    seed: number;
    generatedAtIso: string;
  };
}

export interface TrafficSimProgress {
  phase: string;
  completed: number;
  total: number;
}

export interface TrafficSimRequest {
  roads: Road[];
  buildings?: Building[];
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  config: TrafficConfig;
  presets?: TrafficPresetName[];
  detailLevel?: number;
  seed?: number;
}
