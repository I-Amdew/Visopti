import { Building, LatLon } from "./types";
import { GraphNode } from "./graph";

const EARTH_RADIUS_M = 6371000;

export interface BuildingEndpointIndex {
  nodeIds: string[];
  totalBuildings: number;
  matchedBuildings: number;
}

export function pickEpicenterNodes(
  nodes: GraphNode[],
  epicenter: LatLon,
  radiusM: number
): GraphNode[] {
  if (!nodes.length) {
    return [];
  }
  const hits: GraphNode[] = [];
  for (const node of nodes) {
    const dist = haversineMeters(epicenter.lat, epicenter.lon, node.lat, node.lon);
    if (dist <= radiusM) {
      hits.push(node);
    }
  }
  return hits;
}

export function pickRandomNode(nodes: GraphNode[], rng: () => number): GraphNode | null {
  if (!nodes.length) {
    return null;
  }
  const idx = Math.floor(rng() * nodes.length);
  return nodes[Math.min(nodes.length - 1, Math.max(0, idx))];
}

export function buildBuildingEndpointIndex(
  buildings: Building[] | undefined,
  nodes: GraphNode[]
): BuildingEndpointIndex {
  const totalBuildings = buildings?.length ?? 0;
  if (!buildings || buildings.length === 0 || nodes.length === 0) {
    return { nodeIds: [], totalBuildings, matchedBuildings: 0 };
  }

  const cellSize = computeCellSize(nodes);
  const grid = buildNodeGrid(nodes, cellSize);
  const nodeIds: string[] = [];
  let matchedBuildings = 0;

  for (const building of buildings) {
    const centroid = getBuildingCentroid(building);
    if (!centroid) {
      continue;
    }
    const nearest = findNearestNode(grid, cellSize, nodes, centroid);
    if (!nearest) {
      continue;
    }
    nodeIds.push(nearest.id);
    matchedBuildings += 1;
  }

  return { nodeIds, totalBuildings, matchedBuildings };
}

export function pickBuildingNode(index: BuildingEndpointIndex, rng: () => number): string | null {
  if (!index.nodeIds.length) {
    return null;
  }
  const idx = Math.floor(rng() * index.nodeIds.length);
  return index.nodeIds[Math.min(index.nodeIds.length - 1, Math.max(0, idx))];
}

function computeCellSize(nodes: GraphNode[]): number {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const node of nodes) {
    if (node.lat < minLat) minLat = node.lat;
    if (node.lat > maxLat) maxLat = node.lat;
    if (node.lon < minLon) minLon = node.lon;
    if (node.lon > maxLon) maxLon = node.lon;
  }
  const latRange = Math.max(0, maxLat - minLat);
  const lonRange = Math.max(0, maxLon - minLon);
  const range = Math.max(latRange, lonRange);
  if (range === 0) {
    return 0.005;
  }
  return clamp(range / 40, 0.002, 0.02);
}

function buildNodeGrid(nodes: GraphNode[], cellSize: number): Map<string, GraphNode[]> {
  const grid = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = cellKey(node.lat, node.lon, cellSize);
    const list = grid.get(key);
    if (list) {
      list.push(node);
    } else {
      grid.set(key, [node]);
    }
  }
  return grid;
}

function findNearestNode(
  grid: Map<string, GraphNode[]>,
  cellSize: number,
  nodes: GraphNode[],
  point: LatLon
): GraphNode | null {
  const { row, col } = cellCoord(point.lat, point.lon, cellSize);
  let best: GraphNode | null = null;
  let bestDist = Infinity;
  const maxRadius = 4;

  for (let radius = 0; radius <= maxRadius; radius += 1) {
    for (let dr = -radius; dr <= radius; dr += 1) {
      for (let dc = -radius; dc <= radius; dc += 1) {
        const key = cellKeyFromCoord(row + dr, col + dc);
        const list = grid.get(key);
        if (!list) {
          continue;
        }
        for (const node of list) {
          const dist = haversineMeters(point.lat, point.lon, node.lat, node.lon);
          if (dist < bestDist) {
            bestDist = dist;
            best = node;
          }
        }
      }
    }
    if (best) {
      return best;
    }
  }

  for (const node of nodes) {
    const dist = haversineMeters(point.lat, point.lon, node.lat, node.lon);
    if (dist < bestDist) {
      bestDist = dist;
      best = node;
    }
  }
  return best;
}

function getBuildingCentroid(building: Building): LatLon | null {
  if (building.centroid) {
    return building.centroid;
  }
  const points = building.outline || building.points || building.polygon;
  if (!points || points.length === 0) {
    return null;
  }
  let sumLat = 0;
  let sumLon = 0;
  for (const point of points) {
    sumLat += point.lat;
    sumLon += point.lon;
  }
  const count = points.length;
  return { lat: sumLat / count, lon: sumLon / count };
}

function cellCoord(lat: number, lon: number, cellSize: number): { row: number; col: number } {
  return {
    row: Math.floor(lat / cellSize),
    col: Math.floor(lon / cellSize),
  };
}

function cellKey(lat: number, lon: number, cellSize: number): string {
  const { row, col } = cellCoord(lat, lon, cellSize);
  return cellKeyFromCoord(row, col);
}

function cellKeyFromCoord(row: number, col: number): string {
  return `${row}:${col}`;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
