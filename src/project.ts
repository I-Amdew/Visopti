import {
  AppSettings,
  Building,
  GeoBounds,
  MapPoint,
  ProjectPayload,
  ProjectState,
  Road,
  RoadClass,
  RoadCustomTraffic,
  RoadHourlyDirectionalScore,
  RoadOneway,
  RoadSource,
  RoadTraffic,
  Shape,
  TrafficConfig,
  TrafficViewState
} from "./types";
import type { TileSourceId } from "./mapTiles";
import { TILE_SOURCES } from "./mapTiles";

export const CURRENT_SCHEMA_VERSION = 2;

const HOURS_PER_DAY = 24;
const DEFAULT_BASEMAP_ID: TileSourceId = TILE_SOURCES[0]?.id ?? "street";
const VALID_BASEMAP_IDS = new Set<TileSourceId>(TILE_SOURCES.map((source) => source.id));
const ROAD_CLASS_SET = new Set<RoadClass>([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "service",
  "unclassified",
  "living_street",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
  "track",
  "path",
  "cycleway",
  "footway",
  "pedestrian",
  "construction",
  "other"
]);

type LegacyTrafficByRoadId = Record<string, { forward: number; backward: number }>;

export interface RuntimeProjectState {
  bounds: GeoBounds | null;
  basemapMode?: string;
  basemapId?: TileSourceId;
  settings: AppSettings;
  shapes: Shape[];
  roadMode?: string;
  autoData?: {
    bounds?: GeoBounds | null;
    roads?: Road[];
    buildings?: Building[];
    fetchedAt?: string | null;
    endpoint?: string | null;
  };
  autoRoads?: Road[];
  autoBuildings?: Building[];
  customRoads?: Road[];
  epicenter?: { lat: number; lon: number; radiusM: number } | null;
  traffic?: { config?: TrafficConfig; data?: LegacyTrafficByRoadId | null };
  trafficConfig?: TrafficConfig;
  trafficView?: TrafficViewState;
}

export function serializeProject(state: RuntimeProjectState): ProjectPayload {
  const warnings: string[] = [];
  const settings = readSettings(state.settings, warnings);
  const shapes = readShapes(state.shapes, warnings);
  const autoRoads = readRoads(resolveAutoRoads(state), warnings, "autoRoads", "osm");
  const autoBuildings = readBuildings(resolveAutoBuildings(state), warnings, "autoBuildings");
  const customRoads = readRoads(state.customRoads, warnings, "customRoads", "custom");
  const trafficConfig = resolveTrafficConfig(state, warnings);
  const trafficView = resolveTrafficView(state, trafficConfig, warnings);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    bounds: readGeoBounds(state.bounds, warnings, "bounds"),
    basemapId: resolveBasemapId(state),
    settings,
    shapes,
    autoRoads: normalizeTrafficScores(autoRoads, trafficConfig),
    autoBuildings,
    customRoads: normalizeTrafficScores(customRoads, trafficConfig),
    trafficConfig,
    trafficView
  };
}

export function deserializeProject(
  json: string | unknown
): { state: RuntimeProjectState; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown = json;
  if (typeof json === "string") {
    raw = JSON.parse(json);
  }
  const payload = normalizePayload(raw, warnings);
  const runtime = toRuntimeState(payload, warnings);
  return { state: runtime, warnings };
}

function coerceBasemapId(value: unknown): TileSourceId | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value === "auto-street") {
    return "autoStreet";
  }
  if (VALID_BASEMAP_IDS.has(value as TileSourceId)) {
    return value as TileSourceId;
  }
  return null;
}

function toBasemapMode(value: TileSourceId): string {
  if (value === "autoStreet") {
    return "auto-street";
  }
  return value;
}

function resolveBasemapId(state: RuntimeProjectState): TileSourceId {
  const direct = coerceBasemapId(state.basemapId);
  if (direct) {
    return direct;
  }
  const fromMode = coerceBasemapId(state.basemapMode);
  return fromMode ?? DEFAULT_BASEMAP_ID;
}

function resolveAutoRoads(state: RuntimeProjectState): unknown {
  if (Array.isArray(state.autoRoads)) {
    return state.autoRoads;
  }
  if (state.autoData && Array.isArray(state.autoData.roads)) {
    return state.autoData.roads;
  }
  return [];
}

