import { GeoBounds } from "../types";
import { inferLanesByClass, parseLaneTag } from "../traffic/lanes";
import { Building, LatLon, Road, RoadClass, RoadDirection, Sign, TrafficSignal, Tree } from "./types";
import { DEFAULT_TREE_RADIUS_METERS } from "../obstacles";

export const OVERPASS_DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";

const OVERPASS_FALLBACK_ENDPOINTS = [
  OVERPASS_DEFAULT_ENDPOINT,
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_TYPES_BASE = "roads";
const SHOW_DIRECTION_DEFAULT = true; // Default for new OSM roads.
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 600;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_OSM_TREES = 1500;

type OverpassTags = Record<string, string>;

export type RoadClassFilter = "all" | "major";

const MAJOR_ROAD_REGEX = "^(motorway|trunk|primary|secondary)(_link)?$";

export interface OverpassNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: OverpassTags;
}

export interface OverpassWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: OverpassTags;
}

export interface OverpassResponse {
  elements: Array<OverpassNode | OverpassWay | { type: string; id: number }>;
  remark?: string;
}

export interface OsmFetchMeta {
  fetchedAtIso: string;
  bbox: GeoBounds;
  counts: {
    roads: number;
    buildings: number;
    trees: number;
    signs: number;
    trafficSignals: number;
    nodes: number;
    ways: number;
  };
  endpoint: string;
}

export interface OsmFetchResult {
  roads: Road[];
  buildings: Building[];
  trees: Tree[];
  signs: Sign[];
  trafficSignals: TrafficSignal[];
  meta: OsmFetchMeta;
}

interface CacheEntry {
  expiresAt: number;
  promise: Promise<OsmFetchResult>;
}

const cache = new Map<string, CacheEntry>();

export async function fetchOsmRoadsAndBuildings(
  bounds: GeoBounds,
  opts: {
    endpoint?: string;
    signal?: AbortSignal;
    includeObstacles?: boolean;
    includeBuildings?: boolean;
    includeTrafficSignals?: boolean;
    roadClassFilter?: RoadClassFilter;
  } = {}
): Promise<OsmFetchResult> {
  const endpointInput = (opts.endpoint ?? "").trim();
  const endpoints = endpointInput ? [endpointInput] : OVERPASS_FALLBACK_ENDPOINTS;
  const endpointKey = endpointInput || "auto";
  const normalizedBounds = normalizeBounds(bounds);
  const includeObstacles = opts.includeObstacles === true;
  const includeBuildings = opts.includeBuildings !== false;
  const includeTrafficSignals = opts.includeTrafficSignals === true || includeObstacles;
  const roadClassFilter = opts.roadClassFilter ?? "all";
  const cacheKey = buildCacheKey(endpointKey, normalizedBounds, {
    includeObstacles,
    includeBuildings,
    includeTrafficSignals,
    roadClassFilter
  });
  const cached = readCache(cacheKey);
  if (cached) {
    return cached;
  }

  const query = buildOverpassQuery(normalizedBounds, {
    includeObstacles,
    includeBuildings,
    includeTrafficSignals,
    roadClassFilter
  });
  const promise = (async () => {
    let lastError: Error | null = null;
    for (const endpoint of endpoints) {
      try {
        const payload = await requestOverpass(endpoint, query, opts.signal);
        const {
          roads,
          buildings,
          trees,
          signs,
          trafficSignals,
          nodeCount,
          wayCount,
        } = parseOverpassPayload(payload);
        return {
          roads,
          buildings,
          trees,
          signs,
          trafficSignals,
          meta: {
            fetchedAtIso: new Date().toISOString(),
            bbox: normalizedBounds,
            counts: {
              roads: roads.length,
              buildings: buildings.length,
              trees: trees.length,
              signs: signs.length,
              trafficSignals: trafficSignals.length,
              nodes: nodeCount,
              ways: wayCount,
            },
            endpoint,
          },
        };
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        lastError = error as Error;
      }
    }
    throw lastError ?? new Error("Overpass request failed.");
  })();

  writeCache(cacheKey, promise);
  return promise;
}

function buildOverpassQuery(
  bounds: GeoBounds,
  options: {
    includeObstacles: boolean;
    includeBuildings: boolean;
    includeTrafficSignals: boolean;
    roadClassFilter: RoadClassFilter;
  }
): string {
  const bbox = formatBounds(bounds);
  const roadQuery =
    options.roadClassFilter === "major"
      ? `  way["highway"~"${MAJOR_ROAD_REGEX}"](${bbox});`
      : `  way["highway"](${bbox});`;
  const buildingQuery = options.includeBuildings ? `  way["building"](${bbox});` : "";
  const signalQuery = options.includeTrafficSignals
    ? `  node["highway"="traffic_signals"](${bbox});`
    : "";
  const obstacleQuery = options.includeObstacles
    ? `
  node["advertising"="billboard"](${bbox});
  way["advertising"="billboard"](${bbox});
  node["natural"="tree"](${bbox});
`
    : "";
  return `[out:json][timeout:25];
(
${roadQuery}
${buildingQuery}
${signalQuery}
${obstacleQuery}
);
(._;>;);
out body;`;
}

