export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PolylineHit {
  distance: number;
  segmentIndex: number;
  closest: Point;
  t: number;
}

export interface PolylineSample {
  x: number;
  y: number;
  angle: number;
}

export function catmullRomSpline(points: Point[], samplesPerSegment = 12): Point[] {
  if (points.length <= 2) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }
  const samples = Math.max(2, Math.floor(samplesPerSegment));
  const result: Point[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = i === 0 ? points[i] : points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i + 2 < points.length ? points[i + 2] : points[i + 1];
    for (let j = 0; j < samples; j += 1) {
      const t = j / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      result.push({ x, y });
    }
  }
  const last = points[points.length - 1];
  result.push({ x: last.x, y: last.y });
  return result;
}

export function distanceToPolyline(point: Point, line: Point[]): PolylineHit | null {
  if (line.length < 2) {
    return null;
  }
  let best: PolylineHit | null = null;
  let bestDistSq = Infinity;
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const hit = closestPointOnSegment(point, a, b);
    const dx = point.x - hit.closest.x;
    const dy = point.y - hit.closest.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = {
        distance: Math.sqrt(distSq),
        segmentIndex: i,
        closest: hit.closest,
        t: hit.t
      };
    }
  }
  return best;
}

export function samplePolyline(points: Point[], spacing: number): PolylineSample[] {
  if (points.length < 2 || spacing <= 0) {
    return [];
  }
  const samples: PolylineSample[] = [];
  let traveled = 0;
  let nextAt = spacing;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segmentLength = Math.hypot(dx, dy);
    if (segmentLength === 0) {
      continue;
    }
    while (traveled + segmentLength >= nextAt) {
      const t = (nextAt - traveled) / segmentLength;
      samples.push({
        x: a.x + dx * t,
        y: a.y + dy * t,
        angle: Math.atan2(dy, dx)
      });
      nextAt += spacing;
    }
    traveled += segmentLength;
  }
  return samples;
}

export function computeBounds(points: Point[]): Bounds | null {
  if (points.length === 0) {
    return null;
  }
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

export interface OffsetPolylineOptions {
  miterLimit?: number;
  minSegmentLength?: number;
}

export function offsetPolyline(
  points: Point[],
  offset: number,
  options: OffsetPolylineOptions = {}
): Point[] {
  if (points.length < 2 || offset === 0) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }
  const minSegmentLength = options.minSegmentLength ?? 1e-3;
  const miterLimit = Math.max(1, options.miterLimit ?? 4);
  const segmentCount = points.length - 1;
  const normals: Array<Point | null> = new Array(segmentCount).fill(null);
  for (let i = 0; i < segmentCount; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len > minSegmentLength) {
      normals[i] = { x: -dy / len, y: dx / len };
    }
  }
  let firstValid = -1;
  let lastValid = -1;
  for (let i = 0; i < segmentCount; i += 1) {
    if (normals[i]) {
      if (firstValid < 0) {
        firstValid = i;
      }
      lastValid = i;
    }
  }
  if (firstValid < 0 || lastValid < 0) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }
  const prevValid: number[] = new Array(segmentCount).fill(-1);
  const nextValid: number[] = new Array(segmentCount).fill(-1);
  for (let i = 0; i < segmentCount; i += 1) {
    prevValid[i] = normals[i] ? i : i > 0 ? prevValid[i - 1] : -1;
  }
  for (let i = segmentCount - 1; i >= 0; i -= 1) {
    nextValid[i] = normals[i] ? i : i < segmentCount - 1 ? nextValid[i + 1] : -1;
  }

  const result: Point[] = [];
  const miterLimitDistance = Math.abs(offset) * miterLimit;
  for (let i = 0; i < points.length; i += 1) {
    if (i === 0) {
      const normal = normals[firstValid] as Point;
      result.push({ x: points[i].x + normal.x * offset, y: points[i].y + normal.y * offset });
      continue;
    }
    if (i === points.length - 1) {
      const normal = normals[lastValid] as Point;
      result.push({ x: points[i].x + normal.x * offset, y: points[i].y + normal.y * offset });
      continue;
    }
    const prevIndex = prevValid[i - 1];
    const nextIndex = nextValid[i];
    const prev = prevIndex >= 0 ? normals[prevIndex] : null;
    const next = nextIndex >= 0 ? normals[nextIndex] : null;
    if (!prev && !next) {
      result.push({ x: points[i].x, y: points[i].y });
      continue;
    }
    if (!prev || !next) {
      const normal = (prev ?? next) as Point;
      result.push({ x: points[i].x + normal.x * offset, y: points[i].y + normal.y * offset });
      continue;
    }
    const sumX = prev.x + next.x;
    const sumY = prev.y + next.y;
    const sumLen = Math.hypot(sumX, sumY);
    if (sumLen <= 1e-6) {
      result.push({ x: points[i].x + next.x * offset, y: points[i].y + next.y * offset });
      continue;
    }
    const miterX = sumX / sumLen;
    const miterY = sumY / sumLen;
    const denom = miterX * next.x + miterY * next.y;
    if (Math.abs(denom) <= 1e-3) {
      result.push({ x: points[i].x + next.x * offset, y: points[i].y + next.y * offset });
      continue;
    }
    let miterLength = offset / denom;
    if (Math.abs(miterLength) > miterLimitDistance) {
      miterLength = Math.sign(miterLength) * miterLimitDistance;
    }
    result.push({
      x: points[i].x + miterX * miterLength,
      y: points[i].y + miterY * miterLength
    });
  }
  return result;
}

export function expandBounds(bounds: Bounds, padding: number): Bounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding
  };
}

export function pointInBounds(point: Point, bounds: Bounds): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
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
  return {
    closest: { x: a.x + dx * t, y: a.y + dy * t },
    t
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