function resolveAutoBuildings(state: RuntimeProjectState): unknown {
  if (Array.isArray(state.autoBuildings)) {
    return state.autoBuildings;
  }
  if (state.autoData && Array.isArray(state.autoData.buildings)) {
    return state.autoData.buildings;
  }
  return [];
}

function resolveTrafficConfig(state: RuntimeProjectState, warnings: string[]): TrafficConfig {
  if (state.traffic?.config) {
    return readTrafficConfig(state.traffic.config, warnings);
  }
  if (state.trafficConfig) {
    return readTrafficConfig(state.trafficConfig, warnings);
  }
  return createDefaultTrafficConfig();
}

function resolveTrafficView(
  state: RuntimeProjectState,
  trafficConfig: TrafficConfig,
  warnings: string[]
): TrafficViewState {
  if (state.trafficView) {
    return readTrafficView(state.trafficView, warnings, trafficConfig);
  }
  return createDefaultTrafficView(trafficConfig);
}

function normalizeTrafficScores(roads: Road[], trafficConfig: TrafficConfig): Road[] {
  const hour = clampHour(trafficConfig.hour);
  return roads.map((road) => {
    if (!road.traffic) {
      return road;
    }
    const traffic = normalizeRoadTraffic(road.traffic, hour);
    if (!traffic) {
      const { traffic: _traffic, ...rest } = road;
      return rest;
    }
    return { ...road, traffic };
  });
}

function normalizeRoadTraffic(traffic: RoadTraffic, hour: number): RoadTraffic | undefined {
  const customCarsPerHour = traffic.customCarsPerHour;
  const hourly = traffic.hourlyDirectionalScores ?? [];
  if (hourly.length > 0) {
    const filtered = hourly.filter((entry) => Number.isFinite(entry.hour));
    if (filtered.length > 0 || Number.isFinite(customCarsPerHour)) {
      return {
        customCarsPerHour: Number.isFinite(customCarsPerHour) ? customCarsPerHour : undefined,
        hourlyDirectionalScores: filtered
      };
    }
    return undefined;
  }
  if (Number.isFinite(traffic.forward) || Number.isFinite(traffic.backward)) {
    const forward = Number.isFinite(traffic.forward) ? (traffic.forward as number) : 0;
    const backward = Number.isFinite(traffic.backward) ? (traffic.backward as number) : 0;
    return {
      customCarsPerHour: Number.isFinite(customCarsPerHour) ? customCarsPerHour : undefined,
      hourlyDirectionalScores: [{ hour, forward, backward }]
    };
  }
  if (Number.isFinite(customCarsPerHour)) {
    return { customCarsPerHour };
  }
  return undefined;
}

function normalizePayload(raw: unknown, warnings: string[]): ProjectState {
  const defaults = createDefaultProjectState();
  if (!isRecord(raw)) {
    warnings.push("Invalid project payload; using defaults.");
    return defaults;
  }

  const schemaVersion = readSchemaVersion(raw.schemaVersion, warnings);
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    warnings.push(
      `Project schemaVersion ${schemaVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}; attempting to load.`
    );
  }

  const bounds = readGeoBounds(raw.bounds, warnings, "bounds");
  const basemapId = readBasemapId(raw.basemapId ?? raw.basemapMode, warnings);
  const settings = readSettings(raw.settings, warnings);
  const shapes = readShapes(raw.shapes, warnings);

  if (schemaVersion < 2) {
    return {
      ...defaults,
      bounds,
      basemapId,
      settings,
      shapes
    };
  }

  return {
    bounds,
    basemapId,
    settings,
    shapes,
    autoRoads: readRoads(raw.autoRoads, warnings, "autoRoads", "osm"),
    autoBuildings: readBuildings(raw.autoBuildings, warnings, "autoBuildings"),
    customRoads: readRoads(raw.customRoads, warnings, "customRoads", "custom"),
    trafficConfig: readTrafficConfig(raw.trafficConfig, warnings),
    trafficView: readTrafficView(raw.trafficView, warnings, undefined)
  };
}

