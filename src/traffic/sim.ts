import { buildGraph, GraphNode } from "./graph";
import {
  BuildingEndpointIndex,
  buildBuildingEndpointIndex,
  pickBuildingNode,
  pickEpicenterNodes,
  pickRandomNode,
} from "./endpoints";
import { findTopKPaths } from "./routing";
import {
  Road,
  RoadId,
  TrafficPresetName,
  TrafficSimProgress,
  TrafficSimRequest,
  TrafficSimResult,
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

export function simulateTraffic(request: TrafficSimRequest, options: SimOptions = {}): TrafficSimResult {
  const startTime = Date.now();
  const roads = request.roads ?? [];
  const config = request.config;
  const seed = normalizeSeed(request.seed);
  const rng = createRng(seed);
  const kRoutes = Math.max(1, Math.round(config.kRoutes ?? 3));
  const presets = request.presets && request.presets.length ? request.presets : DEFAULT_PRESETS;

  const graph = buildGraph(roads);
  options.onProgress?.({ phase: "graph", completed: 1, total: 1 });

  if (graph.edges.length === 0 || graph.nodeList.length === 0) {
    console.warn("Traffic sim: empty graph");
    return buildEmptyResult(roads, kRoutes, seed, startTime, 0);
  }

  const epicenterNodes = pickEpicenterNodes(
    graph.nodeList,
    config.epicenter,
    Math.max(0, config.epicenterRadiusM)
  );

  const buildingIndex = buildBuildingEndpointIndex(request.buildings, graph.nodeList);
  options.onProgress?.({ phase: "endpoints", completed: 1, total: 1 });

  if (!epicenterNodes.length) {
    console.warn("Traffic sim: no epicenter nodes within radius; falling back to random nodes.");
  }
  if (!buildingIndex.nodeIds.length) {
    console.warn("Traffic sim: no building endpoints; falling back to random nodes.");
  }

  const baseTripCount = config.tripCount ?? estimateTripCount(roads.length, request.detailLevel ?? 1);
  const tripCount = clamp(Math.round(baseTripCount), 50, 12000);

  const countsByPreset = new Map<TrafficPresetName, Map<RoadId, DirectionCounts>>();
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
      const originId = pickOriginNodeId(preset, epicenterNodes, buildingIndex, graph.nodeList, rng);
      const destId = pickDestinationNodeId(preset, epicenterNodes, buildingIndex, graph.nodeList, rng);
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
          if (edge.forward) {
            record.forward += pathWeight;
          } else {
            record.backward += pathWeight;
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

  const durationMs = Date.now() - startTime;
  return {
    roadTraffic,
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

function estimateTripCount(roadCount: number, detailLevel: number): number {
  const base = Math.max(200, Math.round(roadCount * 1.2));
  const scale = clamp(detailLevel, 0.25, 3);
  return base * scale;
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

function pickOriginNodeId(
  preset: TrafficPresetName,
  epicenterNodes: GraphNode[],
  buildingIndex: BuildingEndpointIndex,
  nodes: GraphNode[],
  rng: () => number
): string | null {
  if (preset === "pm") {
    return pickEpicenterNodeId(epicenterNodes, nodes, rng);
  }
  return pickBuildingNodeId(buildingIndex, nodes, rng);
}

function pickDestinationNodeId(
  preset: TrafficPresetName,
  epicenterNodes: GraphNode[],
  buildingIndex: BuildingEndpointIndex,
  nodes: GraphNode[],
  rng: () => number
): string | null {
  if (preset === "am") {
    return pickEpicenterNodeId(epicenterNodes, nodes, rng);
  }
  if (preset === "pm") {
    return pickBuildingNodeId(buildingIndex, nodes, rng);
  }
  return pickBuildingNodeId(buildingIndex, nodes, rng);
}

function pickEpicenterNodeId(
  epicenterNodes: GraphNode[],
  nodes: GraphNode[],
  rng: () => number
): string | null {
  if (epicenterNodes.length) {
    const node = pickRandomNode(epicenterNodes, rng);
    return node?.id ?? null;
  }
  const fallback = pickRandomNode(nodes, rng);
  return fallback?.id ?? null;
}

function pickBuildingNodeId(
  buildingIndex: BuildingEndpointIndex,
  nodes: GraphNode[],
  rng: () => number
): string | null {
  const buildingNode = pickBuildingNode(buildingIndex, rng);
  if (buildingNode) {
    return buildingNode;
  }
  const fallback = pickRandomNode(nodes, rng);
  return fallback?.id ?? null;
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