export function parseOverpassPayload(payload: OverpassResponse): {
  roads: Road[];
  buildings: Building[];
  trees: Tree[];
  signs: Sign[];
  trafficSignals: TrafficSignal[];
  nodeCount: number;
  wayCount: number;
} {
  if (!payload || !Array.isArray(payload.elements)) {
    const remark = payload?.remark ? ` ${payload.remark}` : "";
    throw new Error(`Overpass response missing elements array.${remark}`);
  }

  const nodeIndex = new Map<number, LatLon>();
  const ways: OverpassWay[] = [];
  const trees: Tree[] = [];
  const signs: Sign[] = [];
  const trafficSignals: TrafficSignal[] = [];

  for (const element of payload.elements) {
    if (!element || typeof element !== "object") {
      continue;
    }
    if (element.type === "node") {
      const node = element as OverpassNode;
      if (!Number.isFinite(node.lat) || !Number.isFinite(node.lon)) {
        continue;
      }
      const lat = clampLat(node.lat);
      const lon = clampLon(node.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }
      nodeIndex.set(node.id, { lat, lon });
      const tags = node.tags ?? {};
      if (tags.highway === "traffic_signals") {
        trafficSignals.push({ id: `osm:node:${node.id}`, location: { lat, lon } });
      }
      if (tags.advertising === "billboard") {
        signs.push({
          id: `osm:node:${node.id}`,
          location: { lat, lon },
          kind: "billboard",
          widthMeters: parseHeightValue(tags.width),
          heightMeters: parseHeightValue(tags.height),
          bottomClearanceMeters: parseHeightValue(tags.min_height)
        });
      }
      if (tags.natural === "tree") {
        const baseRadius =
          parseTreeRadiusMeters(tags) ?? DEFAULT_TREE_RADIUS_METERS;
        trees.push({
          id: `osm:node:${node.id}`,
          location: { lat, lon },
          type: mapTreeType(tags),
          baseRadiusMeters: baseRadius,
          heightMeters: parseHeightValue(tags.height)
        });
      }
    } else if (element.type === "way") {
      const way = element as OverpassWay;
      if (!Array.isArray(way.nodes) || way.nodes.length === 0) {
        continue;
      }
      ways.push(way);
    }
  }

  const roads: Road[] = [];
  const buildings: Building[] = [];

  for (const way of ways) {
    const tags = way.tags ?? {};
    const highwayTag = typeof tags.highway === "string" ? tags.highway : undefined;
    const buildingTag = typeof tags.building === "string" ? tags.building : undefined;
    const billboardTag = typeof tags.advertising === "string" ? tags.advertising : undefined;
    if (!highwayTag && !buildingTag && billboardTag !== "billboard") {
      continue;
    }

    const points = buildWayPoints(way, nodeIndex);
    if (!points) {
      continue;
    }

    if (highwayTag) {
      if (points.length < 2) {
        continue;
      }
      const roadClass = mapRoadClass(highwayTag);
      const oneway = inferOneway(tags);
      const laneData = resolveLaneData(tags, roadClass, oneway);
      const road: Road = {
        id: `osm:way:${way.id}`,
        points,
        class: roadClass,
        oneway,
        lanes: laneData.lanes,
        lanesForward: laneData.lanesForward,
        lanesBackward: laneData.lanesBackward,
        lanesInferred: laneData.lanesInferred ? true : undefined,
        name: tags.name ?? tags.ref,
        showDirectionLine: SHOW_DIRECTION_DEFAULT,
        traffic: {
          basis: "simulated",
        },
      };
      roads.push(road);
    }

    if (buildingTag) {
      if (points.length < 3) {
        continue;
      }
      const footprint = closeRing(points);
      if (footprint.length < 4) {
        continue;
      }
      const buildingTags = pickBuildingTags(tags);
      const building: Building = {
        id: `osm:way:${way.id}`,
        footprint,
        heightM: parseHeightMeters(tags),
        name: tags.name,
        tags: buildingTags,
      };
      buildings.push(building);
    }

    if (billboardTag === "billboard") {
      const centroid = computeCentroid(points);
      if (!centroid) {
        continue;
      }
      signs.push({
        id: `osm:way:${way.id}`,
        location: centroid,
        kind: "billboard",
        widthMeters: parseHeightValue(tags.width),
        heightMeters: parseHeightValue(tags.height),
        bottomClearanceMeters: parseHeightValue(tags.min_height)
      });
    }
  }

  if (trees.length > MAX_OSM_TREES) {
    trees.splice(MAX_OSM_TREES);
  }

  return {
    roads,
    buildings,
    trees,
    signs,
    trafficSignals,
    nodeCount: nodeIndex.size,
    wayCount: ways.length,
  };
}