function toRuntimeState(payload: ProjectState, warnings: string[]): RuntimeProjectState {
  const trafficView = payload.trafficView ?? createDefaultTrafficView(payload.trafficConfig);
  const trafficData = buildTrafficByRoadId(
    [...payload.autoRoads, ...payload.customRoads],
    trafficView,
    warnings
  );

  const hasCustom = payload.customRoads.length > 0;
  const hasAuto = payload.autoRoads.length > 0;
  const roadMode = hasCustom && !hasAuto ? "custom" : "auto";

  return {
    bounds: payload.bounds,
    basemapMode: toBasemapMode(payload.basemapId),
    basemapId: payload.basemapId,
    settings: payload.settings,
    shapes: payload.shapes,
    roadMode,
    autoData: {
      bounds: payload.bounds,
      roads: payload.autoRoads,
      buildings: payload.autoBuildings,
      fetchedAt: null,
      endpoint: null
    },
    customRoads: payload.customRoads,
    epicenter: null,
    traffic: {
      config: payload.trafficConfig,
      data: trafficData
    },
    trafficView
  };
}

function buildTrafficByRoadId(
  roads: Road[],
  view: TrafficViewState,
  warnings: string[]
): LegacyTrafficByRoadId | null {
  if (!roads.length) {
    return null;
  }
  const hour = clampHour(view.hour);
  const byRoad: LegacyTrafficByRoadId = {};
  for (const road of roads) {
    const traffic = road.traffic;
    if (!traffic) {
      continue;
    }
    let forward: number | undefined;
    let backward: number | undefined;
    const hourly = traffic.hourlyDirectionalScores ?? [];
    if (hourly.length > 0) {
      const matched =
        hourly.find((entry) => Math.floor(entry.hour) === hour) ?? hourly[0];
      if (matched) {
        forward = Number.isFinite(matched.forward) ? matched.forward : undefined;
        backward = Number.isFinite(matched.backward) ? matched.backward : undefined;
      }
    } else {
      forward = Number.isFinite(traffic.forward) ? (traffic.forward as number) : undefined;
      backward = Number.isFinite(traffic.backward) ? (traffic.backward as number) : undefined;
    }

    if (forward !== undefined || backward !== undefined) {
      byRoad[road.id] = { forward: forward ?? 0, backward: backward ?? 0 };
    }
  }
  if (!Object.keys(byRoad).length && roads.some((road) => road.traffic)) {
    warnings.push("Traffic results were present but could not be normalized.");
  }
  return Object.keys(byRoad).length > 0 ? byRoad : null;
}

function createDefaultProjectState(): ProjectState {
  const trafficConfig = createDefaultTrafficConfig();
  return {
    bounds: null,
    basemapId: DEFAULT_BASEMAP_ID,
    settings: createDefaultSettings(),
    shapes: [],
    autoRoads: [],
    autoBuildings: [],
    customRoads: [],
    trafficConfig,
    trafficView: createDefaultTrafficView(trafficConfig)
  };
}

function createDefaultSettings(): AppSettings {
  return {
    siteHeightFt: 6,
    viewerHeightFt: 6,
    topoSpacingFt: 25,
    sampleStepPx: 5,
    overlays: {
      showViewers: true,
      showCandidates: true,
      showObstacles: true,
      showContours: false
    },
    opacity: {
      viewer: 0.6,
      candidate: 0.6,
      obstacle: 0.85,
      heatmap: 0.45,
      shading: 0.6,
      contours: 0.9
    }
  };
}

function createDefaultTrafficConfig(): TrafficConfig {
  return {
    preset: "neutral",
    hour: 8,
    detail: 3,
    showOverlay: true,
    showDirectionArrows: false,
    seed: 0
  };
}

function createDefaultTrafficView(config?: TrafficConfig): TrafficViewState {
  return {
    preset: config?.preset ?? "neutral",
    hour: clampHour(config?.hour ?? 8),
    showDirection: config?.showDirectionArrows ?? false
  };
}

