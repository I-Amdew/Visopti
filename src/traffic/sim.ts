import { buildGraph, GraphNode } from "./graph";
import { demandWeightForClass, laneCapacityFactor, resolveLaneCounts } from "./lanes";
import {
  BuildingEndpointIndex,
  ParcelEndpointIndex,
  buildBuildingEndpointIndex,
  buildParcelEndpointIndex,
  pickEpicenterNodes,
  pickRandomNode,
} from "./endpoints";
import { findTopKPaths } from "./routing";
import {
  LatLon,
  Road,
  RoadClass,
  RoadId,
  TrafficPresetName,
  TrafficEpicenter,
  TrafficEdgeTraffic,
  TrafficSimProgress,
  TrafficSimRequest,
  TrafficSimResult,
  TrafficSignal,
  TrafficViewerSample,
} from "./types";

export interface SimOptions {
  onProgress?: (progress: TrafficSimProgress) => void;
  isCancelled?: () => boolean;
}

interface DirectionCounts {
  forward: number;
  backward: number;
}

interface PresetBaseScores {
  forward: number;
  backward: number;
}

const DEFAULT_PRESETS: TrafficPresetName[] = ["am", "pm", "neutral"];
const DEFAULT_CENTRAL_SHARE = 0.6;
const DEFAULT_EPICENTER_RADIUS_M = 800;
const EPICENTER_CLUSTER_LIMIT = 3;
const BOUNDARY_NODE_BUFFER_M = 220;
const SIGNAL_NODE_MAX_DIST_M = 35;
const SIGNAL_DELAY_SEC = 10;
const VIEWER_SAMPLE_SPACING_M = 30;
const METERS_PER_DEG_LAT = 111_320;
const MAJOR_ROAD_CLASSES: Set<RoadClass> = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link"
]);

