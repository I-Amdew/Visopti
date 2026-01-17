import {
  AppSettings,
  Building,
  GeoBounds,
  GeoPoint,
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
  Sign,
  Shape,
  TrafficSignal,
  Tree,
  DenseCover,
  ZoneType,
  StructureParams,
  StructureMode,
  ImportedModelRef,
  TrafficByRoadId,
  TrafficConfig,
  TrafficFlowDensity,
  TrafficDirectionalScores,
  TrafficViewState,
  StructureParamsV2
} from "./types";
import {
  DEFAULT_SIGN_DIMENSIONS,
  DEFAULT_SIGN_HEIGHT_SOURCE,
  DEFAULT_SIGN_KIND,
  DEFAULT_SIGN_YAW_DEGREES,
  DEFAULT_TREE_HEIGHT_SOURCE,
  DEFAULT_TREE_RADIUS_METERS,
  DEFAULT_TREE_TYPE,
  deriveTreeHeightMeters
} from "./obstacles";
import type { TileSourceId } from "./mapTiles";
import { TILE_SOURCES } from "./mapTiles";

export const CURRENT_SCHEMA_VERSION = 5;

const HOURS_PER_DAY = 24;
const TRAFFIC_HOUR_MIN = 6;
const TRAFFIC_HOUR_MAX = 20;
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
const FEET_TO_METERS = 0.3048;

export interface RuntimeProjectState {
  bounds: GeoBounds | null;
  basemapMode?: string;
  basemapId?: TileSourceId;
  settings: AppSettings;
  shapes: Shape[];
  denseCover?: DenseCover[];
  trees?: Tree[];
  signs?: Sign[];
  structure?: StructureParams;
  roadMode?: string;
  autoData?: {
    bounds?: GeoBounds | null;
    roads?: Road[];
    buildings?: Building[];
    trees?: Tree[];
    signs?: Sign[];
    trafficSignals?: TrafficSignal[];
    fetchedAt?: string | null;
    endpoint?: string | null;
  };
  autoRoads?: Road[];
  autoBuildings?: Building[];
  autoTrees?: Tree[];
  autoSigns?: Sign[];
  autoTrafficSignals?: TrafficSignal[];
  customRoads?: Road[];
  epicenter?: { lat: number; lon: number; radiusM: number } | null;
  traffic?: { config?: TrafficConfig; data?: TrafficByRoadId | null };
  trafficConfig?: TrafficConfig;
  trafficView?: TrafficViewState;
}