function buildWayPoints(way: OverpassWay, nodes: Map<number, LatLon>): LatLon[] | null {
  const points: LatLon[] = [];
  for (const nodeId of way.nodes) {
    const point = nodes.get(nodeId);
    if (!point) {
      return null;
    }
    points.push({ lat: point.lat, lon: point.lon });
  }
  return points;
}

function mapRoadClass(value: string): RoadClass {
  const normalized = value.trim().toLowerCase();
  return ROAD_CLASS_MAP[normalized] ?? "other";
}

function inferOneway(tags: OverpassTags): RoadDirection {
  const oneway = tags.oneway?.toLowerCase();
  if (oneway === "-1" || oneway === "reverse") {
    return "backward";
  }
  if (oneway === "yes" || oneway === "true" || oneway === "1") {
    return "forward";
  }
  if (oneway === "no" || oneway === "false" || oneway === "0") {
    return "both";
  }
  const junction = tags.junction?.toLowerCase();
  if (junction === "roundabout" || junction === "circular") {
    return "forward";
  }
  return "both";
}

function parseHeightMeters(tags: OverpassTags): number | undefined {
  const rawHeight = tags.height;
  if (rawHeight) {
    const parsed = parseHeightValue(rawHeight);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  const rawLevels = tags["building:levels"];
  if (rawLevels) {
    const levels = Number.parseFloat(rawLevels);
    if (Number.isFinite(levels) && levels > 0) {
      return levels * 3;
    }
  }
  return undefined;
}

function pickBuildingTags(tags: OverpassTags): Record<string, string> | undefined {
  const picked: Record<string, string> = {};
  if (typeof tags.height === "string") {
    picked.height = tags.height;
  }
  if (typeof tags["building:levels"] === "string") {
    picked["building:levels"] = tags["building:levels"];
  }
  if (typeof tags.min_height === "string") {
    picked.min_height = tags.min_height;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function mapTreeType(tags: OverpassTags): Tree["type"] {
  const leafType = tags.leaf_type?.toLowerCase();
  if (leafType === "needleleaved" || leafType === "needleleaf" || leafType === "needle-leaved") {
    return "pine";
  }
  return "deciduous";
}

function parseTreeRadiusMeters(tags: OverpassTags): number | undefined {
  const diameter =
    parseHeightValue(tags.diameter_crown) ??
    parseHeightValue(tags["diameter_crown"]) ??
    parseHeightValue(tags.crown_diameter) ??
    parseHeightValue(tags["crown_diameter"]);
  if (!diameter) {
    return undefined;
  }
  return diameter / 2;
}

function computeCentroid(points: LatLon[]): LatLon | null {
  if (!points.length) {
    return null;
  }
  let latTotal = 0;
  let lonTotal = 0;
  for (const point of points) {
    latTotal += point.lat;
    lonTotal += point.lon;
  }
  return { lat: latTotal / points.length, lon: lonTotal / points.length };
}

interface LaneData {
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  lanesInferred: boolean;
}

function resolveLaneData(
  tags: OverpassTags,
  roadClass: RoadClass,
  oneway: RoadDirection
): LaneData {
  const lanesTag = parseLaneTag(tags.lanes);
  const forwardTag = parseLaneTag(tags["lanes:forward"]);
  const backwardTag = parseLaneTag(tags["lanes:backward"]);
  let lanes = lanesTag;
  let lanesForward = forwardTag;
  let lanesBackward = backwardTag;
  let lanesInferred = false;

  if (!lanes && (lanesForward || lanesBackward)) {
    lanes = (lanesForward ?? 0) + (lanesBackward ?? 0);
  }

  if (!lanes && !lanesForward && !lanesBackward) {
    lanes = inferLanesByClass(roadClass);
    lanesInferred = true;
    if (oneway === "forward") {
      lanesForward = lanes;
    } else if (oneway === "backward") {
      lanesBackward = lanes;
    }
  }

  return { lanes, lanesForward, lanesBackward, lanesInferred };
}

// Lane parsing and inference are shared with the traffic simulation logic.

function parseHeightValue(raw: string | number | null | undefined): number | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  const match = normalized.match(/-?\d+(\.\d+)?/);
  if (!match) {
    return undefined;
  }
  const value = Number.parseFloat(match[0]);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  if (normalized.includes("ft") || normalized.includes("feet") || normalized.includes("foot")) {
    return value * 0.3048;
  }
  if (normalized.includes("cm")) {
    return value / 100;
  }
  if (normalized.includes("mm")) {
    return value / 1000;
  }
  return value;
}

function closeRing(points: LatLon[]): LatLon[] {
  if (points.length === 0) {
    return points;
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (first.lat === last.lat && first.lon === last.lon) {
    return points;
  }
  return [...points, { lat: first.lat, lon: first.lon }];
}

function normalizeBounds(bounds: GeoBounds): GeoBounds {
  const north = clampLat(Math.max(bounds.north, bounds.south));
  const south = clampLat(Math.min(bounds.north, bounds.south));
  const east = clampLon(Math.max(bounds.east, bounds.west));
  const west = clampLon(Math.min(bounds.east, bounds.west));
  return { north, south, east, west };
}

function formatBounds(bounds: GeoBounds): string {
  return [
    bounds.south.toFixed(6),
    bounds.west.toFixed(6),
    bounds.north.toFixed(6),
    bounds.east.toFixed(6),
  ].join(",");
}

function buildCacheKey(
  endpoint: string,
  bounds: GeoBounds,
  options: {
    includeObstacles: boolean;
    includeBuildings: boolean;
    includeTrafficSignals: boolean;
    roadClassFilter: RoadClassFilter;
  }
): string {
  return `${endpoint}|${formatBounds(bounds)}|${buildCacheTypesKey(options)}`;
}

function buildCacheTypesKey(options: {
  includeObstacles: boolean;
  includeBuildings: boolean;
  includeTrafficSignals: boolean;
  roadClassFilter: RoadClassFilter;
}): string {
  const roadKey = options.roadClassFilter === "major" ? "roads:major" : "roads:all";
  const buildingKey = options.includeBuildings ? "buildings" : "no_buildings";
  const obstacleKey = options.includeObstacles ? "obstacles" : "no_obstacles";
  const signalKey = options.includeTrafficSignals ? "signals" : "no_signals";
  return [CACHE_TYPES_BASE, roadKey, buildingKey, obstacleKey, signalKey].join(",");
}

function readCache(key: string): Promise<OsmFetchResult> | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.promise;
}

function writeCache(key: string, promise: Promise<OsmFetchResult>): void {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  promise.catch(() => {
    const entry = cache.get(key);
    if (entry?.promise === promise) {
      cache.delete(key);
    }
  });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return "";
  }
}

async function requestOverpass(
  endpoint: string,
  query: string,
  signal?: AbortSignal
): Promise<OverpassResponse> {
  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (attempt < MAX_RETRIES) {
        await sleep(computeBackoffMs(attempt, null));
        attempt += 1;
        continue;
      }
      throw new Error("Overpass unavailable. Check your network and try again.");
    }

    if (response.ok) {
      try {
        return (await response.json()) as OverpassResponse;
      } catch (error) {
        throw new Error("Overpass response was not valid JSON.");
      }
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
      await sleep(computeBackoffMs(attempt, retryAfterMs));
      attempt += 1;
      continue;
    }

    const detail = await safeReadText(response);
    throw new Error(buildOverpassErrorMessage(response, detail));
  }
}