function clampHour(value: number): number {
  const hour = Math.floor(value);
  if (hour < 0) return 0;
  if (hour >= HOURS_PER_DAY) return HOURS_PER_DAY - 1;
  return hour;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readSchemaVersion(value: unknown, warnings: string[]): number {
  if (isFiniteNumber(value)) {
    return Math.floor(value);
  }
  if (value !== undefined) {
    warnings.push("Invalid schemaVersion; assuming v1.");
  }
  return 1;
}

function readBasemapId(value: unknown, warnings: string[]): TileSourceId {
  const normalized = coerceBasemapId(value);
  if (normalized) {
    return normalized;
  }
  if (value !== undefined) {
    warnings.push("Invalid basemapId; using default.");
  }
  return DEFAULT_BASEMAP_ID;
}

function readNumber(value: unknown, fallback: number, warnings: string[], path: string): number {
  if (isFiniteNumber(value)) {
    return value;
  }
  warnings.push(`Invalid ${path}; using ${fallback}.`);
  return fallback;
}

function readOptionalNumber(
  value: unknown,
  warnings: string[],
  path: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (isFiniteNumber(value)) {
    return value;
  }
  warnings.push(`Invalid ${path}; ignoring.`);
  return undefined;
}

function readString(value: unknown, fallback: string, warnings: string[], path: string): string {
  if (typeof value === "string") {
    return value;
  }
  warnings.push(`Invalid ${path}; using ${fallback}.`);
  return fallback;
}

function readOptionalString(
  value: unknown,
  warnings: string[],
  path: string
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  warnings.push(`Invalid ${path}; ignoring.`);
  return undefined;
}

function readBoolean(value: unknown, fallback: boolean, warnings: string[], path: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  warnings.push(`Invalid ${path}; using ${fallback}.`);
  return fallback;
}

function readArray(
  value: unknown,
  warnings: string[],
  path: string,
  required = false
): unknown[] {
  if (value === undefined || value === null) {
    if (required) {
      warnings.push(`Missing ${path}; using empty array.`);
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  warnings.push(`Invalid ${path}; expected array.`);
  return [];
}

function readGeoBounds(
  value: unknown,
  warnings: string[],
  path: string
): GeoBounds | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; using null.`);
    return null;
  }
  const north = readNumber(value.north, Number.NaN, warnings, `${path}.north`);
  const south = readNumber(value.south, Number.NaN, warnings, `${path}.south`);
  const east = readNumber(value.east, Number.NaN, warnings, `${path}.east`);
  const west = readNumber(value.west, Number.NaN, warnings, `${path}.west`);
  if (![north, south, east, west].every(Number.isFinite)) {
    warnings.push(`Invalid ${path}; using null.`);
    return null;
  }
  return { north, south, east, west };
}

function readSettings(value: unknown, warnings: string[]): AppSettings {
  const defaults = createDefaultSettings();
  if (!isRecord(value)) {
    if (value !== undefined) {
      warnings.push("Invalid settings; using defaults.");
    }
    return defaults;
  }
  return {
    siteHeightFt: readNumber(value.siteHeightFt, defaults.siteHeightFt, warnings, "settings.siteHeightFt"),
    viewerHeightFt: readNumber(
      value.viewerHeightFt,
      defaults.viewerHeightFt,
      warnings,
      "settings.viewerHeightFt"
    ),
    topoSpacingFt: readNumber(
      value.topoSpacingFt,
      defaults.topoSpacingFt,
      warnings,
      "settings.topoSpacingFt"
    ),
    sampleStepPx: readNumber(
      value.sampleStepPx,
      defaults.sampleStepPx,
      warnings,
      "settings.sampleStepPx"
    ),
    overlays: readOverlaySettings(value.overlays, defaults.overlays, warnings),
    opacity: readOpacitySettings(value.opacity, defaults.opacity, warnings)
  };
}

function readOverlaySettings(
  value: unknown,
  defaults: AppSettings["overlays"],
  warnings: string[]
): AppSettings["overlays"] {
  if (!isRecord(value)) {
    if (value !== undefined) {
      warnings.push("Invalid settings.overlays; using defaults.");
    }
    return { ...defaults };
  }
  return {
    showViewers: readBoolean(
      value.showViewers,
      defaults.showViewers,
      warnings,
      "settings.overlays.showViewers"
    ),
    showCandidates: readBoolean(
      value.showCandidates,
      defaults.showCandidates,
      warnings,
      "settings.overlays.showCandidates"
    ),
    showObstacles: readBoolean(
      value.showObstacles,
      defaults.showObstacles,
      warnings,
      "settings.overlays.showObstacles"
    ),
    showContours: readBoolean(
      value.showContours,
      defaults.showContours,
      warnings,
      "settings.overlays.showContours"
    )
  };
}

function readOpacitySettings(
  value: unknown,
  defaults: AppSettings["opacity"],
  warnings: string[]
): AppSettings["opacity"] {
  if (!isRecord(value)) {
    if (value !== undefined) {
      warnings.push("Invalid settings.opacity; using defaults.");
    }
    return { ...defaults };
  }
  return {
    viewer: readNumber(value.viewer, defaults.viewer, warnings, "settings.opacity.viewer"),
    candidate: readNumber(
      value.candidate,
      defaults.candidate,
      warnings,
      "settings.opacity.candidate"
    ),
    obstacle: readNumber(value.obstacle, defaults.obstacle, warnings, "settings.opacity.obstacle"),
    heatmap: readNumber(value.heatmap, defaults.heatmap, warnings, "settings.opacity.heatmap"),
    shading: readNumber(value.shading, defaults.shading, warnings, "settings.opacity.shading"),
    contours: readNumber(value.contours, defaults.contours, warnings, "settings.opacity.contours")
  };
}

function readShapes(value: unknown, warnings: string[]): Shape[] {
  const rawShapes = readArray(value, warnings, "shapes", true);
  const shapes: Shape[] = [];
  rawShapes.forEach((raw, index) => {
    const shape = readShape(raw, warnings, `shapes[${index}]`, index);
    if (shape) {
      shapes.push(shape);
    }
  });
  return shapes;
}

function readShape(
  value: unknown,
  warnings: string[],
  path: string,
  index: number
): Shape | null {
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; skipping.`);
    return null;
  }
  const kind = value.kind;
  if (kind !== "rect" && kind !== "ellipse" && kind !== "polygon") {
    warnings.push(`Invalid ${path}.kind; skipping.`);
    return null;
  }
  const id = readString(value.id, `shape-${index}`, warnings, `${path}.id`);
  const type = readZoneType(value.type, warnings, `${path}.type`);
  const alpha = readNumber(value.alpha, 1, warnings, `${path}.alpha`);
  const direction = readViewerDirection(value.direction, warnings, `${path}.direction`);
  const viewerAnchor = readPixelPoint(value.viewerAnchor, warnings, `${path}.viewerAnchor`);

  if (kind === "polygon") {
    const points = readPixelPoints(value.points, warnings, `${path}.points`);
    if (points.length < 3) {
      warnings.push(`Invalid ${path}.points; expected at least 3 points.`);
      return null;
    }
    const shape: Shape = { id, kind, type, alpha, points };
    if (direction) {
      shape.direction = direction;
    }
    if (viewerAnchor && type === "viewer") {
      shape.viewerAnchor = viewerAnchor;
    }
    return shape;
  }

  const x = readNumber(value.x, 0, warnings, `${path}.x`);
  const y = readNumber(value.y, 0, warnings, `${path}.y`);
  const width = readNumber(value.width, 0, warnings, `${path}.width`);
  const height = readNumber(value.height, 0, warnings, `${path}.height`);
  const shape: Shape = { id, kind, type, alpha, x, y, width, height };
  if (direction) {
    shape.direction = direction;
  }
  if (viewerAnchor && type === "viewer") {
    shape.viewerAnchor = viewerAnchor;
  }
  return shape;
}