export function simulateTraffic(request: TrafficSimRequest, options: SimOptions = {}): TrafficSimResult {
  const startTime = Date.now();
  const roads = request.roads ?? [];
  const config = request.config;
  const seed = normalizeSeed(request.seed);
  const rng = createRng(seed);
  const kRoutes = Math.max(1, Math.round(config.kRoutes ?? 5));
  const presets = request.presets && request.presets.length ? request.presets : DEFAULT_PRESETS;

  const graph = buildGraph(roads);
  options.onProgress?.({ phase: "graph", completed: 1, total: 1 });

  if (graph.edges.length === 0 || graph.nodeList.length === 0) {
    console.warn("Traffic sim: empty graph");
    return buildEmptyResult(roads, kRoutes, seed, startTime, 0);
  }

  const signalDelayByEdge = applyTrafficSignalDelays(graph, request.trafficSignals);
  const frameBounds = request.frameBounds;
  const simBounds = request.simBounds;
  const simNodes = filterNodesByBounds(graph.nodeList, simBounds);
  const nodeUniverse = simNodes.length ? simNodes : graph.nodeList;
  const epicenterRadiusM = Math.max(
    0,
    Number.isFinite(config.epicenterRadiusM)
      ? (config.epicenterRadiusM as number)
      : DEFAULT_EPICENTER_RADIUS_M
  );
  const epicenterPools = resolveEpicenterPools(
    roads,
    nodeUniverse,
    simBounds,
    config.epicenter ?? null,
    epicenterRadiusM
  );
  const epicenters: TrafficEpicenter[] = epicenterPools.map((pool) => ({
    point: pool.point,
    weight: pool.weight,
    direction: pool.direction
  }));

  const buildingIndex = buildBuildingEndpointIndex(request.buildings, nodeUniverse);
  const parcelCount = estimateParcelCount(request.detailLevel ?? 1);
  const parcelIndex = buildParcelEndpointIndex(frameBounds, nodeUniverse, parcelCount, rng);
  const endpointPool = mergeEndpointPools(buildingIndex, parcelIndex);
  const nodePools = partitionNodesByBounds(nodeUniverse, frameBounds);
  const boundaryNodes = buildBoundaryNodePool(nodeUniverse, simBounds, BOUNDARY_NODE_BUFFER_M);
  const centralShare = clamp(
    typeof config.centralShare === "number" ? config.centralShare : DEFAULT_CENTRAL_SHARE,
    0,
    1
  );
  options.onProgress?.({ phase: "endpoints", completed: 1, total: 1 });

  if (!epicenterPools.length) {
    console.warn("Traffic sim: no epicenters inferred; falling back to random nodes.");
  }
  if (!buildingIndex.nodeIds.length) {
    console.warn("Traffic sim: no building endpoints; falling back to random nodes.");
  }

  const baseTripCount =
    config.tripCount ??
    estimateTripCount(roads.length, request.detailLevel ?? 1, endpointPool.nodeIds.length);
  const tripCount = clamp(Math.round(baseTripCount), 50, 12000);

  const countsByPreset = new Map<TrafficPresetName, Map<RoadId, DirectionCounts>>();
  const demandWeights = new Map<RoadId, number>();
  const laneWeights = new Map<RoadId, { forward: number; backward: number }>();
  for (const road of roads) {
    demandWeights.set(road.id, demandWeightForClass(road.class));
    const laneCounts = resolveLaneCounts(road);
    const forwardLanes = laneCounts.forward > 0 ? laneCounts.forward : Math.max(1, laneCounts.total);
    const backwardLanes = laneCounts.backward > 0 ? laneCounts.backward : Math.max(1, laneCounts.total);
    laneWeights.set(road.id, {
      forward: laneCapacityFactor(forwardLanes),
      backward: laneCapacityFactor(backwardLanes)
    });
  }
  const edgeCounts = new Map<string, number>();
  let totalTrips = 0;
  let cancelled = false;

  for (const preset of presets) {
    if (options.isCancelled?.()) {
      cancelled = true;
      break;
    }
    const counts = initCounts(roads);
    const progressStep = Math.max(1, Math.floor(tripCount / 50));

    for (let trip = 0; trip < tripCount; trip += 1) {
      if (options.isCancelled?.()) {
        cancelled = true;
        break;
      }
      const { originId, destId } = pickTripEndpoints(
        preset,
        {
          epicenters: epicenterPools,
          endpointPool,
          nodePools,
          boundaryNodes,
          nodes: nodeUniverse,
          rng,
          centralShare
        }
      );
      if (!originId || !destId || originId === destId) {
        continue;
      }

      const paths = findTopKPaths(graph, originId, destId, kRoutes);
      if (!paths.length) {
        continue;
      }
      const pathWeight = 1 / paths.length;
      for (const path of paths) {
        for (const edge of path.edges) {
          const record = counts.get(edge.roadId);
          if (!record) {
            continue;
          }
          const demandWeight = demandWeights.get(edge.roadId) ?? 1;
          const laneWeight = edge.forward
            ? laneWeights.get(edge.roadId)?.forward ?? 1
            : laneWeights.get(edge.roadId)?.backward ?? 1;
          const weighted = pathWeight * demandWeight * laneWeight;
          edgeCounts.set(edge.id, (edgeCounts.get(edge.id) ?? 0) + weighted);
          if (edge.forward) {
            record.forward += weighted;
          } else {
            record.backward += weighted;
          }
        }
      }

      if ((trip + 1) % progressStep === 0 || trip + 1 === tripCount) {
        options.onProgress?.({ phase: preset, completed: trip + 1, total: tripCount });
      }
    }

    if (cancelled) {
      break;
    }
    countsByPreset.set(preset, counts);
    totalTrips += tripCount;
  }

  if (cancelled) {
    return buildEmptyResult(roads, kRoutes, seed, startTime, totalTrips);
  }

  const baseScores = new Map<TrafficPresetName, Record<RoadId, PresetBaseScores>>();
  for (const preset of presets) {
    const counts = countsByPreset.get(preset);
    if (!counts) {
      continue;
    }
    baseScores.set(preset, normalizeCounts(counts));
  }

  const hourWeights = buildHourWeights();
  const roadTraffic: Record<RoadId, { hourlyScore: { forward: number[]; backward: number[] } }> = {};
  for (const road of roads) {
    const baseAm = baseScores.get("am")?.[road.id] ?? { forward: 0, backward: 0 };
    const basePm = baseScores.get("pm")?.[road.id] ?? { forward: 0, backward: 0 };
    const baseNeutral = baseScores.get("neutral")?.[road.id] ?? { forward: 0, backward: 0 };

    const forward: number[] = [];
    const backward: number[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const weights = hourWeights[hour];
      const fScore =
        baseAm.forward * weights.am + basePm.forward * weights.pm + baseNeutral.forward * weights.neutral;
      const bScore =
        baseAm.backward * weights.am +
        basePm.backward * weights.pm +
        baseNeutral.backward * weights.neutral;
      forward.push(clamp(fScore, 0, 100));
      backward.push(clamp(bScore, 0, 100));
    }

    roadTraffic[road.id] = {
      hourlyScore: { forward, backward },
    };
  }

  const edgeTraffic = buildEdgeTraffic(graph, edgeCounts, signalDelayByEdge);
  const viewerSamples = buildTrafficViewerSamples(
    graph,
    edgeCounts,
    signalDelayByEdge,
    frameBounds
  );
  const durationMs = Date.now() - startTime;
  return {
    roadTraffic,
    edgeTraffic,
    viewerSamples,
    epicenters,
    meta: {
      trips: totalTrips,
      kRoutes,
      durationMs,
      seed,
      generatedAtIso: new Date().toISOString(),
    },
  };
}

