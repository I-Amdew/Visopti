import type { GeoBounds, GeoPoint } from "./types";

export type FrameCorner = "ne" | "nw" | "se" | "sw";

const METERS_PER_DEG_LAT = 111_320;
const MIN_METERS_PER_DEG_LON = 1e-6;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export function insetBounds(bounds: GeoBounds, insetPct: number): GeoBounds {
  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;
  const insetLat = latSpan * insetPct;
  const insetLon = lonSpan * insetPct;
  return normalizeBounds({
    north: bounds.north - insetLat,
    south: bounds.south + insetLat,
    east: bounds.east - insetLon,
    west: bounds.west + insetLon
  });
}

export function boundsCenter(bounds: GeoBounds): GeoPoint {
  return {
    lat: (bounds.north + bounds.south) / 2,
    lon: (bounds.east + bounds.west) / 2
  };
}

export function boundsSizeMeters(bounds: GeoBounds): { widthM: number; heightM: number } {
  const latMid = (bounds.north + bounds.south) / 2;
  const widthM = Math.abs(bounds.east - bounds.west) * metersPerDegreeLon(latMid);
  const heightM = Math.abs(bounds.north - bounds.south) * METERS_PER_DEG_LAT;
  return { widthM, heightM };
}

export function expandBoundsByMeters(bounds: GeoBounds, bufferMeters: number): GeoBounds {
  const center = boundsCenter(bounds);
  const deltaLat = bufferMeters / METERS_PER_DEG_LAT;
  const deltaLon = bufferMeters / metersPerDegreeLon(center.lat);
  return normalizeBounds({
    north: clamp(center.lat + deltaLat, -85, 85),
    south: clamp(center.lat - deltaLat, -85, 85),
    east: clamp(center.lon + deltaLon, -180, 180),
    west: clamp(center.lon - deltaLon, -180, 180)
  });
}

export function clampBoundsToMaxSquare(
  bounds: GeoBounds,
  center: GeoPoint,
  maxSideM: number
): { bounds: GeoBounds; clamped: boolean } {
  const { widthM, heightM } = boundsSizeMeters(bounds);
  if (widthM <= maxSideM && heightM <= maxSideM) {
    return { bounds, clamped: false };
  }
  const halfSideM = maxSideM / 2;
  const deltaLat = halfSideM / METERS_PER_DEG_LAT;
  const deltaLon = halfSideM / metersPerDegreeLon(center.lat);
  return {
    bounds: normalizeBounds({
      north: center.lat + deltaLat,
      south: center.lat - deltaLat,
      east: center.lon + deltaLon,
      west: center.lon - deltaLon
    }),
    clamped: true
  };
}

export function clampBoundsToCorner(
  anchor: GeoPoint,
  corner: FrameCorner,
  moving: GeoPoint,
  minSideM: number,
  maxSideM: number
): GeoBounds {
  const minSide = Math.max(0, Math.min(minSideM, maxSideM));
  const maxSide = Math.max(minSide, maxSideM);
  const latSign = corner.includes("n") ? 1 : -1;
  const lonSign = corner.includes("e") ? 1 : -1;
  const latDeltaDeg = Math.abs(moving.lat - anchor.lat);
  const lonDeltaDeg = Math.abs(moving.lon - anchor.lon);
  const centerLat = anchor.lat + (latSign * latDeltaDeg) / 2;
  const metersPerLon = metersPerDegreeLon(centerLat);
  const clampedLatM = clamp(latDeltaDeg * METERS_PER_DEG_LAT, minSide, maxSide);
  const clampedLonM = clamp(lonDeltaDeg * metersPerLon, minSide, maxSide);
  const newLat = anchor.lat + latSign * (clampedLatM / METERS_PER_DEG_LAT);
  const newLon = anchor.lon + lonSign * (clampedLonM / metersPerLon);
  return normalizeBounds({
    north: Math.max(anchor.lat, newLat),
    south: Math.min(anchor.lat, newLat),
    east: Math.max(anchor.lon, newLon),
    west: Math.min(anchor.lon, newLon)
  });
}

export function metersPerDegreeLon(lat: number): number {
  return Math.max(MIN_METERS_PER_DEG_LON, METERS_PER_DEG_LAT * Math.cos(toRad(lat)));
}

function normalizeBounds(bounds: GeoBounds): GeoBounds {
  const north = Math.max(bounds.north, bounds.south);
  const south = Math.min(bounds.north, bounds.south);
  const east = Math.max(bounds.east, bounds.west);
  const west = Math.min(bounds.east, bounds.west);
  return { north, south, east, west };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
