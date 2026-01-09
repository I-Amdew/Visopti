import { describe, it, expect } from "vitest";
import { serializeProject, type RuntimeProjectState } from "../project";
import type { AppSettings, Road, TrafficConfig } from "../types";

describe("project normalization", () => {
  it("normalizes legacy traffic values into hourly directional scores", () => {
    const settings: AppSettings = {
      siteHeightFt: 6,
      viewerHeightFt: 6,
      topoSpacingFt: 25,
      sampleStepPx: 5,
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
      hour: 9,
      detail: 3,
      showOverlay: true,
      showDirectionArrows: false,
      seed: 0
    };

    const road: Road = {
      id: "road-1",
      points: [
        { x: 10, y: 20 },
        { x: 30, y: 40 }
      ],
      traffic: {
        forward: 120,
        backward: 80
      }
    };

    const state: RuntimeProjectState = {
      bounds: null,
      settings,
      shapes: [],
      autoRoads: [],
      autoBuildings: [],
      customRoads: [road],
      trafficConfig
    };

    const payload = serializeProject(state);
    const traffic = payload.customRoads?.[0]?.traffic;

    expect(traffic?.hourlyDirectionalScores).toHaveLength(1);
    expect(traffic?.hourlyDirectionalScores?.[0]).toEqual({
      hour: 9,
      forward: 120,
      backward: 80
    });
    expect(traffic?.forward).toBeUndefined();
    expect(traffic?.backward).toBeUndefined();
  });
});