function initCounts(roads: Road[]): Map<RoadId, DirectionCounts> {
  const counts = new Map<RoadId, DirectionCounts>();
  for (const road of roads) {
    counts.set(road.id, { forward: 0, backward: 0 });
  }
  return counts;
}

function normalizeCounts(counts: Map<RoadId, DirectionCounts>): Record<RoadId, PresetBaseScores> {
  let maxCount = 0;
  for (const value of counts.values()) {
    if (value.forward > maxCount) maxCount = value.forward;
    if (value.backward > maxCount) maxCount = value.backward;
  }
  const result: Record<RoadId, PresetBaseScores> = {};
  if (maxCount <= 0) {
    for (const [roadId] of counts.entries()) {
      result[roadId] = { forward: 0, backward: 0 };
    }
    return result;
  }
  const scale = 100 / maxCount;
  for (const [roadId, value] of counts.entries()) {
    result[roadId] = {
      forward: clamp(value.forward * scale, 0, 100),
      backward: clamp(value.backward * scale, 0, 100),
    };
  }
  return result;
}

function estimateTripCount(roadCount: number, detailLevel: number, endpointCount: number): number {
  const base = Math.max(200, Math.round(roadCount * 1.2));
  const scale = clamp(detailLevel, 0.25, 3);
  const endpointScale = endpointCount > 0 ? clamp(endpointCount / 900, 0.6, 1.8) : 1;
  return base * scale * endpointScale;
}

function estimateParcelCount(detailLevel: number): number {
  const level = clamp(detailLevel, 1, 5);
  const factor = 0.7 + (level - 1) * 0.15;
  return clamp(Math.round(1000 * factor), 500, 1800);
}

function buildHourWeights(): Array<{ am: number; pm: number; neutral: number }> {
  const weights: Array<{ am: number; pm: number; neutral: number }> = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const am = gaussian(hour, 8, 2.2);
    const pm = gaussian(hour, 17, 2.2);
    const neutral = 0.35 + gaussian(hour, 12, 5.5);
    const total = am + pm + neutral;
    weights.push({ am: am / total, pm: pm / total, neutral: neutral / total });
  }
  return weights;
}

interface EndpointPool {
  nodeIds: string[];
  totalCandidates: number;
  matchedCandidates: number;
}

interface NodePools {
  inside: GraphNode[];
  outside: GraphNode[];
}