export function serializeProject(state: RuntimeProjectState): ProjectPayload {
  const warnings: string[] = [];
  const settings = readSettings(state.settings, warnings);
  const shapes = readShapes(state.shapes, warnings);
  const denseCover = readDenseCover(state.denseCover, warnings, "denseCover");
  const trees = readTrees(state.trees, warnings, "trees");
  const signs = readSigns(state.signs, warnings, "signs");
  const structure = readStructure(state.structure, warnings);
  const autoRoads = readRoads(resolveAutoRoads(state), warnings, "autoRoads", "osm");
  const autoBuildings = readBuildings(resolveAutoBuildings(state), warnings, "autoBuildings");
  const autoTrees = readTrees(resolveAutoTrees(state), warnings, "autoTrees");
  const autoSigns = readSigns(resolveAutoSigns(state), warnings, "autoSigns");
  const autoTrafficSignals = readTrafficSignals(
    resolveAutoTrafficSignals(state),
    warnings,
    "autoTrafficSignals"
  );
  const customRoads = readRoads(state.customRoads, warnings, "customRoads", "custom");
  const trafficConfig = resolveTrafficConfig(state, warnings);
  const trafficView = resolveTrafficView(state, trafficConfig, warnings);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    bounds: readGeoBounds(state.bounds, warnings, "bounds"),
    basemapId: resolveBasemapId(state),
    settings,
    shapes,
    denseCover,
    structure,
    autoRoads: normalizeTrafficScores(autoRoads, trafficConfig),
    autoBuildings,
    autoTrees,
    autoSigns,
    autoTrafficSignals,
    customRoads: normalizeTrafficScores(customRoads, trafficConfig),
    trees,
    signs,
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

function resolveAutoTrees(state: RuntimeProjectState): unknown {
  if (Array.isArray(state.autoTrees)) {
    return state.autoTrees;
  }
  if (state.autoData && Array.isArray(state.autoData.trees)) {
    return state.autoData.trees;
  }
  return [];
}

function resolveAutoSigns(state: RuntimeProjectState): unknown {
  if (Array.isArray(state.autoSigns)) {
    return state.autoSigns;
  }
  if (state.autoData && Array.isArray(state.autoData.signs)) {
    return state.autoData.signs;
  }
  return [];
}

function resolveAutoTrafficSignals(state: RuntimeProjectState): unknown {
  if (Array.isArray(state.autoTrafficSignals)) {
    return state.autoTrafficSignals;
  }
  if (state.autoData && Array.isArray(state.autoData.trafficSignals)) {
    return state.autoData.trafficSignals;
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
  const hour = clampTrafficHour(trafficConfig.hour);
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
  const denseCover = readDenseCover(raw.denseCover, warnings, "denseCover");
  const structure = readStructure(raw.structure, warnings);

  if (schemaVersion < 2) {
    return {
      ...defaults,
      bounds,
      basemapId,
      settings,
      shapes,
      denseCover,
      structure
    };
  }

  return {
    bounds,
    basemapId,
    settings,
    shapes,
    denseCover,
    trees: readTrees(raw.trees, warnings, "trees"),
    signs: readSigns(raw.signs, warnings, "signs"),
    structure,
    autoRoads: readRoads(raw.autoRoads, warnings, "autoRoads", "osm"),
    autoBuildings: readBuildings(raw.autoBuildings, warnings, "autoBuildings"),
    autoTrees: readTrees(raw.autoTrees, warnings, "autoTrees"),
    autoSigns: readSigns(raw.autoSigns, warnings, "autoSigns"),
    autoTrafficSignals: readTrafficSignals(
      raw.autoTrafficSignals,
      warnings,
      "autoTrafficSignals"
    ),
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
    denseCover: payload.denseCover,
    trees: payload.trees,
    signs: payload.signs,
    structure: payload.structure,
    roadMode,
    autoData: {
      bounds: payload.bounds,
      roads: payload.autoRoads,
      buildings: payload.autoBuildings,
      trees: payload.autoTrees,
      signs: payload.autoSigns,
      trafficSignals: payload.autoTrafficSignals,
      fetchedAt: null,
      endpoint: null
    },
    autoRoads: payload.autoRoads,
    autoBuildings: payload.autoBuildings,
    autoTrees: payload.autoTrees,
    autoSigns: payload.autoSigns,
    autoTrafficSignals: payload.autoTrafficSignals,
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
): TrafficByRoadId | null {
  if (!roads.length) {
    return null;
  }
  const baseHour = clampTrafficHour(view.hour);
  const byRoad: TrafficByRoadId = {};
  for (const road of roads) {
    const traffic = road.traffic ? normalizeRoadTraffic(road.traffic, baseHour) : undefined;
    if (!traffic) {
      continue;
    }
    const byHour: Record<number, TrafficDirectionalScores> = {};
    const hourly = traffic.hourlyDirectionalScores ?? [];
    hourly.forEach((entry) => {
      const hour = parseHour(entry.hour);
      if (hour === null) {
        return;
      }
      const forward = parseFiniteNumber(entry.forward);
      const backward = parseFiniteNumber(entry.backward);
      if (forward === null && backward === null) {
        return;
      }
      const scores: TrafficDirectionalScores = {};
      if (forward !== null) {
        scores.forward = forward;
      }
      if (backward !== null) {
        scores.reverse = backward;
      }
      if (forward !== null && backward !== null) {
        scores.total = forward + backward;
      }
      byHour[hour] = scores;
    });
    if (!Object.keys(byHour).length) {
      continue;
    }
    byRoad[road.id] = {
      am: { ...byHour },
      pm: { ...byHour },
      neutral: { ...byHour }
    };
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
    denseCover: [],
    trees: [],
    signs: [],
    structure: createDefaultStructure(),
    autoRoads: [],
    autoBuildings: [],
    autoTrees: [],
    autoSigns: [],
    autoTrafficSignals: [],
    customRoads: [],
    trafficConfig,
    trafficView: createDefaultTrafficView(trafficConfig)
  };
}

function createDefaultStructure(): StructureParams {
  const legacyWidthFt = 60;
  const legacyLengthFt = 90;
  const widthM = legacyWidthFt * FEET_TO_METERS;
  const lengthM = legacyLengthFt * FEET_TO_METERS;
  return {
    version: 2,
    mode: "parametric",
    footprint: {
      points: buildRectFootprintPoints(widthM, lengthM)
    },
    heightMeters: 30 * FEET_TO_METERS,
    placeAtCenter: true,
    centerPx: { x: 0, y: 0 },
    rotationDeg: 0,
    legacyWidthFt,
    legacyLengthFt
  };
}

function createDefaultSettings(): AppSettings {
  return {
    siteHeightFt: 6,
    viewerHeightFt: 6,
    viewDistanceFt: 2000,
    topoSpacingFt: 25,
    sampleStepPx: 5,
    forestK: 0.04,
    denseCoverDensity: 0.6,
    frame: {
      maxSideFt: 2640,
      minSideFt: 300
    },
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
    hour: 12,
    detail: 3,
    showOverlay: true,
    showDirectionArrows: false,
    flowDensity: "medium",
    seed: 0,
    centralShare: 0.6
  };
}

function createDefaultTrafficView(config?: TrafficConfig): TrafficViewState {
  const preset = normalizeTrafficPreset(config?.preset ?? "neutral");
  return {
    preset,
    hour: clampTrafficHour(config?.hour ?? defaultTrafficHourForPreset(preset)),
    showDirection: config?.showDirectionArrows ?? false,
    flowDensity: normalizeTrafficFlowDensity(config?.flowDensity ?? "medium")
  };
}

function normalizeTrafficPreset(value: string): string {
  if (value === "am" || value === "pm" || value === "neutral") {
    return value;
  }
  return "neutral";
}

function defaultTrafficHourForPreset(preset: string): number {
  if (preset === "am") {
    return 8;
  }
  if (preset === "pm") {
    return 17;
  }
  return 12;
}

function normalizeTrafficFlowDensity(value: string): TrafficFlowDensity {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function clampTrafficHour(value: number): number {
  const hour = Math.floor(value);
  if (hour < TRAFFIC_HOUR_MIN) return TRAFFIC_HOUR_MIN;
  if (hour > TRAFFIC_HOUR_MAX) return TRAFFIC_HOUR_MAX;
  return hour;
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
    viewDistanceFt:
      readOptionalNumber(value.viewDistanceFt, warnings, "settings.viewDistanceFt") ??
      defaults.viewDistanceFt,
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
    forestK: readNumber(value.forestK, defaults.forestK, warnings, "settings.forestK"),
    denseCoverDensity: clampValue(
      readNumber(
        value.denseCoverDensity,
        defaults.denseCoverDensity,
        warnings,
        "settings.denseCoverDensity"
      ),
      0,
      1
    ),
    frame: readFrameSettings(value.frame, defaults.frame, warnings),
    overlays: readOverlaySettings(value.overlays, defaults.overlays, warnings),
    opacity: readOpacitySettings(value.opacity, defaults.opacity, warnings)
  };
}

function buildRectFootprintPoints(widthM: number, lengthM: number): { x: number; y: number }[] {
  const halfWidth = Math.max(0.1, widthM / 2);
  const halfLength = Math.max(0.1, lengthM / 2);
  return [
    { x: -halfWidth, y: -halfLength },
    { x: halfWidth, y: -halfLength },
    { x: halfWidth, y: halfLength },
    { x: -halfWidth, y: halfLength }
  ];
}

function readFootprintPoints(
  value: unknown,
  warnings: string[],
  path: string
): { x: number; y: number }[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`Invalid ${path}; expected array.`);
    return [];
  }
  const points: { x: number; y: number }[] = [];
  let invalid = false;
  value.forEach((entry) => {
    if (!isRecord(entry)) {
      invalid = true;
      return;
    }
    const x = entry.x;
    const y = entry.y;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      invalid = true;
      return;
    }
    points.push({ x, y });
  });
  if (invalid && points.length === 0) {
    warnings.push(`Invalid ${path}; using defaults.`);
  }
  return points;
}

