import type { SignHeightSource, SignKind, TreeHeightSource, TreeType } from "./types";

const FEET_TO_METERS = 0.3048;
const TREE_MIN_HEIGHT_FT = 10;
const TREE_MAX_HEIGHT_FT = 20;
const TREE_BASE_HEIGHT_FT = 10;
const TREE_HEIGHT_PER_FT = 5;
const TREE_RADIUS_BASE_FT = 0.5;

export const DEFAULT_TREE_RADIUS_METERS = 0.6;
export const DEFAULT_TREE_TYPE: TreeType = "deciduous";
export const DEFAULT_TREE_HEIGHT_SOURCE: TreeHeightSource = "derived";

export const DEFAULT_SIGN_KIND: SignKind = "sign";
export const DEFAULT_SIGN_HEIGHT_SOURCE: SignHeightSource = "default";
export const DEFAULT_SIGN_YAW_DEGREES = 0;

export const DEFAULT_SIGN_DIMENSIONS: Record<
  SignKind,
  { widthMeters: number; heightMeters: number; bottomClearanceMeters: number }
> = {
  sign: { widthMeters: 1.8, heightMeters: 1.2, bottomClearanceMeters: 2 },
  billboard: { widthMeters: 4.5, heightMeters: 2.4, bottomClearanceMeters: 2.5 }
};

export function deriveTreeHeightMeters(radiusMeters: number): number {
  const safeRadius = Number.isFinite(radiusMeters) ? Math.max(0, radiusMeters) : 0;
  const radiusFt = safeRadius / FEET_TO_METERS;
  const heightFt = clamp(
    TREE_BASE_HEIGHT_FT + (radiusFt - TREE_RADIUS_BASE_FT) * TREE_HEIGHT_PER_FT,
    TREE_MIN_HEIGHT_FT,
    TREE_MAX_HEIGHT_FT
  );
  return heightFt * FEET_TO_METERS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