interface EpicenterPool {
  point: LatLon;
  weight: number;
  nodes: GraphNode[];
  direction?: "north" | "south" | "east" | "west";
}

interface TripEndpointContext {
  epicenters: EpicenterPool[];
  endpointPool: EndpointPool;
  nodePools: NodePools;
  boundaryNodes: GraphNode[];
  nodes: GraphNode[];
  rng: () => number;
  centralShare: number;
}

function mergeEndpointPools(
  buildingIndex: BuildingEndpointIndex,
  parcelIndex: ParcelEndpointIndex
): EndpointPool {
  const combined = new Set<string>();
  for (const id of buildingIndex.nodeIds) {
    combined.add(id);
  }
  for (const id of parcelIndex.nodeIds) {
    combined.add(id);
  }
  return {
    nodeIds: Array.from(combined),
    totalCandidates: buildingIndex.totalBuildings + parcelIndex.totalParcels,
    matchedCandidates: combined.size
  };
}

function partitionNodesByBounds(
  nodes: GraphNode[],
  bounds: { north: number; south: number; east: number; west: number }
): NodePools {
  const inside: GraphNode[] = [];
  const outside: GraphNode[] = [];
  for (const node of nodes) {
    const inBounds =
      node.lat <= bounds.north &&
      node.lat >= bounds.south &&
      node.lon >= bounds.west &&
      node.lon <= bounds.east;
    if (inBounds) {
      inside.push(node);
    } else {
      outside.push(node);
    }
  }
  return { inside, outside };
}

function filterNodesByBounds(
  nodes: GraphNode[],
  bounds: { north: number; south: number; east: number; west: number }
): GraphNode[] {
  return nodes.filter((node) => isWithinBounds(node, bounds));
}

function buildBoundaryNodePool(
  nodes: GraphNode[],
  bounds: { north: number; south: number; east: number; west: number },
  bufferM: number
): GraphNode[] {
  if (bufferM <= 0) {
    return [];
  }
  const boundaryNodes: GraphNode[] = [];
  const latBufferDeg = bufferM / METERS_PER_DEG_LAT;
  for (const node of nodes) {
    const nearLat =
      Math.abs(bounds.north - node.lat) <= latBufferDeg ||
      Math.abs(node.lat - bounds.south) <= latBufferDeg;
    const lonBufferDeg = bufferM / metersPerDegreeLon(node.lat);
    const nearLon =
      Math.abs(bounds.east - node.lon) <= lonBufferDeg ||
      Math.abs(node.lon - bounds.west) <= lonBufferDeg;
    if (nearLat || nearLon) {
      boundaryNodes.push(node);
    }
  }
  return boundaryNodes;
}

function resolveEpicenterPools(
  roads: Road[],
  nodes: GraphNode[],
  simBounds: { north: number; south: number; east: number; west: number },
  manualEpicenter: LatLon | null,
  radiusM: number
): EpicenterPool[] {
  const resolvedRadius = radiusM > 0 ? radiusM : DEFAULT_EPICENTER_RADIUS_M;
  if (manualEpicenter) {
    return [buildEpicenterPool(manualEpicenter, nodes, resolvedRadius, undefined, 1)];
  }
  const inferred = inferEpicenterPools(roads, nodes, simBounds, resolvedRadius);
  if (inferred.length) {
    return inferred;
  }
  const fallbackPoint = {
    lat: (simBounds.north + simBounds.south) / 2,
    lon: (simBounds.east + simBounds.west) / 2
  };
  return [buildEpicenterPool(fallbackPoint, nodes, resolvedRadius, undefined, 1)];
}