function readOptionalPositiveNumber(
  value: unknown,
  warnings: string[],
  path: string
): number | undefined {
  const parsed = readOptionalNumber(value, warnings, path);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed > 0) {
    return parsed;
  }
  warnings.push(`Invalid ${path}; ignoring.`);
  return undefined;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readFacePriority(
  value: unknown,
  warnings: string[]
): StructureParamsV2["facePriority"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push("Invalid structure.facePriority; ignoring.");
    return undefined;
  }
  const primaryEdgeIndex = readOptionalNumber(
    value.primaryEdgeIndex,
    warnings,
    "structure.facePriority.primaryEdgeIndex"
  );
  const arcDeg = value.arcDeg;
  if (
    primaryEdgeIndex === undefined ||
    !Number.isFinite(primaryEdgeIndex) ||
    (arcDeg !== 180 && arcDeg !== 270)
  ) {
    warnings.push("Invalid structure.facePriority; ignoring.");
    return undefined;
  }
  return {
    primaryEdgeIndex: Math.max(0, Math.floor(primaryEdgeIndex)),
    arcDeg
  };
}

function readStructureMode(
  value: unknown,
  warnings: string[],
  fallback: StructureMode
): StructureMode {
  if (value === "parametric" || value === "imported") {
    return value;
  }
  if (value !== undefined) {
    warnings.push("Invalid structure.mode; using default.");
  }
  return fallback;
}