function readZoneType(value: unknown, warnings: string[], path: string) {
  if (value === "obstacle" || value === "candidate" || value === "viewer") {
    return value;
  }
  warnings.push(`Invalid ${path}; defaulting to obstacle.`);
  return "obstacle";
}

function readViewerDirection(
  value: unknown,
  warnings: string[],
  path: string
) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; ignoring.`);
    return undefined;
  }
  const angleRad = readOptionalNumber(value.angleRad, warnings, `${path}.angleRad`);
  const coneRad = readOptionalNumber(value.coneRad, warnings, `${path}.coneRad`);
  if (angleRad === undefined || coneRad === undefined) {
    return undefined;
  }
  return { angleRad, coneRad };
}

function readPixelPoint(
  value: unknown,
  warnings: string[],
  path: string
): { x: number; y: number } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; ignoring.`);
    return undefined;
  }
  const x = readOptionalNumber(value.x, warnings, `${path}.x`);
  const y = readOptionalNumber(value.y, warnings, `${path}.y`);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return { x, y };
}

function readPixelPoints(value: unknown, warnings: string[], path: string): { x: number; y: number }[] {
  const raw = readArray(value, warnings, path);
  if (raw.length === 0) {
    return [];
  }
  const points: { x: number; y: number }[] = [];
  let dropped = 0;
  raw.forEach((entry) => {
    const point = parsePixelPoint(entry);
    if (point) {
      points.push(point);
    } else {
      dropped += 1;
    }
  });
  if (dropped > 0) {
    warnings.push(`Dropped ${dropped} invalid points from ${path}.`);
  }
  return points;
}

