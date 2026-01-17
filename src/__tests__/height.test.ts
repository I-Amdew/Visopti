import { describe, it, expect } from "vitest";
import { resolveBuildingHeightInfo } from "../world/height";

describe("resolveBuildingHeightInfo", () => {
  it("prefers explicit height tags", () => {
    const info = resolveBuildingHeightInfo({ tags: { height: "10 m" } });
    expect(info.heightSource).toBe("osm_height");
    expect(info.inferredHeightMeters).toBeCloseTo(10, 3);
    expect(info.confidence).toBeCloseTo(0.9, 3);
    expect(info.effectiveHeightMeters).toBeCloseTo(10, 3);
  });

  it("uses building levels when height is missing", () => {
    const info = resolveBuildingHeightInfo({ tags: { "building:levels": "2" } });
    expect(info.heightSource).toBe("osm_levels");
    expect(info.inferredHeightMeters).toBeCloseTo(6, 3);
    expect(info.confidence).toBeCloseTo(0.6, 3);
  });

  it("falls back to default levels", () => {
    const info = resolveBuildingHeightInfo({});
    expect(info.heightSource).toBe("default");
    expect(info.inferredHeightMeters).toBeCloseTo(3, 3);
  });

  it("applies user overrides", () => {
    const info = resolveBuildingHeightInfo({
      tags: { height: "8 m" },
      userOverrideMeters: 12
    });
    expect(info.heightSource).toBe("osm_height");
    expect(info.effectiveHeightMeters).toBeCloseTo(12, 3);
    expect(info.userOverrideMeters).toBeCloseTo(12, 3);
  });

  it("captures min height when present", () => {
    const info = resolveBuildingHeightInfo({ tags: { min_height: "5 ft" } });
    expect(info.minHeightMeters).toBeCloseTo(1.524, 3);
  });
});
