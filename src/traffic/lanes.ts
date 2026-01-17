import type { TurnDirection } from "./types";

export interface LaneCounts {
  total: number;
  forward: number;
  backward: number;
  inferred: boolean;
}

export interface LaneSource {
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  class?: string;
  oneway?: unknown;
  turnLanes?: string;
  turnLanesForward?: string;
  turnLanesBackward?: string;
}

const HEURISTIC_LANES_BY_CLASS: Record<string, number> = {
  motorway: 4,
  trunk: 3,
  primary: 3,
  secondary: 2,
  tertiary: 2,
  residential: 2,
  service: 1,
  unclassified: 2,
  living_street: 1,
  motorway_link: 2,
  trunk_link: 2,
  primary_link: 2,
  secondary_link: 2,
  tertiary_link: 1,
  track: 1,
  path: 1,
  cycleway: 1,
  footway: 1,
  pedestrian: 1,
  construction: 1,
  other: 2,
  unknown: 2
};

const DEMAND_WEIGHT_BY_CLASS: Record<string, number> = {
  motorway: 1.6,
  trunk: 1.45,
  primary: 1.3,
  secondary: 1.15,
  tertiary: 1.05,
  residential: 0.95,
  service: 0.85,
  unclassified: 0.95,
  living_street: 0.75,
  motorway_link: 1.25,
  trunk_link: 1.15,
  primary_link: 1.1,
  secondary_link: 1.05,
  tertiary_link: 1.0,
  track: 0.7,
  path: 0.5,
  cycleway: 0.55,
  footway: 0.45,
  pedestrian: 0.45,
  construction: 0.6,
  other: 0.9,
  unknown: 0.9
};

export interface TurnLaneCounts {
  left: number;
  right: number;
  through: number;
  total: number;
}

export function parseLaneTag(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const match = raw.match(/\d+/);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[0], 10);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export function parseTurnLaneTag(raw?: string): TurnLaneCounts | null {
  if (!raw) {
    return null;
  }
  const entries = raw
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!entries.length) {
    return null;
  }
  let left = 0;
  let right = 0;
  let through = 0;
  for (const entry of entries) {
    const directives = entry
      .split(";")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0);
    const hasThrough = directives.includes("through");
    const hasLeft = directives.some((token) => token.includes("left"));
    const hasRight = directives.some((token) => token.includes("right"));
    if (hasThrough) {
      through += 1;
    }
    if (hasLeft && !hasThrough) {
      left += 1;
    }
    if (hasRight && !hasThrough) {
      right += 1;
    }
  }
  return { left, right, through, total: entries.length };
}

export function selectTurnLaneTag(source: LaneSource, direction: "forward" | "backward"): string | undefined {
  const directional =
    direction === "forward" ? source.turnLanesForward : source.turnLanesBackward;
  return directional ?? source.turnLanes;
}

export function inferDedicatedTurnLane(params: {
  movement: TurnDirection;
  incomingLanes: number;
  straightLanes?: number | null;
  turnLanesTag?: string;
}): boolean {
  if (params.movement === "straight") {
    return false;
  }
  const parsed = parseTurnLaneTag(params.turnLanesTag);
  if (parsed) {
    if (params.movement === "left") {
      return parsed.left > 0;
    }
    if (params.movement === "right") {
      return parsed.right > 0;
    }
  }
  const straightLanes = params.straightLanes ?? null;
  if (straightLanes && params.incomingLanes > straightLanes) {
    return true;
  }
  return false;
}

export function inferLanesByClass(roadClass?: string): number {
  const normalized = normalizeRoadClass(roadClass);
  return HEURISTIC_LANES_BY_CLASS[normalized ?? "unknown"] ?? 2;
}

export function demandWeightForClass(roadClass?: string): number {
  const normalized = normalizeRoadClass(roadClass);
  return DEMAND_WEIGHT_BY_CLASS[normalized ?? "unknown"] ?? 1;
}

export function laneCapacityFactor(lanes: number): number {
  const clamped = clamp(lanes, 1, 8);
  return Math.sqrt(clamped);
}

export function resolveLaneCounts(road: LaneSource): LaneCounts {
  const forwardTag = normalizeLaneCount(road.lanesForward);
  const backwardTag = normalizeLaneCount(road.lanesBackward);
  const totalTag = normalizeLaneCount(road.lanes);
  let inferred = false;

  let total = totalTag;
  if (!total && (forwardTag || backwardTag)) {
    total = (forwardTag ?? 0) + (backwardTag ?? 0);
  }
  if (!total) {
    total = inferLanesByClass(road.class);
    inferred = true;
  }
  total = Math.max(1, total);

  const oneway = parseOneway(road.oneway);
  const isForward = oneway > 0;
  const isBackward = oneway < 0;

  let forward = forwardTag;
  let backward = backwardTag;

  if (isForward) {
    forward = forward ?? total;
    backward = 0;
  } else if (isBackward) {
    backward = backward ?? total;
    forward = 0;
  } else if (forward === undefined && backward === undefined) {
    const split = splitLanes(total);
    forward = split.forward;
    backward = split.backward;
  } else if (forward === undefined) {
    forward = Math.max(0, total - (backward ?? 0));
  } else if (backward === undefined) {
    backward = Math.max(0, total - (forward ?? 0));
  }

  return {
    total,
    forward: forward ?? 0,
    backward: backward ?? 0,
    inferred
  };
}

function normalizeRoadClass(roadClass?: string): string | undefined {
  if (!roadClass) {
    return undefined;
  }
  return roadClass.toLowerCase();
}

function normalizeLaneCount(value?: number): number | undefined {
  if (!Number.isFinite(value ?? NaN)) {
    return undefined;
  }
  const normalized = Math.round(value as number);
  return normalized > 0 ? normalized : undefined;
}

function splitLanes(total: number): { forward: number; backward: number } {
  const backward = Math.max(1, Math.floor(total / 2));
  const forward = Math.max(1, total - backward);
  return { forward, backward };
}

function parseOneway(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (value === -1 || value === "-1" || value === "reverse" || value === "backward") {
    return -1;
  }
  if (value === true || value === 1 || value === "1" || value === "yes" || value === "true") {
    return 1;
  }
  if (value === false || value === 0 || value === "0" || value === "no" || value === "false") {
    return 0;
  }
  if (value === "forward") {
    return 1;
  }
  if (value === "both") {
    return 0;
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