function parsePixelPoint(value: unknown): { x: number; y: number } | null {
  if (!isRecord(value)) {
    return null;
  }
  const x = isFiniteNumber(value.x) ? value.x : null;
  const y = isFiniteNumber(value.y) ? value.y : null;
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
}

function readRoads(
  value: unknown,
  warnings: string[],
  path: string,
  fallbackSource: RoadSource
): Road[] {
  const raw = readArray(value, warnings, path);
  const roads: Road[] = [];
  raw.forEach((entry, index) => {
    const road = readRoad(entry, warnings, `${path}[${index}]`, `${path}-${index}`, fallbackSource);
    if (road) {
      roads.push(road);
    }
  });
  return roads;
}

function readRoad(
  value: unknown,
  warnings: string[],
  path: string,
  fallbackId: string,
  fallbackSource: RoadSource
): Road | null {
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; skipping.`);
    return null;
  }
  const id = readString(value.id, fallbackId, warnings, `${path}.id`);
  const source = readRoadSource(value.source, fallbackSource, warnings, `${path}.source`);
  const points = readMapPoints(value.points, warnings, `${path}.points`);
  if (points.length < 2) {
    warnings.push(`Invalid ${path}.points; expected at least 2 points.`);
    return null;
  }
  const oneway = readRoadOneway(
    value.oneway ?? value.oneWay ?? value.direction,
    warnings,
    `${path}.oneway`
  );
  const roadClass = readRoadClass(value.class, warnings, `${path}.class`);
  const name = readOptionalString(value.name, warnings, `${path}.name`);
  const showDirectionLine = readOptionalBoolean(
    value.showDirectionLine,
    warnings,
    `${path}.showDirectionLine`
  );
  const directionLine = readMapPoints(value.directionLine, warnings, `${path}.directionLine`);
  const traffic = readRoadTraffic(value.traffic, warnings, `${path}.traffic`);
  const customTraffic = readRoadCustomTraffic(value.customTraffic, warnings, `${path}.customTraffic`);

  const road: Road = {
    id,
    source,
    points,
    showDirectionLine: showDirectionLine ?? undefined
  };
  if (oneway !== undefined) {
    road.oneway = oneway;
  }
  if (roadClass) {
    road.class = roadClass;
  }
  if (name) {
    road.name = name;
  }
  if (directionLine.length > 1) {
    road.directionLine = directionLine;
  }
  if (traffic) {
    road.traffic = traffic;
  }
  if (customTraffic) {
    road.customTraffic = customTraffic;
  }
  return road;
}

function readRoadSource(
  value: unknown,
  fallback: RoadSource,
  warnings: string[],
  path: string
): RoadSource {
  if (value === "osm" || value === "custom") {
    return value;
  }
  if (value === "auto") {
    warnings.push(`Mapping ${path} value auto to osm.`);
    return "osm";
  }
  if (value !== undefined) {
    warnings.push(`Invalid ${path}; using ${fallback}.`);
  }
  return fallback;
}

function readRoadClass(value: unknown, warnings: string[], path: string): RoadClass | undefined {
  if (typeof value === "string") {
    if (ROAD_CLASS_SET.has(value as RoadClass)) {
      return value as RoadClass;
    }
    warnings.push(`Invalid ${path}; using other.`);
    return "other";
  }
  if (value !== undefined) {
    warnings.push(`Invalid ${path}; ignoring.`);
  }
  return undefined;
}

function readRoadOneway(
  value: unknown,
  warnings: string[],
  path: string
): RoadOneway | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 0) {
      return 1;
    }
    if (value < 0) {
      return -1;
    }
    return 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "forward" || normalized === "yes" || normalized === "true" || normalized === "1") {
      return 1;
    }
    if (normalized === "backward" || normalized === "reverse" || normalized === "-1") {
      return -1;
    }
    if (normalized === "both" || normalized === "no" || normalized === "false" || normalized === "0") {
      return 0;
    }
  }
  warnings.push(`Invalid ${path}; ignoring.`);
  return undefined;
}

function readRoadTraffic(
  value: unknown,
  warnings: string[],
  path: string
): RoadTraffic | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; ignoring.`);
    return undefined;
  }
  const customCarsPerHour = readOptionalNumber(
    value.customCarsPerHour,
    warnings,
    `${path}.customCarsPerHour`
  );
  const hourlyDirectionalScores = readHourlyDirectionalScores(
    value.hourlyDirectionalScores,
    warnings,
    `${path}.hourlyDirectionalScores`
  );
  const forward = readOptionalNumber(value.forward, warnings, `${path}.forward`);
  const backward = readOptionalNumber(value.backward, warnings, `${path}.backward`);

  if (
    customCarsPerHour === undefined &&
    hourlyDirectionalScores.length === 0 &&
    forward === undefined &&
    backward === undefined
  ) {
    return undefined;
  }
  const traffic: RoadTraffic = {};
  if (customCarsPerHour !== undefined) {
    traffic.customCarsPerHour = customCarsPerHour;
  }
  if (hourlyDirectionalScores.length > 0) {
    traffic.hourlyDirectionalScores = hourlyDirectionalScores;
  }
  if (forward !== undefined) {
    traffic.forward = forward;
  }
  if (backward !== undefined) {
    traffic.backward = backward;
  }
  return traffic;
}

