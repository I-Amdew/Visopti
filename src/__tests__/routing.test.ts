import { describe, it, expect } from "vitest";
import { findTopKPaths, shortestPath } from "../traffic/routing";
import type { Graph, GraphEdge, GraphNode } from "../traffic/graph";

describe("routing", () => {
  const nodes = new Map<string, GraphNode>([
    ["A", { id: "A", lat: 0, lon: 0 }],
    ["B", { id: "B", lat: 0, lon: 0 }],
    ["C", { id: "C", lat: 0, lon: 0 }]
  ]);

  const edges: GraphEdge[] = [
    { id: "A-B", from: "A", to: "B", roadId: "r1", lengthM: 100, weight: 1, forward: true },
    { id: "A-C", from: "A", to: "C", roadId: "r2", lengthM: 100, weight: 1, forward: true },
    { id: "C-B", from: "C", to: "B", roadId: "r2", lengthM: 100, weight: 1.5, forward: true }
  ];

  const adjacency = new Map<string, GraphEdge[]>([
    ["A", [edges[0], edges[1]]],
    ["C", [edges[2]]]
  ]);

  const graph: Graph = { nodes, edges, adjacency, nodeList: Array.from(nodes.values()) };

  it("returns the shortest path by total weight", () => {
    const path = shortestPath(graph, "A", "B");
    expect(path).not.toBeNull();
    expect(path?.edges).toHaveLength(1);
    expect(path?.edges[0].id).toBe("A-B");
    expect(path?.totalWeight).toBe(1);
  });

  it("finds multiple unique paths", () => {
    const paths = findTopKPaths(graph, "A", "B", 2, { penaltyFactor: 2 });
    const signatures = paths.map((path) => path.edges.map((edge) => edge.id).join("|"));
    expect(paths).toHaveLength(2);
    expect(new Set(signatures).size).toBe(2);
  });
});
