import { describe, expect, it } from "vitest";
import { deserializeProject, serializeProject } from "../project";
import type { Building } from "../types";

describe("building overrides serialization", () => {
  it("roundtrips user overrides with inferred heights", () => {
    const { state } = deserializeProject({});
    const building: Building = {
      id: "building-1",
      footprint: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 }
      ],
      inferredHeightMeters: 10,
      heightSource: "osm_height",
      confidence: 0.9,
      userOverrideMeters: 15,
      effectiveHeightMeters: 15
    };
    state.autoBuildings = [building];

    const payload = serializeProject(state);
    const restored = deserializeProject(payload).state;
    const restoredBuilding = restored.autoBuildings?.[0];

    expect(restoredBuilding?.userOverrideMeters).toBeCloseTo(15, 3);
    expect(restoredBuilding?.effectiveHeightMeters).toBeCloseTo(15, 3);
    expect(restoredBuilding?.inferredHeightMeters).toBeCloseTo(10, 3);
    expect(restoredBuilding?.heightSource).toBe("osm_height");
  });
});
