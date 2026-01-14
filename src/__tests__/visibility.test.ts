import { describe, it, expect } from "vitest";
import {
  buildCombinedHeightGrid,
  computeVisibilityHeatmap,
  isVisible,
  segmentBlockedByObstacle
} from "../visibility";
import { createGeoReference, GeoMapper, type ElevationGrid } from "../geo";
import type { AppSettings, Building, CandidateSample, Shape, Sign, Tree, ViewerSample } from "../types";

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

function makeViewer(mapper: GeoMapper, lat: number, lon: number): ViewerSample {
  const pixel = mapper.latLonToPixel(lat, lon);
  const elevationM = mapper.latLonToElevation(lat, lon);
  return { pixel, lat, lon, elevationM };
}

function makeCandidate(mapper: GeoMapper, lat: number, lon: number): CandidateSample {
  const pixel = mapper.latLonToPixel(lat, lon);
  const elevationM = mapper.latLonToElevation(lat, lon);
  return { pixel, lat, lon, elevationM };
}

describe("segmentBlockedByObstacle", () => {
  it("detects intersections with obstacle shapes", () => {
    const obstacle: Shape = {
      id: "obs-1",
      name: "Obstacle 1",
      type: "obstacle",
      alpha: 1,
      visible: true,
      kind: "rect",
      x: 4,
      y: 4,
      width: 2,
      height: 2
    };
    const blocked = segmentBlockedByObstacle({ x: 0, y: 0 }, { x: 10, y: 10 }, [obstacle]);
    const clear = segmentBlockedByObstacle({ x: 0, y: 0 }, { x: 2, y: 2 }, [obstacle]);
    expect(blocked).toBe(true);
    expect(clear).toBe(false);
  });
});

describe("buildCombinedHeightGrid", () => {
  it("stamps terrain + obstacle heights", () => {
    const mapper = buildMapper([
      [0, 0, 0],
      [0, 2, 0],
      [0, 0, 0]
    ]);
    const building: Building = {
      id: "b1",
      footprint: [
        { lat: 0.5, lon: 0.5 },
        { lat: 0.5, lon: 1.5 },
        { lat: 1.5, lon: 1.5 },
        { lat: 1.5, lon: 0.5 }
      ],
      height: 10
    };
    const tree: Tree = {
      id: "t1",
      location: { lat: 0, lon: 0 },
      type: "deciduous",
      baseRadiusMeters: 0.1,
      heightMeters: 5,
      heightSource: "user_override"
    };
    const sign: Sign = {
      id: "s1",
      location: { lat: 2, lon: 2 },
      kind: "sign",
      widthMeters: 1,
      heightMeters: 2,
      bottomClearanceMeters: 1,
      yawDegrees: 0,
      heightSource: "default"
    };

    const combined = buildCombinedHeightGrid(mapper, {
      buildings: [building],
      trees: [tree],
      signs: [sign],
      obstacles: []
    });

    expect(combined.values[1][1]).toBeCloseTo(12, 3);
    expect(combined.values[0][0]).toBeCloseTo(5, 3);
    expect(combined.values[2][2]).toBeCloseTo(3, 3);
  });
});

describe("isVisible", () => {
  it("blocks when occlusion exceeds the line", () => {
    const mapper = buildMapper([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]);
    const combined = buildCombinedHeightGrid(mapper, {});
    combined.values[1][1] = 50;

    const viewer = makeViewer(mapper, 0, 0);
    const candidate = makeCandidate(mapper, 2, 2);

    const visible = isVisible(viewer, candidate, 2, 2, combined, mapper);
    expect(visible).toBe(false);
  });

  it("returns true over flat terrain", () => {
    const mapper = buildMapper([
      [0, 0],
      [0, 0]
    ]);
    const combined = buildCombinedHeightGrid(mapper, {});
    const viewer = makeViewer(mapper, 0, 0);
    const candidate = makeCandidate(mapper, 1, 0);
    const visible = isVisible(viewer, candidate, 2, 2, combined, mapper);
    expect(visible).toBe(true);
  });
});

describe("computeVisibilityHeatmap", () => {
  it("normalizes visibility into 0..1 scores", () => {
    const mapper = buildMapper([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]);
    const settings = makeSettings();
    const viewer = makeViewer(mapper, 0, 0);
    const blockedCandidate = makeCandidate(mapper, 2, 2);
    const clearCandidate = makeCandidate(mapper, 0, 2);
    const combined = buildCombinedHeightGrid(mapper, {});
    combined.values[1][1] = 50;

    const cells = computeVisibilityHeatmap(
      [viewer],
      [blockedCandidate, clearCandidate],
      combined,
      settings,
      mapper
    );

    expect(cells).toHaveLength(2);
    expect(cells[0].score).toBe(0);
    expect(cells[1].score).toBe(1);
  });
});
