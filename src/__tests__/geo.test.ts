import { describe, it, expect } from "vitest";
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

describe("GeoMapper", () => {
  it("interpolates elevation at the center of a grid cell", () => {
    const mapper = buildMapper([
      [0, 10],
      [20, 30]
    ]);
    const elevation = mapper.latLonToElevation(0.5, 0.5);
    expect(elevation).toBeCloseTo(15, 6);
  });

  it("clamps grid coordinates to bounds", () => {
    const mapper = buildMapper([
      [0, 0],
      [0, 0]
    ]);
    const coords = mapper.latLonToGridCoords(2, -1);
    expect(coords.row).toBeCloseTo(1, 6);
    expect(coords.col).toBeCloseTo(0, 6);
  });
});
