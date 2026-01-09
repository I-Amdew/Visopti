import { describe, it, expect } from "vitest";
import { buildGraph } from "../traffic/graph";
import type { Road } from "../traffic/types";

describe("buildGraph", () => {
  it("creates directed edges based on oneway settings", () => {
    const roads: Road[] = [
      {
        id: "r1",
        class: "residential",
        oneway: "yes",
        points: [
          { lat: 0, lon: 0, nodeId: "A" },
          { lat: 0, lon: 0.001, nodeId: "B" }
        ]
      },
      {
        id: "r2",
        class: "residential",
        oneway: "no",
        points: [
          { lat: 0, lon: 0.001, nodeId: "B" },
          { lat: 0.001, lon: 0.001, nodeId: "C" }
        ]
      },
      {
        id: "r3",
        class: "residential",
        oneway: "-1",
        points: [
          { lat: 0.001, lon: 0.001, nodeId: "C" },
          { lat: 0.001, lon: 0, nodeId: "D" }
        ]
      }
    ];

    const graph = buildGraph(roads, { coordPrecision: 6 });

    expect(graph.edges).toHaveLength(4);
    expect(graph.edges.filter((edge) => edge.forward)).toHaveLength(2);
    expect(graph.edges.filter((edge) => !edge.forward)).toHaveLength(2);

    const fromA = graph.adjacency.get("osm:A");
    const fromC = graph.adjacency.get("osm:C");
    const fromD = graph.adjacency.get("osm:D");

    expect(fromA).toHaveLength(1);
    expect(fromA?.[0].to).toBe("osm:B");
    expect(fromC).toHaveLength(1);
    expect(fromC?.[0].to).toBe("osm:B");
    expect(fromD).toHaveLength(1);
    expect(fromD?.[0].to).toBe("osm:C");
  });
});