function inferEpicenterPools(
  roads: Road[],
  nodes: GraphNode[],
  bounds: { north: number; south: number; east: number; west: number },
  radiusM: number
): EpicenterPool[] {
  const crossings = findBoundaryCrossings(roads, bounds);
  if (!crossings.length) {
    return [];
  }
  const clusters = new Map<
    "north" | "south" | "east" | "west",
    { capacity: number; latSum: number; lonSum: number }
  >();
  for (const crossing of crossings) {
    const entry = clusters.get(crossing.direction) ?? {
      capacity: 0,
      latSum: 0,
      lonSum: 0
    };
    entry.capacity += crossing.capacity;
    entry.latSum += crossing.point.lat * crossing.capacity;
    entry.lonSum += crossing.point.lon * crossing.capacity;
    clusters.set(crossing.direction, entry);
  }
  const sorted = Array.from(clusters.entries())
    .map(([direction, entry]) => ({
      direction,
      capacity: entry.capacity,
      point: {
        lat: entry.capacity > 0 ? entry.latSum / entry.capacity : 0,
        lon: entry.capacity > 0 ? entry.lonSum / entry.capacity : 0
      }
    }))
    .sort((a, b) => b.capacity - a.capacity)
    .slice(0, EPICENTER_CLUSTER_LIMIT);
  if (!sorted.length) {
    return [];
  }
  const totalCapacity = sorted.reduce((sum, entry) => sum + entry.capacity, 0);
  return sorted.map((entry) =>
    buildEpicenterPool(
      entry.point,
      nodes,
      radiusM,
      entry.direction,
      totalCapacity > 0 ? entry.capacity / totalCapacity : 1 / sorted.length
    )
  );
}

function buildEpicenterPool(
  point: LatLon,
  nodes: GraphNode[],
  radiusM: number,
  direction: "north" | "south" | "east" | "west" | undefined,
  weight: number
): EpicenterPool {
  const epicenterNodes =
    radiusM > 0 ? pickEpicenterNodes(nodes, point, radiusM) : [];
  let resolvedNodes = epicenterNodes;
  if (!resolvedNodes.length) {
    const nearest = findNearestNode(nodes, point);
    resolvedNodes = nearest ? [nearest.node] : [];
  }
  return {
    point,
    weight,
    nodes: resolvedNodes,
    direction
  };
}

interface BoundaryCrossing {
  point: LatLon;
  direction: "north" | "south" | "east" | "west";
  capacity: number;
}

function findBoundaryCrossings(
  roads: Road[],
  bounds: { north: number; south: number; east: number; west: number }
): BoundaryCrossing[] {
  const crossings: BoundaryCrossing[] = [];
  for (const road of roads) {
    if (!road.points || road.points.length < 2) {
      continue;
    }
    const roadClass = normalizeRoadClass(road.class);
    if (!roadClass || !MAJOR_ROAD_CLASSES.has(roadClass)) {
      continue;
    }
    const laneCounts = resolveLaneCounts(road);
    const capacity = Math.max(1, laneCounts.total);
    for (let i = 0; i < road.points.length - 1; i += 1) {
      const start = road.points[i];
      const end = road.points[i + 1];
      const startInside = isWithinBounds(start, bounds);
      const endInside = isWithinBounds(end, bounds);
      if (startInside === endInside) {
        continue;
      }
      const crossing = segmentBoundsIntersection(start, end, bounds, startInside);
      if (!crossing) {
        continue;
      }
      crossings.push({
        point: crossing.point,
        direction: crossing.direction,
        capacity
      });
    }
  }
  return crossings;
}

