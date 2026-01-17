import type { Building, BuildingHeightSource, GeoBounds } from "../types";
import { DEFAULT_BUILDING_HEIGHTS, type BuildingHeightDefaults } from "./settings";

export interface BuildingHeightEstimate {
  heightMeters: number;
  confidence: number;
  source: BuildingHeightSource;
  minHeightMeters?: number;
}

export interface BuildingHeightProviderContext {
  bounds?: GeoBounds | null;
  signal?: AbortSignal;
}

export interface BuildingHeightProvider {
  getHeights(
    buildings: Building[],
    context: BuildingHeightProviderContext
  ): Promise<Map<string, BuildingHeightEstimate>>;
}

export interface BuildingHeightInfo {
  inferredHeightMeters: number;
  heightSource: BuildingHeightSource;
  confidence: number;
  minHeightMeters?: number;
  userOverrideMeters?: number;
  effectiveHeightMeters: number;
}

const DEFAULT_CONFIDENCE: Record<BuildingHeightSource, number> = {
  osm_height: 0.9,
  osm_levels: 0.6,
  default: 0.2,
  external_api: 0.8
};

export class OsmHeightProvider implements BuildingHeightProvider {
  constructor(private defaults?: Partial<BuildingHeightDefaults>) {}

  async getHeights(
    buildings: Building[],
    _context: BuildingHeightProviderContext
  ): Promise<Map<string, BuildingHeightEstimate>> {
    const heights = new Map<string, BuildingHeightEstimate>();
    const defaults = { ...DEFAULT_BUILDING_HEIGHTS, ...this.defaults };
    for (const building of buildings) {
      const estimate = inferOsmHeight(building, defaults);
      heights.set(building.id, estimate);
    }
    return heights;
  }
}

export class ExternalHeightProvider implements BuildingHeightProvider {
  constructor(private apiUrl: string) {}

  async getHeights(
    buildings: Building[],
    context: BuildingHeightProviderContext
  ): Promise<Map<string, BuildingHeightEstimate>> {
    if (!this.apiUrl || buildings.length === 0) {
      return new Map();
    }
    const payload = {
      bounds: context.bounds ?? null,
      buildingIds: buildings.map((building) => building.id)
    };
    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: context.signal
    });
    if (!response.ok) {
      throw new Error(`Height API returned ${response.status}`);
    }
    const data = (await response.json()) as unknown;
    return parseExternalHeightResponse(data);
  }
}

export function getExternalHeightApiUrl(): string | null {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const raw = env?.VITE_BUILDING_HEIGHT_API_URL ?? env?.VITE_BUILDING_HEIGHT_API;
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export function getDefaultBuildingHeightProviders(
  defaults?: Partial<BuildingHeightDefaults>
): BuildingHeightProvider[] {
  const providers: BuildingHeightProvider[] = [];
  const apiUrl = getExternalHeightApiUrl();
  if (apiUrl) {
    providers.push(new ExternalHeightProvider(apiUrl));
  }
  providers.push(new OsmHeightProvider(defaults));
  return providers;
}

export async function resolveBuildingHeights(
  buildings: Building[],
  context: BuildingHeightProviderContext,
  providers: BuildingHeightProvider[]
): Promise<Map<string, BuildingHeightEstimate>> {
  const remaining = new Set(buildings.map((building) => building.id));
  const results = new Map<string, BuildingHeightEstimate>();
  for (const provider of providers) {
    if (remaining.size === 0) {
      break;
    }
    const targets = buildings.filter((building) => remaining.has(building.id));
    try {
      const heights = await provider.getHeights(targets, context);
      heights.forEach((estimate, id) => {
        if (!remaining.has(id) || !Number.isFinite(estimate.heightMeters)) {
          return;
        }
        if (estimate.heightMeters <= 0) {
          return;
        }
        results.set(id, estimate);
        remaining.delete(id);
      });
    } catch (err) {
      console.warn("Building height provider failed.", err);
    }
  }
  return results;
}

export function applyBuildingHeightEstimates(
  buildings: Building[],
  estimates: Map<string, BuildingHeightEstimate>,
  overrides?: Partial<BuildingHeightDefaults>
): Building[] {
  const defaults = { ...DEFAULT_BUILDING_HEIGHTS, ...overrides };
  return buildings.map((building) => {
    const estimate = estimates.get(building.id) ?? inferOsmHeight(building, defaults);
    return mergeHeightEstimate(building, estimate);
  });
}

export function resolveBuildingHeightInfo(
  building: Pick<
    Building,
    | "height"
    | "tags"
    | "inferredHeightMeters"
    | "heightSource"
    | "confidence"
    | "userOverrideMeters"
  >,
  overrides?: Partial<BuildingHeightDefaults>
): BuildingHeightInfo {
  const defaults = { ...DEFAULT_BUILDING_HEIGHTS, ...overrides };
  const fallback = inferOsmHeight(building, defaults);
  const inferredHeightMeters = normalizePositive(building.inferredHeightMeters) ?? fallback.heightMeters;
  const heightSource = building.heightSource ?? fallback.source;
  const confidence = normalizeConfidence(building.confidence) ?? fallback.confidence;
  const userOverrideMeters = normalizePositive(building.userOverrideMeters);
  const effectiveHeightMeters = userOverrideMeters ?? inferredHeightMeters;

  return {
    inferredHeightMeters,
    heightSource,
    confidence,
    minHeightMeters: fallback.minHeightMeters ?? undefined,
    userOverrideMeters: userOverrideMeters ?? undefined,
    effectiveHeightMeters
  };
}

export function parseHeightValue(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/-?\d+(\.\d+)?/);
  if (!match) {
    return null;
  }
  const numeric = Number.parseFloat(match[0]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  if (normalized.includes("ft") || normalized.includes("feet") || normalized.includes("foot")) {
    return numeric * 0.3048;
  }
  if (normalized.includes("cm")) {
    return numeric / 100;
  }
  if (normalized.includes("mm")) {
    return numeric / 1000;
  }
  return numeric;
}

function parseLevels(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePositive(value: number | null | undefined): number | null {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return null;
  }
  return value as number;
}

function normalizeConfidence(value: unknown): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const numeric = value as number;
  if (numeric < 0 || numeric > 1) {
    return null;
  }
  return numeric;
}

