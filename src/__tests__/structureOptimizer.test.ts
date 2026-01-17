import { describe, expect, it } from "vitest";
import type { AppSettings, ViewerSample } from "../types";
import { createGeoReference, GeoMapper, type ElevationGrid } from "../geo";
import { buildCombinedHeightGrid } from "../visibility";
import { deserializeProject } from "../project";
import {
  buildRectFootprintTemplate,
  optimizeStructurePlacement,
  resolveFacePriorityIndices
} from "../structureOptimizer";

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
    forestK: 0.04,
    denseCoverDensity: 0.6,
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
  it("prefers the prioritized face arc orientation", () => {
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
      facePriority: { primaryEdgeIndex: 0, arcDeg: 180 },
      rotationStepDeg: 30,
      rotationRefineStepDeg: 5,
      placementSamples: 4
    });

    expect(result).not.toBeNull();
    const faceCount = result ? result.placement.faceScores.length : 0;
    const expectedIds = resolveFacePriorityIndices(faceCount, {
      primaryEdgeIndex: 0,
      arcDeg: 180
    });
    const prioritized = result
      ? result.placement.faceScores.filter((entry) => expectedIds.includes(entry.face.id))
      : [];
    const expectedScore =
      prioritized.reduce((sum, entry) => sum + entry.score, 0) /
      Math.max(1, prioritized.length);
    expect(result?.placement.totalScore).toBeCloseTo(expectedScore, 5);
  });
});

describe("structure migration", () => {
  it("migrates legacy rectangle footprints to polygon points", () => {
    const project = {
      schemaVersion: 3,
      structure: {
        heightFt: 24,
        footprint: { widthFt: 40, lengthFt: 60 },
        placeAtCenter: true,
        centerPx: { x: 100, y: 120 },
        rotationDeg: 15
      }
    };
    const { state } = deserializeProject(project);
    const points = state.structure?.footprint.points ?? [];
    expect(points).toHaveLength(4);
    expect(points[0].x).toBeCloseTo(-6.096, 3);
    expect(points[0].y).toBeCloseTo(-9.144, 3);
    expect(points[2].x).toBeCloseTo(6.096, 3);
    expect(points[2].y).toBeCloseTo(9.144, 3);
  });
});

describe("face priority arcs", () => {
  it("selects contiguous arc indices without selecting all edges", () => {
    const arc180 = resolveFacePriorityIndices(4, { primaryEdgeIndex: 0, arcDeg: 180 }).sort();
    expect(arc180).toEqual([0, 1, 3]);
    const arc270 = resolveFacePriorityIndices(4, { primaryEdgeIndex: 0, arcDeg: 270 }).sort();
    expect(arc270).toEqual([0, 1, 2]);
    const triangle = resolveFacePriorityIndices(3, { primaryEdgeIndex: 1, arcDeg: 270 });
    expect(triangle.length).toBeLessThan(3);
  });
});