function segmentBoundsIntersection(
  start: LatLon,
  end: LatLon,
  bounds: { north: number; south: number; east: number; west: number },
  startInside: boolean
): { point: LatLon; direction: "north" | "south" | "east" | "west" } | null {
  const candidates: Array<{
    t: number;
    point: LatLon;
    direction: "north" | "south" | "east" | "west";
  }> = [];
  if (start.lat !== end.lat) {
    const tNorth = (bounds.north - start.lat) / (end.lat - start.lat);
    if (tNorth >= 0 && tNorth <= 1) {
      const lon = start.lon + (end.lon - start.lon) * tNorth;
      if (lon >= bounds.west && lon <= bounds.east) {
        candidates.push({ t: tNorth, point: { lat: bounds.north, lon }, direction: "north" });
      }
    }
    const tSouth = (bounds.south - start.lat) / (end.lat - start.lat);
    if (tSouth >= 0 && tSouth <= 1) {
      const lon = start.lon + (end.lon - start.lon) * tSouth;
      if (lon >= bounds.west && lon <= bounds.east) {
        candidates.push({ t: tSouth, point: { lat: bounds.south, lon }, direction: "south" });
      }
    }
  }
  if (start.lon !== end.lon) {
    const tEast = (bounds.east - start.lon) / (end.lon - start.lon);
    if (tEast >= 0 && tEast <= 1) {
      const lat = start.lat + (end.lat - start.lat) * tEast;
      if (lat >= bounds.south && lat <= bounds.north) {
        candidates.push({ t: tEast, point: { lat, lon: bounds.east }, direction: "east" });
      }
    }
    const tWest = (bounds.west - start.lon) / (end.lon - start.lon);
    if (tWest >= 0 && tWest <= 1) {
      const lat = start.lat + (end.lat - start.lat) * tWest;
      if (lat >= bounds.south && lat <= bounds.north) {
        candidates.push({ t: tWest, point: { lat, lon: bounds.west }, direction: "west" });
      }
    }
  }
  if (!candidates.length) {
    return null;
  }
  const insideT = startInside ? 0 : 1;
  candidates.sort((a, b) => Math.abs(a.t - insideT) - Math.abs(b.t - insideT));
  const best = candidates[0];
  return { point: best.point, direction: best.direction };
}

function pickTripEndpoints(
  preset: TrafficPresetName,
  context: TripEndpointContext
): { originId: string | null; destId: string | null } {
  const rng = context.rng;
  const isCentralTrip = rng() < context.centralShare;
  if (isCentralTrip) {
    const epicenterId = pickEpicenterNodeId(context.epicenters, context.nodes, rng);
    const localId = pickLocalNodeId(context.endpointPool, context.nodePools, context.nodes, rng);
    if (!epicenterId || !localId) {
      return { originId: null, destId: null };
    }
    if (preset === "am") {
      return { originId: localId, destId: epicenterId };
    }
    if (preset === "pm") {
      return { originId: epicenterId, destId: localId };
    }
    return rng() < 0.5
      ? { originId: epicenterId, destId: localId }
      : { originId: localId, destId: epicenterId };
  }
  const originId = pickBoundaryNodeId(context.boundaryNodes, context.nodePools, context.nodes, rng);
  const destId = pickBoundaryNodeId(
    context.boundaryNodes,
    context.nodePools,
    context.nodes,
    rng,
    originId
  );
  return { originId, destId };
}

function pickEpicenterNodeId(
  epicenters: EpicenterPool[],
  nodes: GraphNode[],
  rng: () => number
): string | null {
  if (epicenters.length) {
    const epicenter = pickWeightedEpicenter(epicenters, rng);
    const pool = epicenter.nodes.length ? epicenter.nodes : nodes;
    const node = pickRandomNode(pool, rng);
    if (node) {
      return node.id;
    }
  }
  const fallback = pickRandomNode(nodes, rng);
  return fallback?.id ?? null;
}

function pickWeightedEpicenter(epicenters: EpicenterPool[], rng: () => number): EpicenterPool {
  if (epicenters.length === 1) {
    return epicenters[0];
  }
  let total = 0;
  for (const epicenter of epicenters) {
    total += epicenter.weight;
  }
  const roll = rng() * (total > 0 ? total : epicenters.length);
  let running = 0;
  for (const epicenter of epicenters) {
    running += total > 0 ? epicenter.weight : 1;
    if (roll <= running) {
      return epicenter;
    }
  }
  return epicenters[epicenters.length - 1];
}

function pickLocalNodeId(
  endpointPool: EndpointPool,
  nodePools: NodePools,
  nodes: GraphNode[],
  rng: () => number
): string | null {
  if (endpointPool.nodeIds.length) {
    const idx = Math.floor(rng() * endpointPool.nodeIds.length);
    return endpointPool.nodeIds[Math.min(endpointPool.nodeIds.length - 1, Math.max(0, idx))];
  }
  const pool = nodePools.inside.length ? nodePools.inside : nodes;
  const fallback = pickRandomNode(pool, rng);
  return fallback?.id ?? null;
}