function readRoadCustomTraffic(
  value: unknown,
  warnings: string[],
  path: string
): RoadCustomTraffic | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; ignoring.`);
    return undefined;
  }
  const forward = readNullableNumber(value.forward, warnings, `${path}.forward`);
  const backward = readNullableNumber(value.backward, warnings, `${path}.backward`);
  if (forward === undefined && backward === undefined) {
    return undefined;
  }
  const customTraffic: RoadCustomTraffic = {};
  if (forward !== undefined) {
    customTraffic.forward = forward;
  }
  if (backward !== undefined) {
    customTraffic.backward = backward;
  }
  return customTraffic;
}

function readHourlyDirectionalScores(
  value: unknown,
  warnings: string[],
  path: string
): RoadHourlyDirectionalScore[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`Invalid ${path}; expected array.`);
    return [];
  }
  const scores: RoadHourlyDirectionalScore[] = [];
  let dropped = 0;
  value.forEach((entry) => {
    const parsed = parseHourlyDirectionalScore(entry);
    if (parsed) {
      scores.push(parsed);
    } else {
      dropped += 1;
    }
  });
  if (dropped > 0) {
    warnings.push(`Dropped ${dropped} invalid entries from ${path}.`);
  }
  return scores;
}

function parseHourlyDirectionalScore(value: unknown): RoadHourlyDirectionalScore | null {
  if (!isRecord(value)) {
    return null;
  }
  const hour = parseHour(value.hour);
  const forward = parseFiniteNumber(value.forward);
  const backward = parseFiniteNumber(value.backward);
  if (hour === null || forward === null || backward === null) {
    return null;
  }
  return { hour, forward, backward };
}

function parseHour(value: unknown): number | null {
  const numeric = parseFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  const hour = Math.floor(numeric);
  if (hour < 0 || hour >= HOURS_PER_DAY) {
    return null;
  }
  return hour;
}

function parseFiniteNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function readMapPoints(value: unknown, warnings: string[], path: string): MapPoint[] {
  const raw = readArray(value, warnings, path);
  if (raw.length === 0) {
    return [];
  }
  const points: MapPoint[] = [];
  let dropped = 0;
  raw.forEach((entry) => {
    const point = parseMapPoint(entry);
    if (point) {
      points.push(point);
    } else {
      dropped += 1;
    }
  });
  if (dropped > 0) {
    warnings.push(`Dropped ${dropped} invalid points from ${path}.`);
  }
  return points;
}

function parseMapPoint(value: unknown): MapPoint | null {
  if (!isRecord(value)) {
    return null;
  }
  if (isFiniteNumber(value.x) && isFiniteNumber(value.y)) {
    return { x: value.x, y: value.y };
  }
  if (isFiniteNumber(value.lat) && isFiniteNumber(value.lon)) {
    return { lat: value.lat, lon: value.lon };
  }
  return null;
}

function readBuildings(value: unknown, warnings: string[], path: string): Building[] {
  const raw = readArray(value, warnings, path);
  const buildings: Building[] = [];
  raw.forEach((entry, index) => {
    const building = readBuilding(entry, warnings, `${path}[${index}]`, `${path}-${index}`);
    if (building) {
      buildings.push(building);
    }
  });
  return buildings;
}

function readBuilding(
  value: unknown,
  warnings: string[],
  path: string,
  fallbackId: string
): Building | null {
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; skipping.`);
    return null;
  }
  const id = readString(value.id, fallbackId, warnings, `${path}.id`);
  const footprint = readMapPoints(
    value.footprint ?? value.polygon ?? value.outline ?? value.points,
    warnings,
    `${path}.footprint`
  );
  if (footprint.length < 3) {
    warnings.push(`Invalid ${path}.footprint; expected at least 3 points.`);
    return null;
  }
  const height = readOptionalNumber(value.height, warnings, `${path}.height`);
  const heightM = readOptionalNumber(value.heightM, warnings, `${path}.heightM`);
  const tags = mergeTags(
    readTags(value.tags, warnings, `${path}.tags`),
    readOptionalString(value.name, warnings, `${path}.name`)
  );
  const building: Building = { id, footprint };
  const resolvedHeight = height ?? heightM;
  if (resolvedHeight !== undefined) {
    building.height = resolvedHeight;
  }
  if (tags) {
    building.tags = tags;
  }
  return building;
}

