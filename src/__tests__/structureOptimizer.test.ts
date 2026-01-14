import { describe, expect, it } from "vitest";
import type { AppSettings, ViewerSample } from "../types";
import { createGeoReference, GeoMapper, type ElevationGrid } from "../geo";
import { buildCombinedHeightGrid } from "../visibility";
import { buildRectFootprintTemplate, optimizeStructurePlacement } from "../structureOptimizer";

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

function makeSettings(): AppSettings {
  return {
    siteHeightFt: 6,
    viewerHeightFt: 6,
    viewDistanceFt: 0,
    topoSpacingFt: 10,
    sampleStepPx: 10,
    frame: {
      maxSideFt: 2640,
      minSideFt: 300
    },
    overlays: {
      showViewers: true,
      showCandidates: true,
      showObstacles: true,
      showContours: true
    },
    opacity: {
      viewer: 1,
      candidate: 1,
      obstacle: 1,
      heatmap: 1,
      shading: 1,
      contours: 1
    }
  };
}

function makeViewer(mapper: GeoMapper, pixel: { x: number; y: number }): ViewerSample {
  const { lat, lon } = mapper.pixelToLatLon(pixel.x, pixel.y);
  const elevationM = mapper.latLonToElevation(lat, lon);
  return { pixel, lat, lon, elevationM, weight: 1 };
}

describe("optimizeStructurePlacement", () => {
  it("prefers the pinned face orientation", () => {
    const mapper = buildMapper([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0]
    ]);
    const settings = makeSettings();
    const combined = buildCombinedHeightGrid(mapper, {});
    const viewer = makeViewer(mapper, { x: 50, y: 10 });
    const candidates = [
      {
        id: "candidate-1",
        points: [
          { x: 10, y: 10 },
          { x: 90, y: 10 },
          { x: 90, y: 90 },
          { x: 10, y: 90 }
        ]
      }
    ];
    const footprintTemplate = buildRectFootprintTemplate(20, 30);
    const result = optimizeStructurePlacement({
      footprintTemplate,
      heightM: 10,
      candidates,
      viewers: [viewer],
      combinedGrid: combined,
      mapper,
      settings,
      pinnedFaceId: 0,
      rotationStepDeg: 30,
      rotationRefineStepDeg: 5,
      placementSamples: 4
    });

    expect(result).not.toBeNull();
    const rotation = result ? result.placement.rotationDeg : 0;
    const normalized = ((rotation % 360) + 360) % 360;
    expect(normalized < 5 || normalized > 355).toBe(true);
  });
});
