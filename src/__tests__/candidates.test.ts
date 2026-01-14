import { describe, it, expect } from "vitest";
import { createGeoProjector } from "../geo";
import { buildCandidateRegionsFromShapes } from "../world/candidates";
import type { Shape } from "../types";

describe("buildCandidateRegionsFromShapes", () => {
  it("creates stable candidate regions from shapes", () => {
    const projector = createGeoProjector(
      { north: 1, south: 0, east: 1, west: 0 },
      { width: 100, height: 100 }
    );
    const shape: Shape = {
      id: "cand-1",
      name: "Zone A",
      type: "candidate",
      kind: "polygon",
      alpha: 0.6,
      visible: true,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 20, y: 20 },
        { x: 10, y: 20 }
      ]
    };

    const first = buildCandidateRegionsFromShapes([shape], projector);
    const second = buildCandidateRegionsFromShapes([shape], projector);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    const region = first[0];
    expect(region.id).toBe("cand-1");
    expect(region.name).toBe("Zone A");
    expect(region.visible).toBe(true);
    expect(region.polygon).toHaveLength(shape.points.length);
    expect(region.areaM2).toBeGreaterThan(0);
    expect(region.perimeterM).toBeGreaterThan(0);

    expect(second[0].areaM2).toBeCloseTo(region.areaM2, 5);
    expect(second[0].perimeterM).toBeCloseTo(region.perimeterM, 5);
  });
});
