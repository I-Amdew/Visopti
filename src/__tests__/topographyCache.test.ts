import { describe, it, expect } from "vitest";
import { buildElevationCacheKey, TopographyCache } from "../topographyCache";

describe("topography cache", () => {
  it("rounds cache keys to 5 decimals", () => {
    const key = buildElevationCacheKey("open-meteo", 47.6062349, -122.3321199);
    expect(key).toBe("open-meteo:47.60623:-122.33212");
  });

  it("stores and retrieves values in memory", () => {
    const cache = new TopographyCache({ enablePersistence: false, maxEntries: 10 });
    cache.setMany([
      { key: "open-meteo:1.00000:2.00000", value: 123 },
      { key: "open-meteo:3.00000:4.00000", value: 456 }
    ]);
    const hits = cache.getMany([
      "open-meteo:1.00000:2.00000",
      "open-meteo:3.00000:4.00000",
      "open-meteo:5.00000:6.00000"
    ]);
    expect(hits.get("open-meteo:1.00000:2.00000")).toBe(123);
    expect(hits.get("open-meteo:3.00000:4.00000")).toBe(456);
    expect(hits.has("open-meteo:5.00000:6.00000")).toBe(false);
  });
});
