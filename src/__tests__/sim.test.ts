import { describe, it, expect } from "vitest";
import { buildGraph } from "../traffic/graph";
import { resolveLaneCounts } from "../traffic/lanes";
import { buildTrafficViewerSamples } from "../traffic/sim";
import type { Road } from "../traffic/types";

describe("traffic viewer samples", () => {
  it("creates smoothly changing headings for turn arcs", () => {
    const roads: Road[] = [
      {
        id: "in",
        class: "residential",
        oneway: "yes",
        points: [
          { lat: 0, lon: 0, nodeId: "A" },
          { lat: 0, lon: 0.001, nodeId: "B" }
        ]
      },
      {
        id: "out",
        class: "residential",
        oneway: "yes",
        points: [
          { lat: 0, lon: 0.001, nodeId: "B" },
          { lat: 0.001, lon: 0.001, nodeId: "C" }
        ]
      }
    ];

    const graph = buildGraph(roads, { coordPrecision: 6 });
    const inEdge = graph.edges.find((edge) => edge.roadId === "in");
    const outEdge = graph.edges.find((edge) => edge.roadId === "out");
    expect(inEdge).toBeTruthy();
    expect(outEdge).toBeTruthy();

    const laneCountsByRoad = new Map(
      roads.map((road) => {
        const counts = resolveLaneCounts(road);
        return [road.id, { forward: counts.forward, backward: counts.backward, total: counts.total }];
      })
    );

    const edgeCounts = new Map<string, number>();
    edgeCounts.set(inEdge!.id, 10);
    edgeCounts.set(outEdge!.id, 10);

    const movementCounts = new Map<string, number>();
    movementCounts.set(`${inEdge!.id}|${outEdge!.id}`, 10);

    const samples = buildTrafficViewerSamples(
      graph,
      roads,
      laneCountsByRoad,
      edgeCounts,
      movementCounts,
      new Map(),
      { north: 1, south: -1, east: 1, west: -1 }
    );

    const turnSamples = samples.filter((sample) => sample.laneType === "turn_left");
    expect(turnSamples.length).toBeGreaterThan(2);
    const headings = turnSamples.map((sample) => sample.headingDeg);
    const min = Math.min(...headings);
    const max = Math.max(...headings);
    expect(max - min).toBeGreaterThan(10);
  });
});
