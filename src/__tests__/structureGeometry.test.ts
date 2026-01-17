import { describe, expect, it } from "vitest";
import { findClosestEdgeIndex, polygonArea, polygonPerimeter } from "../structureGeometry";

describe("structure geometry", () => {
  it("computes area and perimeter for a square", () => {
    const square = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 }
    ];
    expect(polygonArea(square)).toBeCloseTo(4, 5);
    expect(polygonPerimeter(square)).toBeCloseTo(8, 5);
  });

  it("selects the nearest edge within a threshold", () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 0, y: 2 }
    ];
    const hit = findClosestEdgeIndex(rect, { x: 2, y: -0.4 }, 1);
    expect(hit?.index).toBe(0);
    const miss = findClosestEdgeIndex(rect, { x: 10, y: 10 }, 1);
    expect(miss).toBeNull();
  });
});
