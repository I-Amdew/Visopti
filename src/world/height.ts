import type { Building } from "../types";
import { DEFAULT_BUILDING_HEIGHTS, type BuildingHeightDefaults } from "./settings";

export type BuildingHeightSource = "osm_height" | "osm_levels" | "default" | "user_override";

export interface BuildingHeightInfo {
  inferredHeightMeters: number;
  inferredHeightSource: Exclude<BuildingHeightSource, "user_override">;
  minHeightMeters?: number;
  userHeightMeters?: number;
  heightSource: BuildingHeightSource;
  effectiveHeightMeters: number;
}

export function inferBuildingHeightInfo(
  building: Pick<Building, "height" | "tags" | "userHeightMeters">,
  overrides?: Partial<BuildingHeightDefaults>
): BuildingHeightInfo {
  const defaults = { ...DEFAULT_BUILDING_HEIGHTS, ...overrides };
  const tags = building.tags;
  const minHeightMeters = parseHeightValue(tags?.min_height);

  let inferredHeightMeters =
    defaults.defaultBuildingLevels * defaults.defaultFloorHeightMeters;
  let inferredHeightSource: BuildingHeightInfo["inferredHeightSource"] = "default";

  const tagHeightMeters = parseHeightValue(tags?.height);
  if (tagHeightMeters !== null) {
    inferredHeightMeters = tagHeightMeters;
    inferredHeightSource = "osm_height";
  } else {
    const levels = parseLevels(tags?.["building:levels"]);
    if (levels !== null) {
      inferredHeightMeters = levels * defaults.defaultFloorHeightMeters;
      inferredHeightSource = "osm_levels";
    } else if (Number.isFinite(building.height) && (building.height as number) > 0) {
      inferredHeightMeters = building.height as number;
      inferredHeightSource = "osm_height";
    }
  }

  const userHeightMeters = normalizePositive(building.userHeightMeters);
  const effectiveHeightMeters = userHeightMeters ?? inferredHeightMeters;
  const heightSource: BuildingHeightSource = userHeightMeters ? "user_override" : inferredHeightSource;

  return {
    inferredHeightMeters,
    inferredHeightSource,
    minHeightMeters: minHeightMeters ?? undefined,
    userHeightMeters: userHeightMeters ?? undefined,
    heightSource,
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
