import { GeoMapper } from "./geo";

export interface ContourSegment {
  level: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

const FEET_TO_METERS = 0.3048;

export function generateContourSegments(mapper: GeoMapper, intervalFeet = 1): ContourSegment[] {
  const grid = mapper.grid;
  const rows = grid.rows;
  const cols = grid.cols;
  if (rows === 0 || cols === 0) {
    return [];
  }
  const interval = intervalFeet * FEET_TO_METERS;
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;
  for (const row of grid.values) {
    for (const value of row) {
      if (value < minValue) minValue = value;
      if (value > maxValue) maxValue = value;
    }
  }
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || maxValue - minValue < 1e-6) {
    return [];
  }

  const startLevel = Math.floor(minValue / interval) * interval;
  const endLevel = Math.ceil(maxValue / interval) * interval;
  const nodePixels: { x: number; y: number }[][] = [];
  for (let r = 0; r < rows; r += 1) {
    nodePixels[r] = [];
    for (let c = 0; c < cols; c += 1) {
      nodePixels[r][c] = mapper.gridNodeToPixel(r, c);
    }
  }

  const segments: ContourSegment[] = [];

  for (let level = startLevel; level <= endLevel; level += interval) {
    for (let r = 0; r < rows - 1; r += 1) {
      for (let c = 0; c < cols - 1; c += 1) {
        const v0 = grid.values[r][c];
        const v1 = grid.values[r][c + 1];
        const v2 = grid.values[r + 1][c + 1];
        const v3 = grid.values[r + 1][c];
        const cellMin = Math.min(v0, v1, v2, v3);
        const cellMax = Math.max(v0, v1, v2, v3);
        if (level < cellMin || level > cellMax) {
          continue;
        }
        const idx =
          (v0 >= level ? 1 : 0) |
          (v1 >= level ? 2 : 0) |
          (v2 >= level ? 4 : 0) |
          (v3 >= level ? 8 : 0);
        if (idx === 0 || idx === 15) {
          continue;
        }
        const edgePoints = getEdgePoints(nodePixels, r, c, v0, v1, v2, v3, level);
        const caseSegments = marchingSquaresCase(idx);
        for (const [edgeA, edgeB] of caseSegments) {
          const start = edgePoints[edgeA];
          const end = edgePoints[edgeB];
          if (start && end) {
            segments.push({ level: level / FEET_TO_METERS, start, end });
          }
        }
      }
    }
  }

  return segments;
}

function getEdgePoints(
  nodePixels: { x: number; y: number }[][],
  r: number,
  c: number,
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  level: number
): Array<{ x: number; y: number } | null> {
  const points: Array<{ x: number; y: number } | null> = [null, null, null, null];
  const topLeft = nodePixels[r][c];
  const topRight = nodePixels[r][c + 1];
  const bottomRight = nodePixels[r + 1][c + 1];
  const bottomLeft = nodePixels[r + 1][c];

  points[0] = interpolateEdge(topLeft, topRight, v0, v1, level);
  points[1] = interpolateEdge(topRight, bottomRight, v1, v2, level);
  points[2] = interpolateEdge(bottomRight, bottomLeft, v2, v3, level);
  points[3] = interpolateEdge(bottomLeft, topLeft, v3, v0, level);

  return points;
}

function interpolateEdge(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  v1: number,
  v2: number,
  level: number
): { x: number; y: number } {
  const denom = v2 - v1;
  const t = Math.abs(denom) < 1e-6 ? 0.5 : (level - v1) / denom;
  return {
    x: p1.x + (p2.x - p1.x) * t,
    y: p1.y + (p2.y - p1.y) * t
  };
}

type EdgeIndex = 0 | 1 | 2 | 3;
function marchingSquaresCase(idx: number): Array<[EdgeIndex, EdgeIndex]> {
  switch (idx) {
    case 0:
    case 15:
      return [];
    case 1:
    case 14:
      return idx === 1 ? [[3, 0]] : [[0, 3]];
    case 2:
    case 13:
      return idx === 2 ? [[0, 1]] : [[1, 0]];
    case 3:
    case 12:
      return idx === 3 ? [[3, 1]] : [[1, 3]];
    case 4:
    case 11:
      return idx === 4 ? [[1, 2]] : [[2, 1]];
    case 5:
      return [[3, 0], [1, 2]];
    case 10:
      return [[0, 1], [2, 3]];
    case 6:
    case 9:
      return idx === 6 ? [[0, 2]] : [[2, 0]];
    case 7:
    case 8:
      return idx === 7 ? [[3, 2]] : [[2, 3]];
    default:
      return [];
  }
}
