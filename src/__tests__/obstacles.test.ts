import { describe, it, expect } from "vitest";
import { deriveTreeHeightMeters } from "../obstacles";
import { deserializeProject, serializeProject, type RuntimeProjectState } from "../project";
import type {
  AppSettings,
  Sign,
  TrafficConfig,
  TrafficSignal,
  Tree
} from "../types";

describe("tree height derivation", () => {
  it("derives height from radius with clamping", () => {
    expect(deriveTreeHeightMeters(0.1524)).toBeCloseTo(3.048, 3);
    expect(deriveTreeHeightMeters(0.3048)).toBeCloseTo(3.81, 2);
    expect(deriveTreeHeightMeters(1)).toBeCloseTo(6.096, 3);
  });

  it("is monotonic with increasing radius", () => {
    const small = deriveTreeHeightMeters(0.2);
    const medium = deriveTreeHeightMeters(0.4);
    const large = deriveTreeHeightMeters(0.8);
    expect(small).toBeLessThanOrEqual(medium);
    expect(medium).toBeLessThanOrEqual(large);
  });
});

describe("project serialization", () => {
  it("round-trips trees, signs, and traffic signals", () => {
    const settings: AppSettings = {
      siteHeightFt: 6,
    viewerHeightFt: 6,
    viewDistanceFt: 2000,
    topoSpacingFt: 25,
    sampleStepPx: 5,
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
        showContours: false
      },
      opacity: {
        viewer: 0.6,
        candidate: 0.6,
        obstacle: 0.85,
        heatmap: 0.45,
        shading: 0.6,
        contours: 0.9
      }
    };

    const trafficConfig: TrafficConfig = {
      preset: "neutral",
      hour: 12,
      detail: 3,
      showOverlay: true,
      showDirectionArrows: false,
      flowDensity: "medium",
      seed: 0,
      centralShare: 0.6
    };

    const tree: Tree = {
      id: "tree-1",
      location: { lat: 37.1, lon: -122.1 },
      type: "pine",
      baseRadiusMeters: 0.5,
      heightMeters: deriveTreeHeightMeters(0.5),
      heightSource: "derived"
    };

    const sign: Sign = {
      id: "sign-1",
      location: { lat: 37.2, lon: -122.2 },
      kind: "sign",
      widthMeters: 1.8,
      heightMeters: 1.2,
      bottomClearanceMeters: 2,
      yawDegrees: 45,
      heightSource: "default"
    };

    const autoTree: Tree = {
      id: "osm:tree:1",
      location: { lat: 37.3, lon: -122.3 },
      type: "deciduous",
      baseRadiusMeters: 0.4,
      heightMeters: 4.2,
      heightSource: "osm"
    };

    const autoSign: Sign = {
      id: "osm:sign:1",
      location: { lat: 37.4, lon: -122.4 },
      kind: "billboard",
      widthMeters: 4,
      heightMeters: 2.5,
      bottomClearanceMeters: 2,
      yawDegrees: 90,
      heightSource: "osm"
    };

    const autoSignal: TrafficSignal = {
      id: "osm:signal:1",
      location: { lat: 37.5, lon: -122.5 }
    };

    const state: RuntimeProjectState = {
      bounds: null,
      settings,
      shapes: [],
      autoRoads: [],
      autoBuildings: [],
      autoTrees: [autoTree],
      autoSigns: [autoSign],
      autoTrafficSignals: [autoSignal],
      customRoads: [],
      trees: [tree],
      signs: [sign],
      trafficConfig
    };

    const payload = serializeProject(state);
    expect(payload.trees).toHaveLength(1);
    expect(payload.signs).toHaveLength(1);
    expect(payload.autoTrees).toHaveLength(1);
    expect(payload.autoSigns).toHaveLength(1);
    expect(payload.autoTrafficSignals).toHaveLength(1);

    const restored = deserializeProject(payload).state;
    expect(restored.trees?.[0]).toMatchObject({
      id: "tree-1",
      type: "pine",
      baseRadiusMeters: 0.5,
      heightSource: "derived"
    });
    expect(restored.signs?.[0]).toMatchObject({
      id: "sign-1",
      kind: "sign",
      widthMeters: 1.8,
      heightSource: "default"
    });
    expect(restored.autoTrees?.[0]).toMatchObject({
      id: "osm:tree:1",
      heightSource: "osm"
    });
    expect(restored.autoSigns?.[0]).toMatchObject({
      id: "osm:sign:1",
      heightSource: "osm"
    });
    expect(restored.autoTrafficSignals?.[0]).toMatchObject({
      id: "osm:signal:1"
    });
  });
});
