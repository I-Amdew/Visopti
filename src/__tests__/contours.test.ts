import { describe, it, expect } from "vitest";
import { generateContourSegments } from "../contours";
import { createGeoReference, GeoMapper, type ElevationGrid } from "../geo";

function buildMapper(values: number[][]): GeoMapper {
  const rows = values.length;
  const cols = values[0].length;
  const latitudes = Array.from({ length: rows }, (_, idx) => idx);
  const longitudes = Array.from({ length: cols }, (_, idx) => idx);
  const flat = values.flat();
  const minElevation = Math.min(...flat);
  const maxElevation = Math.max(...flat);
  const grid: ElevationGrid = {
    rows,
    cols,
    latitudes,
    longitudes,
    values,
    latAscending: true,
    lonAscending: true,
    minElevation,
    maxElevation
  };
  const bounds = {
    north: rows - 1,
    south: 0,
    east: cols - 1,
    west: 0
  };
  const geo = createGeoReference(bounds, { width: 100, height: 100 });
  return new GeoMapper(geo, grid);
}

describe("generateContourSegments", () => {
  it("emits segments at expected contour levels for a simple slope", () => {
    const mapper = buildMapper([
      [0, 0],
      [10, 10]
    ]);
    const segments = generateContourSegments(mapper, 10);
    expect(segments).toHaveLength(3);
    const levels = segments.map((segment) => segment.level).sort((a, b) => a - b);
    expect(levels[0]).toBeCloseTo(10, 4);
    expect(levels[1]).toBeCloseTo(20, 4);
    expect(levels[2]).toBeCloseTo(30, 4);
    for (const segment of segments) {
      const length = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
      expect(length).toBeGreaterThan(0);
    }
  });
});