function readTags(
  value: unknown,
  warnings: string[],
  path: string
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; ignoring.`);
    return undefined;
  }
  const tags: Record<string, string> = {};
  let dropped = 0;
  Object.entries(value).forEach(([key, entry]) => {
    if (typeof entry === "string") {
      tags[key] = entry;
    } else {
      dropped += 1;
    }
  });
  if (dropped > 0) {
    warnings.push(`Dropped ${dropped} non-string tags from ${path}.`);
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function mergeTags(
  tags: Record<string, string> | undefined,
  name: string | undefined
): Record<string, string> | undefined {
  if (!tags && !name) {
    return undefined;
  }
  const merged: Record<string, string> = tags ? { ...tags } : {};
  if (name && !merged.name) {
    merged.name = name;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function readTrafficConfig(value: unknown, warnings: string[]): TrafficConfig {
  const defaults = createDefaultTrafficConfig();
  if (!isRecord(value)) {
    if (value !== undefined) {
      warnings.push("Invalid trafficConfig; using defaults.");
    }
    return defaults;
  }
  return {
    preset: readString(value.preset, defaults.preset, warnings, "trafficConfig.preset"),
    hour: clampHour(readNumber(value.hour, defaults.hour, warnings, "trafficConfig.hour")),
    detail: readNumber(value.detail, defaults.detail, warnings, "trafficConfig.detail"),
    showOverlay: readBoolean(
      value.showOverlay,
      defaults.showOverlay,
      warnings,
      "trafficConfig.showOverlay"
    ),
    showDirectionArrows: readBoolean(
      value.showDirectionArrows,
      defaults.showDirectionArrows,
      warnings,
      "trafficConfig.showDirectionArrows"
    ),
    seed: readNumber(value.seed, defaults.seed, warnings, "trafficConfig.seed")
  };
}

function readTrafficView(
  value: unknown,
  warnings: string[],
  fallback?: TrafficConfig
): TrafficViewState {
  const defaults = createDefaultTrafficView(fallback);
  if (!isRecord(value)) {
    if (value !== undefined) {
      warnings.push("Invalid trafficView; using defaults.");
    }
    return defaults;
  }
  return {
    preset: readString(value.preset, defaults.preset, warnings, "trafficView.preset"),
    hour: clampHour(readNumber(value.hour, defaults.hour, warnings, "trafficView.hour")),
    showDirection: readBoolean(
      value.showDirection,
      defaults.showDirection,
      warnings,
      "trafficView.showDirection"
    )
  };
}

function readOptionalBoolean(
  value: unknown,
  warnings: string[],
  path: string
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  warnings.push(`Invalid ${path}; ignoring.`);
  return undefined;
}

function readNullableNumber(
  value: unknown,
  warnings: string[],
  path: string
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (isFiniteNumber(value)) {
    return value;
  }
  warnings.push(`Invalid ${path}; ignoring.`);
  return undefined;
}
