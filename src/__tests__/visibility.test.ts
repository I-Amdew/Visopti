import { describe, it, expect } from "vitest";
import {
  computeVisibilityHeatmap,
  lineOfSightFraction,
  segmentBlockedByObstacle
} from "../visibility";
import { createGeoReference, GeoMapper, type ElevationGrid } from "../geo";
import type { AppSettings, CandidateSample, Shape, ViewerSample } from "../types";

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
    topoSpacingFt: 10,
    sampleStepPx: 10,
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

function makeViewer(mapper: GeoMapper, x: number, y: number): ViewerSample {
  const { lat, lon } = mapper.pixelToLatLon(x, y);
  const elevationM = mapper.latLonToElevation(lat, lon);
  return { pixel: { x, y }, lat, lon, elevationM };
}

function makeCandidate(mapper: GeoMapper, x: number, y: number): CandidateSample {
  const { lat, lon } = mapper.pixelToLatLon(x, y);
  const elevationM = mapper.latLonToElevation(lat, lon);
  return { pixel: { x, y }, lat, lon, elevationM };
}

describe("segmentBlockedByObstacle", () => {
  it("detects intersections with obstacle shapes", () => {
    const obstacle: Shape = {
      id: "obs-1",
      type: "obstacle",
      alpha: 1,
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

describe("lineOfSightFraction", () => {
  it("returns full visibility over flat terrain", () => {
    const mapper = buildMapper([
      [0, 0],
      [0, 0]
    ]);
    const viewer = makeViewer(mapper, 10, 10);
    const candidate = makeCandidate(mapper, 90, 10);
    const settings = makeSettings();
    const fraction = lineOfSightFraction(
      viewer,
      candidate,
      settings,
      mapper,
      [],
      [],
      settings.siteHeightFt
    );
    expect(fraction).toBe(1);
  });
});

describe("computeVisibilityHeatmap", () => {
  it("normalizes viewer counts into 0..1 scores", () => {
    const mapper = buildMapper([
      [0, 0],
      [0, 0]
    ]);
    const settings = makeSettings();
    const viewer = makeViewer(mapper, 10, 10);
    const obstacle: Shape = {
      id: "obs-2",
      type: "obstacle",
      alpha: 1,
      kind: "rect",
      x: 40,
      y: 40,
      width: 20,
      height: 20
    };
    const blockedCandidate = makeCandidate(mapper, 90, 90);
    const clearCandidate = makeCandidate(mapper, 90, 10);

    const cells = computeVisibilityHeatmap(
      [viewer],
      [blockedCandidate, clearCandidate],
      [obstacle],
      settings,
      mapper
    );

    expect(cells).toHaveLength(2);
    expect(cells[0].score).toBe(0);
    expect(cells[1].score).toBe(1);
  });
});