function readImportedModelRef(value: unknown, warnings: string[]): ImportedModelRef | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push("Invalid structure.imported; ignoring.");
    return undefined;
  }
  if (typeof value.assetId !== "string" || value.assetId.length === 0) {
    warnings.push("Invalid structure.imported.assetId; ignoring imported model.");
    return undefined;
  }
  const format = value.format;
  if (format !== "glb" && format !== "gltf" && format !== "obj" && format !== "stl") {
    warnings.push("Invalid structure.imported.format; ignoring imported model.");
    return undefined;
  }
  const scaleRaw = readOptionalNumber(value.scale, warnings, "structure.imported.scale");
  let scale = 1;
  if (scaleRaw !== undefined) {
    if (scaleRaw > 0) {
      scale = scaleRaw;
    } else {
      warnings.push("Invalid structure.imported.scale; using 1.");
    }
  }
  const rotationRaw = readOptionalNumber(value.rotationDeg, warnings, "structure.imported.rotationDeg");
  const rotationDeg = Number.isFinite(rotationRaw) ? (rotationRaw as number) : 0;
  const offsetValue = isRecord(value.offset) ? value.offset : {};
  const readOffsetAxis = (axisValue: unknown, path: string) => {
    if (axisValue === undefined || axisValue === null) {
      return 0;
    }
    if (isFiniteNumber(axisValue)) {
      return axisValue;
    }
    warnings.push(`Invalid ${path}; using 0.`);
    return 0;
  };
  const offset = {
    x: readOffsetAxis(offsetValue.x, "structure.imported.offset.x"),
    y: readOffsetAxis(offsetValue.y, "structure.imported.offset.y"),
    z: readOffsetAxis(offsetValue.z, "structure.imported.offset.z")
  };
  const proxyValue = isRecord(value.footprintProxy) ? value.footprintProxy : null;
  const proxyPoints = readFootprintPoints(
    proxyValue?.points,
    warnings,
    "structure.imported.footprintProxy.points"
  );
  if (proxyPoints.length > 0 && proxyPoints.length < 3) {
    warnings.push("Invalid structure.imported.footprintProxy; ignoring.");
  }
  const footprintProxy = proxyPoints.length >= 3 ? { points: proxyPoints } : undefined;
  return {
    assetId: value.assetId,
    name: typeof value.name === "string" ? value.name : value.assetId,
    format,
    scale,
    rotationDeg,
    offset,
    footprintProxy
  };
}

function isStructureV2Payload(value: Record<string, unknown>): boolean {
  if (value.version === 2 || value.mode === "parametric" || value.mode === "imported") {
    return true;
  }
  const footprint = isRecord(value.footprint) ? value.footprint : null;
  if (footprint && Array.isArray(footprint.points)) {
    return true;
  }
  if (isRecord(value.imported)) {
    return true;
  }
  if (isFiniteNumber(value.heightMeters)) {
    return true;
  }
  return false;
}

function readStructureV2(
  value: Record<string, unknown>,
  warnings: string[],
  defaults: StructureParamsV2
): StructureParamsV2 {
  const footprint = isRecord(value.footprint) ? value.footprint : {};
  const center = isRecord(value.centerPx) ? value.centerPx : {};
  const points = readFootprintPoints(footprint.points, warnings, "structure.footprint.points");
  const normalizedPoints =
    points.length >= 3 ? points : defaults.footprint.points.map((point) => ({ ...point }));
  const mode = readStructureMode(value.mode, warnings, defaults.mode);
  const imported = readImportedModelRef(value.imported, warnings);
  return {
    version: 2,
    mode,
    footprint: {
      points: normalizedPoints
    },
    heightMeters: Math.max(
      1,
      readNumber(value.heightMeters, defaults.heightMeters, warnings, "structure.heightMeters")
    ),
    placeAtCenter: readBoolean(
      value.placeAtCenter,
      defaults.placeAtCenter,
      warnings,
      "structure.placeAtCenter"
    ),
    centerPx: {
      x: readNumber(center.x, defaults.centerPx.x, warnings, "structure.centerPx.x"),
      y: readNumber(center.y, defaults.centerPx.y, warnings, "structure.centerPx.y")
    },
    rotationDeg: readNumber(
      value.rotationDeg,
      defaults.rotationDeg,
      warnings,
      "structure.rotationDeg"
    ),
    facePriority: readFacePriority(value.facePriority, warnings),
    legacyWidthFt: readOptionalPositiveNumber(
      value.legacyWidthFt,
      warnings,
      "structure.legacyWidthFt"
    ),
    legacyLengthFt: readOptionalPositiveNumber(
      value.legacyLengthFt,
      warnings,
      "structure.legacyLengthFt"
    ),
    imported
  };
}