function pickBoundaryNodeId(
  boundaryNodes: GraphNode[],
  nodePools: NodePools,
  nodes: GraphNode[],
  rng: () => number,
  avoidId?: string | null
): string | null {
  const pool = boundaryNodes.length ? boundaryNodes : nodePools.outside.length ? nodePools.outside : nodes;
  if (!pool.length) {
    return null;
  }
  let node = pickRandomNode(pool, rng);
  if (avoidId && node?.id === avoidId && pool.length > 1) {
    node = pickRandomNode(pool, rng);
  }
  return node?.id ?? null;
}

function applyTrafficSignalDelays(
  graph: { edges: { id: string; from: string; to: string; weight: number }[]; nodeList: GraphNode[] },
  trafficSignals: TrafficSignal[] | undefined
): Map<string, number> {
  const delays = new Map<string, number>();
  if (!trafficSignals || trafficSignals.length === 0 || graph.nodeList.length === 0) {
    return delays;
  }
  const nodeSignalCounts = mapSignalCountsToNodes(graph.nodeList, trafficSignals);
  if (nodeSignalCounts.size === 0) {
    return delays;
  }
  for (const edge of graph.edges) {
    const count = (nodeSignalCounts.get(edge.from) ?? 0) + (nodeSignalCounts.get(edge.to) ?? 0);
    if (count <= 0) {
      continue;
    }
    const delay = count * SIGNAL_DELAY_SEC;
    delays.set(edge.id, delay);
    edge.weight += delay;
  }
  return delays;
}

function mapSignalCountsToNodes(nodes: GraphNode[], signals: TrafficSignal[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const signal of signals) {
    const nearest = findNearestNode(nodes, signal.location);
    if (!nearest || nearest.distanceM > SIGNAL_NODE_MAX_DIST_M) {
      continue;
    }
    counts.set(nearest.node.id, (counts.get(nearest.node.id) ?? 0) + 1);
  }
  return counts;
}

function buildEdgeTraffic(
  graph: {
    edges: {
      id: string;
      roadId: RoadId;
      from: string;
      to: string;
      lengthM: number;
      baseTimeS: number;
      speedMps: number;
    }[];
    nodes: Map<string, GraphNode>;
  },
  edgeCounts: Map<string, number>,
  signalDelayByEdge: Map<string, number>
): TrafficEdgeTraffic[] {
  const edgeTraffic: TrafficEdgeTraffic[] = [];
  for (const edge of graph.edges) {
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (!fromNode || !toNode) {
      continue;
    }
    const flow = edgeCounts.get(edge.id) ?? 0;
    const delay = signalDelayByEdge.get(edge.id) ?? 0;
    const dwellFactor = computeDwellFactor(edge.baseTimeS, delay);
    const speedMps =
      edge.baseTimeS + delay > 0 ? edge.lengthM / (edge.baseTimeS + delay) : edge.speedMps;
    edgeTraffic.push({
      edgeId: edge.id,
      roadId: edge.roadId,
      from: { lat: fromNode.lat, lon: fromNode.lon },
      to: { lat: toNode.lat, lon: toNode.lon },
      lengthM: edge.lengthM,
      flow,
      dwellFactor,
      speedMps: Number.isFinite(speedMps) ? speedMps : undefined
    });
  }
  return edgeTraffic;
}

