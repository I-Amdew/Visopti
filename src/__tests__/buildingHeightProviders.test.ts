import { describe, expect, it } from "vitest";
import { resolveBuildingHeights, type BuildingHeightProvider } from "../world/height";
import type { Building } from "../types";

const makeBuilding = (id: string): Building => ({
  id,
  footprint: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 }
  ]
});

describe("resolveBuildingHeights", () => {
  it("prefers earlier providers and fills missing entries", async () => {
    const buildings = [makeBuilding("a"), makeBuilding("b")];
    const primary: BuildingHeightProvider = {
      getHeights: async () =>
        new Map([
          [
            "a",
            { heightMeters: 12, confidence: 0.85, source: "external_api" }
          ]
        ])
    };
    const fallback: BuildingHeightProvider = {
      getHeights: async () =>
        new Map([
          [
            "a",
            { heightMeters: 5, confidence: 0.2, source: "osm_height" }
          ],
          [
            "b",
            { heightMeters: 7, confidence: 0.6, source: "osm_levels" }
          ]
        ])
    };

    const results = await resolveBuildingHeights(buildings, {}, [primary, fallback]);

    expect(results.get("a")?.heightMeters).toBeCloseTo(12, 3);
    expect(results.get("a")?.source).toBe("external_api");
    expect(results.get("b")?.heightMeters).toBeCloseTo(7, 3);
    expect(results.get("b")?.source).toBe("osm_levels");
  });
});