function migrateStructureV1(
  value: Record<string, unknown>,
  warnings: string[],
  defaults: StructureParamsV2
): StructureParamsV2 {
  const fallbackWidthFt = defaults.legacyWidthFt ?? 60;
  const fallbackLengthFt = defaults.legacyLengthFt ?? 90;
  const fallbackHeightFt = defaults.heightMeters / FEET_TO_METERS;
  const footprint = isRecord(value.footprint) ? value.footprint : {};
  const center = isRecord(value.centerPx) ? value.centerPx : {};
  const widthFt = Math.max(
    1,
    readNumber(footprint.widthFt, fallbackWidthFt, warnings, "structure.footprint.widthFt")
  );
  const lengthFt = Math.max(
    1,
    readNumber(footprint.lengthFt, fallbackLengthFt, warnings, "structure.footprint.lengthFt")
  );
  const heightFt = Math.max(
    1,
    readNumber(value.heightFt, fallbackHeightFt, warnings, "structure.heightFt")
  );
  return {
    version: 2,
    mode: "parametric",
    footprint: {
      points: buildRectFootprintPoints(widthFt * FEET_TO_METERS, lengthFt * FEET_TO_METERS)
    },
    heightMeters: heightFt * FEET_TO_METERS,
    placeAtCenter: readBoolean(
      value.placeAtCenter,
      defaults.placeAtCenter,
      warnings,
      "structure.placeAtCenter"
    ),
    centerPx: {
      x: readNumber(center.x, defaults.centerPx.x, warnings, "structure.centerPx.x"),
      y: readNumber(center.y, defaults.centerPx.y, warnings, "structure.centerPx.y")
    },
    rotationDeg: readNumber(
      value.rotationDeg,
      defaults.rotationDeg,
      warnings,
      "structure.rotationDeg"
    ),
    legacyWidthFt: widthFt,
    legacyLengthFt: lengthFt
  };
}

function readStructure(value: unknown, warnings: string[]): StructureParams {
  const defaults = createDefaultStructure();
  if (!isRecord(value)) {
    if (value !== undefined) {
      warnings.push("Invalid structure; using defaults.");
    }
    return defaults;
  }
  if (isStructureV2Payload(value)) {
    return readStructureV2(value, warnings, defaults);
  }
  return migrateStructureV1(value, warnings, defaults);
}

