export type MapPoint = { x: number; y: number } | { lat: number; lon: number };

export interface Road {
  id: string;
  points: MapPoint[];
  directionLine?: MapPoint[];
  showDirectionLine?: boolean;
}

export interface Building {
  id: string;
  footprint: MapPoint[];
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