function buildTrafficViewerSamples(
  graph: {
    edges: {
      id: string;
      from: string;
      to: string;
      lengthM: number;
      baseTimeS: number;
      speedMps: number;
    }[];
    nodes: Map<string, GraphNode>;
  },
  edgeCounts: Map<string, number>,
  signalDelayByEdge: Map<string, number>,
  frameBounds: { north: number; south: number; east: number; west: number }
): TrafficViewerSample[] {
  const samples: TrafficViewerSample[] = [];
  for (const edge of graph.edges) {
    const flow = edgeCounts.get(edge.id) ?? 0;
    if (flow <= 0) {
      continue;
    }
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (!fromNode || !toNode) {
      continue;
    }
    const midpoint = {
      lat: (fromNode.lat + toNode.lat) / 2,
      lon: (fromNode.lon + toNode.lon) / 2
    };
    if (!isWithinBounds(midpoint, frameBounds)) {
      continue;
    }
    const delay = signalDelayByEdge.get(edge.id) ?? 0;
    const dwellFactor = computeDwellFactor(edge.baseTimeS, delay);
    const weight = flow * dwellFactor;
    if (weight <= 0) {
      continue;
    }
    const steps = Math.max(1, Math.round(edge.lengthM / VIEWER_SAMPLE_SPACING_M));
    const heading = bearingDegrees(fromNode, toNode);
    const speedMps =
      edge.baseTimeS + delay > 0 ? edge.lengthM / (edge.baseTimeS + delay) : edge.speedMps;
    for (let i = 0; i < steps; i += 1) {
      const t = (i + 0.5) / steps;
      samples.push({
        lat: fromNode.lat + (toNode.lat - fromNode.lat) * t,
        lon: fromNode.lon + (toNode.lon - fromNode.lon) * t,
        heading,
        weight,
        speedMps: Number.isFinite(speedMps) ? speedMps : undefined
      });
    }
  }
  return samples;
}

function computeDwellFactor(baseTimeS: number, delayS: number): number {
  if (!Number.isFinite(baseTimeS) || baseTimeS <= 0 || !Number.isFinite(delayS) || delayS <= 0) {
    return 1;
  }
  return Math.max(1, 1 + delayS / baseTimeS);
}

function normalizeRoadClass(roadClass?: RoadClass): RoadClass | null {
  if (!roadClass || typeof roadClass !== "string") {
    return null;
  }
  return roadClass.toLowerCase() as RoadClass;
}

function isWithinBounds(
  point: { lat: number; lon: number },
  bounds: { north: number; south: number; east: number; west: number }
): boolean {
  return (
    point.lat <= bounds.north &&
    point.lat >= bounds.south &&
    point.lon >= bounds.west &&
    point.lon <= bounds.east
  );
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

function findNearestNode(
  nodes: GraphNode[],
  point: LatLon
): { node: GraphNode; distanceM: number } | null {
  let best: GraphNode | null = null;
  let bestDist = Infinity;
  for (const node of nodes) {
    const dist = haversineMeters(point.lat, point.lon, node.lat, node.lon);
    if (dist < bestDist) {
      bestDist = dist;
      best = node;
    }
  }
  return best ? { node: best, distanceM: bestDist } : null;
}

function metersPerDegreeLon(lat: number): number {
  return Math.max(1e-6, METERS_PER_DEG_LAT * Math.cos(toRad(lat)));
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
  return 6371000 * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function buildEmptyResult(
  roads: Road[],
  kRoutes: number,
  seed: number,
  startTime: number,
  trips: number
): TrafficSimResult {
  const roadTraffic: Record<RoadId, { hourlyScore: { forward: number[]; backward: number[] } }> = {};
  for (const road of roads) {
    roadTraffic[road.id] = {
      hourlyScore: { forward: zeroHours(), backward: zeroHours() },
    };
  }
  return {
    roadTraffic,
    edgeTraffic: [],
    viewerSamples: [],
    epicenters: [],
    meta: {
      trips,
      kRoutes,
      durationMs: Date.now() - startTime,
      seed,
      generatedAtIso: new Date().toISOString(),
    },
  };
}

function zeroHours(): number[] {
  return new Array(24).fill(0);
}

function normalizeSeed(seed?: number): number {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return seed | 0;
  }
  return 0x12345678;
}

function createRng(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t |= 0;
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(x: number, mean: number, sigma: number): number {
  const z = (x - mean) / sigma;
  return Math.exp(-0.5 * z * z);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