function readFrameSettings(
  value: unknown,
  defaults: AppSettings["frame"],
  warnings: string[]
): AppSettings["frame"] {
  if (!isRecord(value)) {
    if (value !== undefined) {
      warnings.push("Invalid settings.frame; using defaults.");
    }
    return { ...defaults };
  }
  return {
    maxSideFt: readNumber(
      value.maxSideFt,
      defaults.maxSideFt,
      warnings,
      "settings.frame.maxSideFt"
    ),
    minSideFt: readNumber(
      value.minSideFt,
      defaults.minSideFt,
      warnings,
      "settings.frame.minSideFt"
    )
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
  const nameCounts: Record<ZoneType, number> = {
    obstacle: 0,
    candidate: 0,
    viewer: 0
  };
  rawShapes.forEach((raw, index) => {
    const shape = readShape(raw, warnings, `shapes[${index}]`, index, nameCounts);
    if (shape) {
      shapes.push(shape);
    }
  });
  return shapes;
}

function readDenseCover(value: unknown, warnings: string[], path: string): DenseCover[] {
  const raw = readArray(value, warnings, path, true);
  const denseCover: DenseCover[] = [];
  raw.forEach((entry, index) => {
    const parsed = readDenseCoverItem(entry, warnings, `${path}[${index}]`, index);
    if (parsed) {
      denseCover.push(parsed);
    }
  });
  return denseCover;
}

function readDenseCoverItem(
  value: unknown,
  warnings: string[],
  path: string,
  index: number
): DenseCover | null {
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; expected record.`);
    return null;
  }
  const id = readString(value.id, `dense-${index}`, warnings, `${path}.id`);
  const density = clampValue(
    readNumber(value.density, 0.6, warnings, `${path}.density`),
    0,
    1
  );
  const polygon = readDenseCoverPolygon(value.polygonLatLon, warnings, `${path}.polygonLatLon`);
  if (!polygon || polygon.length < 3) {
    warnings.push(`Invalid ${path}.polygonLatLon; skipping dense cover.`);
    return null;
  }
  return {
    id,
    polygonLatLon: polygon,
    density,
    mode: "dense_cover"
  };
}

function readDenseCoverPolygon(
  value: unknown,
  warnings: string[],
  path: string
): GeoPoint[] | null {
  if (!Array.isArray(value)) {
    warnings.push(`Invalid ${path}; expected array.`);
    return null;
  }
  const points: GeoPoint[] = [];
  value.forEach((entry) => {
    if (!isRecord(entry)) {
      return;
    }
    const lat = readNumber(entry.lat, Number.NaN, warnings, `${path}.lat`);
    const lon = readNumber(entry.lon, Number.NaN, warnings, `${path}.lon`);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push({ lat, lon });
    }
  });
  return points.length >= 3 ? points : null;
}

function readShape(
  value: unknown,
  warnings: string[],
  path: string,
  index: number,
  nameCounts: Record<ZoneType, number>
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
  const nameCount = (nameCounts[type] ?? 0) + 1;
  nameCounts[type] = nameCount;
  const name = normalizeShapeName(
    readOptionalString(value.name, warnings, `${path}.name`),
    defaultShapeName(type, nameCount)
  );
  const color = normalizeShapeColor(readOptionalString(value.color, warnings, `${path}.color`));
  const visible = readBoolean(value.visible, true, warnings, `${path}.visible`);
  const direction = readViewerDirection(value.direction, warnings, `${path}.direction`);
  const viewerAnchor = readPixelPoint(value.viewerAnchor, warnings, `${path}.viewerAnchor`);

  if (kind === "polygon") {
    const points = readPixelPoints(value.points, warnings, `${path}.points`);
    if (points.length < 3) {
      warnings.push(`Invalid ${path}.points; expected at least 3 points.`);
      return null;
    }
    const shape: Shape = { id, name, kind, type, alpha, color, visible, points };
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
  const shape: Shape = { id, name, kind, type, alpha, color, visible, x, y, width, height };
  if (direction) {
    shape.direction = direction;
  }
  if (viewerAnchor && type === "viewer") {
    shape.viewerAnchor = viewerAnchor;
  }
  return shape;
}

function readZoneType(value: unknown, warnings: string[], path: string): ZoneType {
  if (value === "obstacle" || value === "candidate" || value === "viewer") {
    return value;
  }
  warnings.push(`Invalid ${path}; defaulting to obstacle.`);
  return "obstacle";
}

function defaultShapeName(type: ZoneType, index: number): string {
  const label =
    type === "candidate" ? "Candidate" : type === "viewer" ? "Viewer" : "Obstacle";
  return `${label} ${index}`;
}

function normalizeShapeName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed;
}

function normalizeShapeColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
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
  const inferredHeightMeters = normalizeOptionalPositive(
    readOptionalNumber(value.inferredHeightMeters, warnings, `${path}.inferredHeightMeters`)
  );
  const heightSource = readOptionalString(value.heightSource, warnings, `${path}.heightSource`);
  const confidence = normalizeConfidence(
    readOptionalNumber(value.confidence, warnings, `${path}.confidence`)
  );
  const userOverrideMeters =
    normalizeOptionalPositive(
      readOptionalNumber(value.userOverrideMeters, warnings, `${path}.userOverrideMeters`)
    ) ??
    normalizeOptionalPositive(
      readOptionalNumber(value.userHeightMeters, warnings, `${path}.userHeightMeters`)
    );
  const effectiveHeightMeters = normalizeOptionalPositive(
    readOptionalNumber(value.effectiveHeightMeters, warnings, `${path}.effectiveHeightMeters`)
  );
  const tags = mergeTags(
    readTags(value.tags, warnings, `${path}.tags`),
    readOptionalString(value.name, warnings, `${path}.name`)
  );
  const building: Building = { id, footprint };
  const resolvedHeight = height ?? heightM;
  if (resolvedHeight !== undefined) {
    building.height = resolvedHeight;
  }
  if (inferredHeightMeters !== undefined) {
    building.inferredHeightMeters = inferredHeightMeters;
  }
  if (heightSource !== undefined) {
    building.heightSource = heightSource;
  }
  if (confidence !== undefined) {
    building.confidence = confidence;
  }
  if (userOverrideMeters !== undefined) {
    building.userOverrideMeters = userOverrideMeters;
  }
  if (effectiveHeightMeters !== undefined) {
    building.effectiveHeightMeters = effectiveHeightMeters;
  } else if (inferredHeightMeters !== undefined) {
    building.effectiveHeightMeters = userOverrideMeters ?? inferredHeightMeters;
  }
  if (tags) {
    building.tags = tags;
  }
  return building;
}

function readTrees(value: unknown, warnings: string[], path: string): Tree[] {
  const raw = readArray(value, warnings, path);
  const trees: Tree[] = [];
  raw.forEach((entry, index) => {
    const tree = readTree(entry, warnings, `${path}[${index}]`, `${path}-${index}`);
    if (tree) {
      trees.push(tree);
    }
  });
  return trees;
}

function readTree(
  value: unknown,
  warnings: string[],
  path: string,
  fallbackId: string
): Tree | null {
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; skipping.`);
    return null;
  }
  const id = readString(value.id, fallbackId, warnings, `${path}.id`);
  const location = readPointLocation(value, warnings, `${path}.location`);
  if (!location) {
    return null;
  }
  const type = normalizeTreeType(value.type) ?? DEFAULT_TREE_TYPE;
  const baseRadiusInput = readOptionalNumber(
    value.baseRadiusMeters ?? value.radiusMeters,
    warnings,
    `${path}.baseRadiusMeters`
  );
  const baseRadiusMeters = normalizePositiveNumber(
    baseRadiusInput,
    DEFAULT_TREE_RADIUS_METERS
  );
  let heightSource = normalizeTreeHeightSource(value.heightSource) ?? DEFAULT_TREE_HEIGHT_SOURCE;
  const heightInput = readOptionalNumber(value.heightMeters, warnings, `${path}.heightMeters`);
  const derivedHeight = deriveTreeHeightMeters(baseRadiusMeters);
  let heightMeters = derivedHeight;
  if (heightSource !== "derived") {
    if (!Number.isFinite(heightInput) || (heightInput as number) <= 0) {
      heightSource = "derived";
    } else {
      heightMeters = heightInput as number;
    }
  }
  return {
    id,
    location,
    type,
    baseRadiusMeters,
    heightMeters,
    heightSource
  };
}

