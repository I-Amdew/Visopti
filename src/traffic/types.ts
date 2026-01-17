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
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  lanesInferred?: boolean;
  turnLanes?: string;
  turnLanesForward?: string;
  turnLanesBackward?: string;
}

export interface Building {
  id: string;
  centroid?: LatLon;
  outline?: LatLon[];
  points?: LatLon[];
  polygon?: LatLon[];
}

export interface TrafficSignal {
  id: string;
  location: LatLon;
}

export type TrafficPresetName = "am" | "pm" | "neutral";

export interface TrafficConfig {
  epicenter?: LatLon | null;
  epicenterRadiusM?: number;
  centralShare?: number;
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
  edgeTraffic?: TrafficEdgeTraffic[];
  viewerSamples?: TrafficViewerSample[];
  epicenters?: TrafficEpicenter[];
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
  frameBounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  simBounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  trafficSignals?: TrafficSignal[];
  config: TrafficConfig;
  presets?: TrafficPresetName[];
  detailLevel?: number;
  seed?: number;
}

export interface TrafficEpicenter {
  point: LatLon;
  weight: number;
  direction?: "north" | "south" | "east" | "west";
}

export interface TrafficEdgeTraffic {
  edgeId: string;
  roadId: RoadId;
  from: LatLon;
  to: LatLon;
  lengthM: number;
  flow: number;
  dwellFactor: number;
  speedMps?: number;
}

export interface TrafficViewerSample {
  lat: number;
  lon: number;
  headingDeg: number;
  weight: number;
  dwellFactor: number;
  laneType: TrafficLaneType;
  speedMps?: number;
}

export type TurnDirection = "left" | "right" | "straight";

export type TrafficLaneType = "through" | "turn_left" | "turn_right";
