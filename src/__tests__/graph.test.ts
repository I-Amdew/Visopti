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

  it("scales edge weights by lanes and class", () => {
    const roads: Road[] = [
      {
        id: "r1",
        class: "residential",
        lanes: 1,
        oneway: "yes",
        points: [
          { lat: 0, lon: 0, nodeId: "A1" },
          { lat: 0, lon: 0.001, nodeId: "A2" }
        ]
      },
      {
        id: "r2",
        class: "residential",
        lanes: 3,
        oneway: "yes",
        points: [
          { lat: 0, lon: 0, nodeId: "B1" },
          { lat: 0, lon: 0.001, nodeId: "B2" }
        ]
      },
      {
        id: "r3",
        class: "motorway",
        lanes: 3,
        oneway: "yes",
        points: [
          { lat: 0, lon: 0, nodeId: "C1" },
          { lat: 0, lon: 0.001, nodeId: "C2" }
        ]
      }
    ];

    const graph = buildGraph(roads, { coordPrecision: 6 });
    const weight1 = graph.edges.find((edge) => edge.roadId === "r1")?.weight ?? 0;
    const weight2 = graph.edges.find((edge) => edge.roadId === "r2")?.weight ?? 0;
    const weight3 = graph.edges.find((edge) => edge.roadId === "r3")?.weight ?? 0;

    expect(weight1).toBeGreaterThan(0);
    expect(weight2).toBeGreaterThan(0);
    expect(weight3).toBeGreaterThan(0);
    expect(weight2).toBeLessThan(weight1);
    expect(weight3).toBeLessThan(weight2);
  });

  it("classifies turn movements at intersections", () => {
    const roads: Road[] = [
      {
        id: "in",
        class: "residential",
        oneway: "yes",
        points: [
          { lat: -0.001, lon: 0, nodeId: "A" },
          { lat: 0, lon: 0, nodeId: "B" }
        ]
      },
      {
        id: "straight",
        class: "residential",
        oneway: "yes",
        points: [
          { lat: 0, lon: 0, nodeId: "B" },
          { lat: 0.001, lon: 0, nodeId: "C" }
        ]
      },
      {
        id: "right",
        class: "residential",
        oneway: "yes",
        points: [
          { lat: 0, lon: 0, nodeId: "B" },
          { lat: 0, lon: 0.001, nodeId: "D" }
        ]
      },
      {
        id: "left",
        class: "residential",
        oneway: "yes",
        points: [
          { lat: 0, lon: 0, nodeId: "B" },
          { lat: 0, lon: -0.001, nodeId: "E" }
        ]
      }
    ];

    const graph = buildGraph(roads, { coordPrecision: 6 });
    const inEdge = graph.edges.find((edge) => edge.roadId === "in");
    const straightEdge = graph.edges.find((edge) => edge.roadId === "straight");
    const rightEdge = graph.edges.find((edge) => edge.roadId === "right");
    const leftEdge = graph.edges.find((edge) => edge.roadId === "left");

    expect(inEdge).toBeTruthy();
    expect(straightEdge).toBeTruthy();
    expect(rightEdge).toBeTruthy();
    expect(leftEdge).toBeTruthy();

    const straightMove = graph.movementByEdgePair.get(`${inEdge?.id}|${straightEdge?.id}`);
    const rightMove = graph.movementByEdgePair.get(`${inEdge?.id}|${rightEdge?.id}`);
    const leftMove = graph.movementByEdgePair.get(`${inEdge?.id}|${leftEdge?.id}`);

    expect(straightMove?.turn).toBe("straight");
    expect(rightMove?.turn).toBe("right");
    expect(leftMove?.turn).toBe("left");
  });
});