function readSigns(value: unknown, warnings: string[], path: string): Sign[] {
  const raw = readArray(value, warnings, path);
  const signs: Sign[] = [];
  raw.forEach((entry, index) => {
    const sign = readSign(entry, warnings, `${path}[${index}]`, `${path}-${index}`);
    if (sign) {
      signs.push(sign);
    }
  });
  return signs;
}

function readSign(
  value: unknown,
  warnings: string[],
  path: string,
  fallbackId: string
): Sign | null {
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; skipping.`);
    return null;
  }
  const id = readString(value.id, fallbackId, warnings, `${path}.id`);
  const location = readPointLocation(value, warnings, `${path}.location`);
  if (!location) {
    return null;
  }
  const kind = normalizeSignKind(value.kind) ?? DEFAULT_SIGN_KIND;
  const defaults = DEFAULT_SIGN_DIMENSIONS[kind];
  const widthMeters = normalizePositiveNumber(
    readOptionalNumber(value.widthMeters, warnings, `${path}.widthMeters`),
    defaults.widthMeters
  );
  const heightInput = readOptionalNumber(value.heightMeters, warnings, `${path}.heightMeters`);
  const heightMeters = normalizePositiveNumber(heightInput, defaults.heightMeters);
  const bottomClearanceMeters = normalizeNonNegativeNumber(
    readOptionalNumber(
      value.bottomClearanceMeters,
      warnings,
      `${path}.bottomClearanceMeters`
    ),
    defaults.bottomClearanceMeters
  );
  const yawDegrees = normalizeNumber(
    readOptionalNumber(value.yawDegrees ?? value.orientationDeg, warnings, `${path}.yawDegrees`),
    DEFAULT_SIGN_YAW_DEGREES
  );
  let heightSource =
    normalizeSignHeightSource(value.heightSource) ?? DEFAULT_SIGN_HEIGHT_SOURCE;
  if (heightSource !== "default" && (!Number.isFinite(heightInput) || (heightInput as number) <= 0)) {
    heightSource = "default";
  }
  return {
    id,
    location,
    kind,
    widthMeters,
    heightMeters,
    bottomClearanceMeters,
    yawDegrees,
    heightSource
  };
}

function readTrafficSignals(
  value: unknown,
  warnings: string[],
  path: string
): TrafficSignal[] {
  const raw = readArray(value, warnings, path);
  const signals: TrafficSignal[] = [];
  raw.forEach((entry, index) => {
    const signal = readTrafficSignal(
      entry,
      warnings,
      `${path}[${index}]`,
      `${path}-${index}`
    );
    if (signal) {
      signals.push(signal);
    }
  });
  return signals;
}

function readTrafficSignal(
  value: unknown,
  warnings: string[],
  path: string,
  fallbackId: string
): TrafficSignal | null {
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; skipping.`);
    return null;
  }
  const id = readString(value.id, fallbackId, warnings, `${path}.id`);
  const location = readPointLocation(value, warnings, `${path}.location`);
  if (!location) {
    return null;
  }
  return { id, location };
}