function buildOverpassErrorMessage(response: Response, detail: string): string {
  if (response.status === 429) {
    return "Overpass rate-limited. Wait a minute and try again.";
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return "Overpass timed out. Zoom in and try again.";
  }
  const cleaned = detail.replace(/\s+/g, " ").trim();
  const snippet = cleaned ? ` ${cleaned.slice(0, 300)}` : "";
  return `Overpass request failed (${response.status} ${response.statusText}).${snippet}`;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) {
    return null;
  }
  return Math.max(0, dateMs - Date.now());
}

function computeBackoffMs(attempt: number, retryAfterMs: number | null): number {
  const base = RETRY_BASE_MS * 2 ** attempt;
  const jitter = RETRY_BASE_MS * 0.3 * Math.random();
  const retry = retryAfterMs ?? 0;
  return Math.max(base, retry) + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function clampLat(value: number): number {
  return clamp(value, -90, 90);
}

function clampLon(value: number): number {
  return clamp(value, -180, 180);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

const ROAD_CLASS_MAP: Record<string, RoadClass> = {
  motorway: "motorway",
  motorway_link: "motorway",
  trunk: "trunk",
  trunk_link: "trunk",
  primary: "primary",
  primary_link: "primary",
  secondary: "secondary",
  secondary_link: "secondary",
  tertiary: "tertiary",
  tertiary_link: "tertiary",
  residential: "residential",
  unclassified: "unclassified",
  living_street: "living_street",
  service: "service",
  track: "track",
  path: "path",
  footway: "footway",
  steps: "footway",
  pedestrian: "pedestrian",
  cycleway: "cycleway",
  bridleway: "path",
  corridor: "path",
};