function inferOsmHeight(
  building: Pick<Building, "height" | "tags">,
  defaults: BuildingHeightDefaults
): BuildingHeightEstimate {
  const tags = building.tags;
  const minHeightMeters = parseHeightValue(tags?.min_height);

  let heightMeters = defaults.defaultBuildingLevels * defaults.defaultFloorHeightMeters;
  let source: BuildingHeightSource = "default";
  let confidence = DEFAULT_CONFIDENCE.default;

  const tagHeightMeters = parseHeightValue(tags?.height);
  if (tagHeightMeters !== null) {
    heightMeters = tagHeightMeters;
    source = "osm_height";
    confidence = DEFAULT_CONFIDENCE.osm_height;
  } else {
    const levels = parseLevels(tags?.["building:levels"]);
    if (levels !== null) {
      heightMeters = levels * defaults.defaultFloorHeightMeters;
      source = "osm_levels";
      confidence = DEFAULT_CONFIDENCE.osm_levels;
    } else if (Number.isFinite(building.height) && (building.height as number) > 0) {
      heightMeters = building.height as number;
      source = "osm_height";
      confidence = DEFAULT_CONFIDENCE.osm_height;
    }
  }

  return {
    heightMeters,
    confidence,
    source,
    minHeightMeters: minHeightMeters ?? undefined
  };
}

function mergeHeightEstimate(building: Building, estimate: BuildingHeightEstimate): Building {
  const userOverrideMeters = normalizePositive(building.userOverrideMeters) ?? undefined;
  const effectiveHeightMeters = userOverrideMeters ?? estimate.heightMeters;
  return {
    ...building,
    inferredHeightMeters: estimate.heightMeters,
    heightSource: estimate.source,
    confidence: estimate.confidence,
    userOverrideMeters,
    effectiveHeightMeters
  };
}

function parseExternalHeightResponse(data: unknown): Map<string, BuildingHeightEstimate> {
  const heights = new Map<string, BuildingHeightEstimate>();
  const entries = normalizeExternalEntries(data);
  if (!entries) {
    return heights;
  }
  for (const entry of entries) {
    const id = typeof entry.id === "string" ? entry.id : null;
    if (!id) {
      continue;
    }
    const heightMeters = Number(entry.heightMeters);
    if (!Number.isFinite(heightMeters) || heightMeters <= 0) {
      continue;
    }
    const confidence = normalizeConfidence(entry.confidence) ?? DEFAULT_CONFIDENCE.external_api;
    const source: BuildingHeightSource =
      entry.source === "osm_height" ||
      entry.source === "osm_levels" ||
      entry.source === "default" ||
      entry.source === "external_api"
        ? (entry.source as BuildingHeightSource)
        : "external_api";
    heights.set(id, { heightMeters, confidence, source });
  }
  return heights;
}

function normalizeExternalEntries(
  data: unknown
): Array<{ id: unknown; heightMeters?: unknown; confidence?: unknown; source?: unknown }> | null {
  if (Array.isArray(data)) {
    return data as Array<{ id: unknown; heightMeters?: unknown; confidence?: unknown; source?: unknown }>;
  }
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.heights)) {
    return record.heights as Array<{
      id: unknown;
      heightMeters?: unknown;
      confidence?: unknown;
      source?: unknown;
    }>;
  }
  if (record.heights && typeof record.heights === "object") {
    return Object.entries(record.heights as Record<string, unknown>).map(([id, value]) => {
      if (value && typeof value === "object") {
        return { id, ...(value as Record<string, unknown>) };
      }
      return { id, heightMeters: value };
    });
  }
  return null;
}
