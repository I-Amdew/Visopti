import { laneCapacityFactor, resolveLaneCounts } from "./lanes";
import type { TurnDirection } from "./types";
import { Road, RoadClass, RoadId } from "./types";

export interface GraphNode {
  id: string;
  lat: number;
  lon: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  roadId: RoadId;
  lengthM: number;
  baseTimeS: number;
  speedMps: number;
  weight: number;
  forward: boolean;
}

export interface GraphMovement {
  nodeId: string;
  fromEdgeId: string;
  toEdgeId: string;
  turn: TurnDirection;
  angleDeg: number;
  incomingBearing: number;
  outgoingBearing: number;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  adjacency: Map<string, GraphEdge[]>;
  nodeList: GraphNode[];
  movementByNode: Map<string, GraphMovement[]>;
  movementByEdgePair: Map<string, GraphMovement>;
}

export interface GraphBuildOptions {
  coordPrecision?: number;
}

const DEFAULT_SPEED_KMH: Record<string, number> = {
  motorway: 105,
  trunk: 85,
  primary: 65,
  secondary: 55,
  tertiary: 45,
  residential: 35,
  unclassified: 35,
  service: 25,
  living_street: 15,
  motorway_link: 60,
  trunk_link: 50,
  primary_link: 45,
  secondary_link: 40,
  tertiary_link: 35,
  track: 20,
  path: 12,
  cycleway: 18,
  footway: 6,
  pedestrian: 6,
  construction: 15,
};

const EARTH_RADIUS_M = 6371000;

export function buildGraph(roads: Road[], options: GraphBuildOptions = {}): Graph {
  const coordPrecision = options.coordPrecision ?? 5;
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const adjacency = new Map<string, GraphEdge[]>();

  const getNodeId = (lat: number, lon: number, nodeId?: string | number): string => {
    if (nodeId !== undefined && nodeId !== null) {
      return `osm:${String(nodeId)}`;
    }
    const qLat = quantize(lat, coordPrecision).toFixed(coordPrecision);
    const qLon = quantize(lon, coordPrecision).toFixed(coordPrecision);
    return `q:${qLat},${qLon}`;
  };

  const ensureNode = (id: string, lat: number, lon: number): GraphNode => {
    let node = nodes.get(id);
    if (!node) {
      node = { id, lat, lon };
      nodes.set(id, node);
    }
    return node;
  };

  for (const road of roads) {
    if (!road.points || road.points.length < 2) {
      continue;
    }
    const speedMps = speedForClass(road.class);
    const oneway = parseOneway(road.oneway);
    const laneCounts = resolveLaneCounts(road);
    const forwardLanes = laneCounts.forward > 0 ? laneCounts.forward : laneCounts.total;
    const backwardLanes = laneCounts.backward > 0 ? laneCounts.backward : laneCounts.total;
    const forwardCapacity = laneCapacityFactor(forwardLanes);
    const backwardCapacity = laneCapacityFactor(backwardLanes);

    for (let i = 0; i < road.points.length - 1; i += 1) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const fromId = getNodeId(a.lat, a.lon, a.nodeId);
      const toId = getNodeId(b.lat, b.lon, b.nodeId);
      if (fromId === toId) {
        continue;
      }
      ensureNode(fromId, a.lat, a.lon);
      ensureNode(toId, b.lat, b.lon);

      const lengthM = haversineMeters(a.lat, a.lon, b.lat, b.lon);
      if (!Number.isFinite(lengthM) || lengthM <= 0) {
        continue;
      }
      const baseTimeS = lengthM / speedMps;

      if (oneway >= 0) {
        const edgeId = `${road.id}:${i}:f`;
        const edge: GraphEdge = {
          id: edgeId,
          from: fromId,
          to: toId,
          roadId: road.id,
          lengthM,
          baseTimeS,
          speedMps,
          weight: baseTimeS / forwardCapacity,
          forward: true,
        };
        edges.push(edge);
        addAdjacency(adjacency, fromId, edge);
      }
      if (oneway <= 0) {
        const edgeId = `${road.id}:${i}:b`;
        const edge: GraphEdge = {
          id: edgeId,
          from: toId,
          to: fromId,
          roadId: road.id,
          lengthM,
          baseTimeS,
          speedMps,
          weight: baseTimeS / backwardCapacity,
          forward: false,
        };
        edges.push(edge);
        addAdjacency(adjacency, toId, edge);
      }
    }
  }

  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.to);
    if (list) {
      list.push(edge);
    } else {
      incoming.set(edge.to, [edge]);
    }
  }

  const movementByNode = new Map<string, GraphMovement[]>();
  const movementByEdgePair = new Map<string, GraphMovement>();
  for (const node of nodes.values()) {
    const incomingEdges = incoming.get(node.id);
    const outgoingEdges = adjacency.get(node.id);
    if (!incomingEdges || !outgoingEdges) {
      continue;
    }
    for (const inEdge of incomingEdges) {
      const fromNode = nodes.get(inEdge.from);
      if (!fromNode) {
        continue;
      }
      const incomingBearing = bearingDegrees(fromNode, node);
      for (const outEdge of outgoingEdges) {
        const toNode = nodes.get(outEdge.to);
        if (!toNode) {
          continue;
        }
        const outgoingBearing = bearingDegrees(node, toNode);
        const angleDeg = normalizeAngleDelta(outgoingBearing - incomingBearing);
        const turn = classifyTurn(angleDeg);
        const movement: GraphMovement = {
          nodeId: node.id,
          fromEdgeId: inEdge.id,
          toEdgeId: outEdge.id,
          turn,
          angleDeg,
          incomingBearing,
          outgoingBearing
        };
        movementByEdgePair.set(`${inEdge.id}|${outEdge.id}`, movement);
        const list = movementByNode.get(node.id);
        if (list) {
          list.push(movement);
        } else {
          movementByNode.set(node.id, [movement]);
        }
      }
    }
  }

  return {
    nodes,
    edges,
    adjacency,
    nodeList: Array.from(nodes.values()),
    movementByNode,
    movementByEdgePair
  };
}

