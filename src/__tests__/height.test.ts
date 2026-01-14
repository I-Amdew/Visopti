import { describe, it, expect } from "vitest";
import { inferBuildingHeightInfo } from "../world/height";

describe("inferBuildingHeightInfo", () => {
  it("prefers explicit height tags", () => {
    const info = inferBuildingHeightInfo({ tags: { height: "10 m" } });
    expect(info.inferredHeightSource).toBe("osm_height");
    expect(info.inferredHeightMeters).toBeCloseTo(10, 3);
    expect(info.heightSource).toBe("osm_height");
    expect(info.effectiveHeightMeters).toBeCloseTo(10, 3);
  });

  it("uses building levels when height is missing", () => {
    const info = inferBuildingHeightInfo({ tags: { "building:levels": "2" } });
    expect(info.inferredHeightSource).toBe("osm_levels");
    expect(info.inferredHeightMeters).toBeCloseTo(6, 3);
  });

  it("falls back to default levels", () => {
    const info = inferBuildingHeightInfo({});
    expect(info.inferredHeightSource).toBe("default");
    expect(info.inferredHeightMeters).toBeCloseTo(3, 3);
  });

  it("applies user overrides", () => {
    const info = inferBuildingHeightInfo({
      tags: { height: "8 m" },
      userHeightMeters: 12
    });
    expect(info.inferredHeightSource).toBe("osm_height");
    expect(info.heightSource).toBe("user_override");
    expect(info.effectiveHeightMeters).toBeCloseTo(12, 3);
  });

  it("captures min height when present", () => {
    const info = inferBuildingHeightInfo({ tags: { min_height: "5 ft" } });
    expect(info.minHeightMeters).toBeCloseTo(1.524, 3);
  });
});
