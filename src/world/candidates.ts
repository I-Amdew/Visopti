import type { GeoProjector, Shape } from "../types";
import type { CandidateRegion } from "./worldModel";

const ELLIPSE_SEGMENTS = 24;

export function buildCandidateRegionsFromShapes(
  shapes: Shape[],
  projector: GeoProjector | null
): CandidateRegion[] {
  if (!projector) {
    return [];
  }
  const metersPerPixel = resolveMetersPerPixel(projector);
  return shapes
    .filter((shape) => shape.type === "candidate")
    .map((shape) => {
      const pointsPx = shapeToPolygonPixels(shape);
      const polygon = pointsPx.map((point) => projector.pixelToLatLon(point.x, point.y));
      const metrics = metersPerPixel ? computePolygonMetrics(pointsPx, metersPerPixel) : null;
      return {
        kind: "candidate",
        id: shape.id,
        name: shape.name,
        visible: shape.visible !== false,
        polygon,
        areaM2: metrics?.areaM2 ?? 0,
        perimeterM: metrics?.perimeterM ?? 0,
        render: pointsPx,
        sourceShapeId: shape.id
      };
    });
}

type PixelPoint = { x: number; y: number };

function shapeToPolygonPixels(shape: Shape): PixelPoint[] {
  if (shape.kind === "polygon") {
    return shape.points.map((point) => ({ x: point.x, y: point.y }));
  }
  if (shape.kind === "rect") {
    const x0 = shape.x;
    const y0 = shape.y;
    const x1 = shape.x + shape.width;
    const y1 = shape.y + shape.height;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    return [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY }
    ];
  }
  const centerX = shape.x + shape.width / 2;
  const centerY = shape.y + shape.height / 2;
  const radiusX = Math.abs(shape.width) / 2;
  const radiusY = Math.abs(shape.height) / 2;
  const points: PixelPoint[] = [];
  for (let i = 0; i < ELLIPSE_SEGMENTS; i += 1) {
    const angle = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
    points.push({
      x: centerX + Math.cos(angle) * radiusX,
      y: centerY + Math.sin(angle) * radiusY
    });
  }
  return points;
}

function computePolygonMetrics(
  points: PixelPoint[],
  metersPerPixel: { x: number; y: number }
): { areaM2: number; perimeterM: number } | null {
  if (points.length < 3) {
    return null;
  }
  const mppX = metersPerPixel.x;
  const mppY = metersPerPixel.y;
  if (!Number.isFinite(mppX) || !Number.isFinite(mppY) || mppX <= 0 || mppY <= 0) {
    return null;
  }
  let areaSum = 0;
  let lengthSum = 0;
  const scaled = points.map((point) => ({ x: point.x * mppX, y: point.y * mppY }));
  for (let i = 0; i < scaled.length; i += 1) {
    const current = scaled[i];
    const next = scaled[(i + 1) % scaled.length];
    areaSum += current.x * next.y - next.x * current.y;
    lengthSum += Math.hypot(next.x - current.x, next.y - current.y);
  }
  const areaM2 = Math.abs(areaSum) / 2;
  const perimeterM = lengthSum;
  if (!Number.isFinite(areaM2) || !Number.isFinite(perimeterM)) {
    return null;
  }
  return { areaM2, perimeterM };
}

function resolveMetersPerPixel(
  projector: GeoProjector
): { x: number; y: number } | null {
  const { bounds, size } = projector;
  if (!bounds || size.width <= 0 || size.height <= 0) {
    return null;
  }
  const latMid = (bounds.north + bounds.south) / 2;
  const lonMid = (bounds.east + bounds.west) / 2;
  const widthM = haversineMeters(latMid, bounds.west, latMid, bounds.east);
  const heightM = haversineMeters(bounds.north, lonMid, bounds.south, lonMid);
  if (!Number.isFinite(widthM) || !Number.isFinite(heightM) || widthM <= 0 || heightM <= 0) {
    return null;
  }
  return { x: widthM / size.width, y: heightM / size.height };
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
