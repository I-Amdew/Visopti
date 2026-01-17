export interface Point {
  x: number;
  y: number;
}

export function normalizeRing(points: Point[]): Point[] {
  if (points.length < 2) {
    return points.map((point) => ({ ...point }));
  }
  const first = points[0];
  const last = points[points.length - 1];
  const close = Math.abs(first.x - last.x) <= 1e-6 && Math.abs(first.y - last.y) <= 1e-6;
  const normalized = close ? points.slice(0, -1) : points;
  return normalized.map((point) => ({ ...point }));
}

export function polygonSignedArea(points: Point[]): number {
  if (points.length < 3) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = (i + 1) % points.length;
    sum += points[i].x * points[next].y - points[next].x * points[i].y;
  }
  return sum / 2;
}

export function polygonArea(points: Point[]): number {
  return Math.abs(polygonSignedArea(points));
}

export function polygonPerimeter(points: Point[]): number {
  if (points.length < 2) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = (i + 1) % points.length;
    const dx = points[next].x - points[i].x;
    const dy = points[next].y - points[i].y;
    total += Math.hypot(dx, dy);
  }
  return total;
}

export function polygonCentroid(points: Point[]): Point {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  const area = polygonSignedArea(points);
  if (Math.abs(area) < 1e-6) {
    const sum = points.reduce(
      (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
      { x: 0, y: 0 }
    );
    return { x: sum.x / points.length, y: sum.y / points.length };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = (i + 1) % points.length;
    const cross = points[i].x * points[next].y - points[next].x * points[i].y;
    cx += (points[i].x + points[next].x) * cross;
    cy += (points[i].y + points[next].y) * cross;
  }
  const factor = 1 / (6 * area);
  return { x: cx * factor, y: cy * factor };
}

export function isPolygonSimple(points: Point[]): boolean {
  if (points.length < 3) {
    return false;
  }
  for (let i = 0; i < points.length; i += 1) {
    const next = (i + 1) % points.length;
    if (Math.hypot(points[next].x - points[i].x, points[next].y - points[i].y) < 1e-6) {
      return false;
    }
  }
  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % count];
    for (let j = i + 1; j < count; j += 1) {
      if (j === i || j === i + 1) {
        continue;
      }
      if (i === 0 && j === count - 1) {
        continue;
      }
      const c = points[j];
      const d = points[(j + 1) % count];
      if (segmentsIntersect(a, b, c, d)) {
        return false;
      }
    }
  }
  return true;
}

export function findClosestEdgeIndex(
  points: Point[],
  target: Point,
  maxDistance: number
): { index: number; distance: number; closest: Point } | null {
  if (points.length < 2) {
    return null;
  }
  let bestIndex = -1;
  let bestDistance = Infinity;
  let bestPoint = { x: 0, y: 0 };
  for (let i = 0; i < points.length; i += 1) {
    const next = (i + 1) % points.length;
    const result = closestPointOnSegment(target, points[i], points[next]);
    const dx = target.x - result.closest.x;
    const dy = target.y - result.closest.y;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
      bestPoint = result.closest;
    }
  }
  if (bestIndex === -1 || bestDistance > maxDistance) {
    return null;
  }
  return { index: bestIndex, distance: bestDistance, closest: bestPoint };
}

function closestPointOnSegment(point: Point, a: Point, b: Point): { closest: Point; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = dx * dx + dy * dy;
  if (denom === 0) {
    return { closest: { x: a.x, y: a.y }, t: 0 };
  }
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / denom;
  t = clamp(t, 0, 1);
  return { closest: { x: a.x + dx * t, y: a.y + dy * t }, t };
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }

  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;

  return false;
}

function orientation(a: Point, b: Point, c: Point): number {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) {
    return 0;
  }
  return value > 0 ? 1 : 2;
}

function onSegment(a: Point, b: Point, c: Point): boolean {
  return (
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    b.x >= Math.min(a.x, c.x) - 1e-9 &&
    b.y <= Math.max(a.y, c.y) + 1e-9 &&
    b.y >= Math.min(a.y, c.y) - 1e-9
  );
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