function addAdjacency(adjacency: Map<string, GraphEdge[]>, nodeId: string, edge: GraphEdge): void {
  const list = adjacency.get(nodeId);
  if (list) {
    list.push(edge);
  } else {
    adjacency.set(nodeId, [edge]);
  }
}

function parseOneway(value: Road["oneway"]): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (value === -1 || value === "-1") {
    return -1;
  }
  if (value === true || value === 1 || value === "1" || value === "yes" || value === "true") {
    return 1;
  }
  if (value === false || value === 0 || value === "0" || value === "no" || value === "false") {
    return 0;
  }
  return 0;
}

function speedForClass(roadClass?: RoadClass): number {
  if (!roadClass) {
    return kmhToMps(35);
  }
  const normalized = roadClass.toLowerCase();
  const kmh = DEFAULT_SPEED_KMH[normalized] ?? 35;
  return kmhToMps(kmh);
}

function kmhToMps(kmh: number): number {
  return kmh / 3.6;
}

function quantize(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
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

function bearingDegrees(start: { lat: number; lon: number }, end: { lat: number; lon: number }): number {
  const lat1 = toRad(start.lat);
  const lat2 = toRad(end.lat);
  const dLon = toRad(end.lon - start.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

function normalizeAngleDelta(angleDeg: number): number {
  const normalized = ((angleDeg + 540) % 360) - 180;
  return normalized;
}

const TURN_STRAIGHT_THRESHOLD_DEG = 30;

function classifyTurn(angleDeg: number): TurnDirection {
  if (Math.abs(angleDeg) <= TURN_STRAIGHT_THRESHOLD_DEG) {
    return "straight";
  }
  return angleDeg > 0 ? "right" : "left";
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