function readPointLocation(
  value: unknown,
  warnings: string[],
  path: string
): MapPoint | null {
  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}; expected object.`);
    return null;
  }
  const locationCandidate = isRecord(value.location) ? value.location : value;
  const location = parseMapPoint(locationCandidate);
  if (!location) {
    warnings.push(`Invalid ${path}; expected lat/lon or x/y.`);
    return null;
  }
  return location;
}

function normalizeTreeType(value: unknown): Tree["type"] | null {
  if (value === "pine" || value === "deciduous") {
    return value;
  }
  return null;
}

function normalizeTreeHeightSource(value: unknown): Tree["heightSource"] | null {
  if (value === "derived" || value === "user_override" || value === "ml" || value === "osm") {
    return value;
  }
  return null;
}

function normalizeSignKind(value: unknown): Sign["kind"] | null {
  if (value === "billboard" || value === "sign") {
    return value;
  }
  return null;
}

function normalizeSignHeightSource(value: unknown): Sign["heightSource"] | null {
  if (value === "default" || value === "user_override" || value === "osm" || value === "ml") {
    return value;
  }
  return null;
}

function normalizeOptionalPositive(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return undefined;
  }
  return value as number;
}

function normalizeConfidence(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const numeric = value as number;
  if (numeric < 0 || numeric > 1) {
    return undefined;
  }
  return numeric;
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return fallback;
  }
  return value as number;
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value as number) < 0) {
    return fallback;
  }
  return value as number;
}

function normalizeNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value as number;
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
  const preset = normalizeTrafficPreset(
    readString(value.preset, defaults.preset, warnings, "trafficConfig.preset")
  );
  const defaultHour = defaultTrafficHourForPreset(preset);
  const hour = clampTrafficHour(readNumber(value.hour, defaultHour, warnings, "trafficConfig.hour"));
  const directionDefault = preset === "am" || preset === "pm";
  const centralShareRaw = readNumber(
    value.centralShare,
    defaults.centralShare,
    warnings,
    "trafficConfig.centralShare"
  );
  const centralShare = Math.min(1, Math.max(0, centralShareRaw));
  return {
    preset,
    hour,
    detail: readNumber(value.detail, defaults.detail, warnings, "trafficConfig.detail"),
    showOverlay: readBoolean(
      value.showOverlay,
      defaults.showOverlay,
      warnings,
      "trafficConfig.showOverlay"
    ),
    showDirectionArrows: readBoolean(
      value.showDirectionArrows,
      directionDefault,
      warnings,
      "trafficConfig.showDirectionArrows"
    ),
    flowDensity: normalizeTrafficFlowDensity(
      readString(value.flowDensity, defaults.flowDensity, warnings, "trafficConfig.flowDensity")
    ),
    seed: readNumber(value.seed, defaults.seed, warnings, "trafficConfig.seed"),
    centralShare
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
  const preset = normalizeTrafficPreset(
    readString(value.preset, defaults.preset, warnings, "trafficView.preset")
  );
  const defaultHour = defaultTrafficHourForPreset(preset);
  const hour = clampTrafficHour(readNumber(value.hour, defaultHour, warnings, "trafficView.hour"));
  return {
    preset,
    hour,
    showDirection: readBoolean(
      value.showDirection,
      defaults.showDirection,
      warnings,
      "trafficView.showDirection"
    ),
    flowDensity: normalizeTrafficFlowDensity(
      readString(value.flowDensity, defaults.flowDensity, warnings, "trafficView.flowDensity")
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
