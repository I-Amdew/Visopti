import { GeoBounds } from "../types";
import { Building, LatLon, Road, RoadClass, RoadDirection } from "./types";

export const OVERPASS_DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";

const OVERPASS_FALLBACK_ENDPOINTS = [
  OVERPASS_DEFAULT_ENDPOINT,
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_TYPES_KEY = "roads,buildings";
const SHOW_DIRECTION_DEFAULT = true; // Default for new OSM roads.
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 600;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

type OverpassTags = Record<string, string>;

export interface OverpassNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
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
    nodes: number;
    ways: number;
  };
  endpoint: string;
}

export interface OsmFetchResult {
  roads: Road[];
  buildings: Building[];
  meta: OsmFetchMeta;
}

interface CacheEntry {
  expiresAt: number;
  promise: Promise<OsmFetchResult>;
}

const cache = new Map<string, CacheEntry>();

export async function fetchOsmRoadsAndBuildings(
  bounds: GeoBounds,
  opts: { endpoint?: string; signal?: AbortSignal } = {}
): Promise<OsmFetchResult> {
  const endpointInput = (opts.endpoint ?? "").trim();
  const endpoints = endpointInput ? [endpointInput] : OVERPASS_FALLBACK_ENDPOINTS;
  const endpointKey = endpointInput || "auto";
  const normalizedBounds = normalizeBounds(bounds);
  const cacheKey = buildCacheKey(endpointKey, normalizedBounds);
  const cached = readCache(cacheKey);
  if (cached) {
    return cached;
  }

  const query = buildOverpassQuery(normalizedBounds);
  const promise = (async () => {
    let lastError: Error | null = null;
    for (const endpoint of endpoints) {
      try {
        const payload = await requestOverpass(endpoint, query, opts.signal);
        const { roads, buildings, nodeCount, wayCount } = parseOverpassPayload(payload);
        return {
          roads,
          buildings,
          meta: {
            fetchedAtIso: new Date().toISOString(),
            bbox: normalizedBounds,
            counts: {
              roads: roads.length,
              buildings: buildings.length,
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

function buildOverpassQuery(bounds: GeoBounds): string {
  const bbox = formatBounds(bounds);
  return `[out:json][timeout:25];
(
  way["highway"](${bbox});
  way["building"](${bbox});
);
(._;>;);
out body;`;
}

export function parseOverpassPayload(payload: OverpassResponse): {
  roads: Road[];
  buildings: Building[];
  nodeCount: number;
  wayCount: number;
} {
  if (!payload || !Array.isArray(payload.elements)) {
    const remark = payload?.remark ? ` ${payload.remark}` : "";
    throw new Error(`Overpass response missing elements array.${remark}`);
  }

  const nodeIndex = new Map<number, LatLon>();
  const ways: OverpassWay[] = [];

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
    if (!highwayTag && !buildingTag) {
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
      const road: Road = {
        id: `osm:way:${way.id}`,
        points,
        class: mapRoadClass(highwayTag),
        oneway: inferOneway(tags),
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
      const building: Building = {
        id: `osm:way:${way.id}`,
        footprint,
        heightM: parseHeightMeters(tags),
        name: tags.name,
      };
      buildings.push(building);
    }
  }

  return {
    roads,
    buildings,
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

function parseHeightValue(raw: string): number | undefined {
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

function buildCacheKey(endpoint: string, bounds: GeoBounds): string {
  return `${endpoint}|${formatBounds(bounds)}|${CACHE_TYPES_KEY}`;
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
