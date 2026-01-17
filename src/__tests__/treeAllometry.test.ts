import { describe, it, expect } from "vitest";
import {
  estimateTreeHeightMeters,
  TREE_HEIGHT_MODELS
} from "../trainer/heightModels/treeAllometry";

describe("estimateTreeHeightMeters", () => {
  it("is monotonic across radii for each tree type", () => {
    const radii = [0, 0.5, 1, 2, 4, 8, 12];
    (Object.keys(TREE_HEIGHT_MODELS) as Array<keyof typeof TREE_HEIGHT_MODELS>).forEach(
      (type) => {
        let last = -Infinity;
        radii.forEach((radius) => {
          const { heightMeters } = estimateTreeHeightMeters(type, radius);
          expect(heightMeters).toBeGreaterThanOrEqual(last);
          last = heightMeters;
        });
      }
    );
  });

  it("clamps to model bounds", () => {
    (Object.keys(TREE_HEIGHT_MODELS) as Array<keyof typeof TREE_HEIGHT_MODELS>).forEach(
      (type) => {
        const params = TREE_HEIGHT_MODELS[type].params;
        const minEstimate = estimateTreeHeightMeters(type, -5);
        const maxEstimate = estimateTreeHeightMeters(type, 1e6);
        expect(minEstimate.heightMeters).toBeCloseTo(params.minMeters, 6);
        expect(maxEstimate.heightMeters).toBeCloseTo(params.maxMeters, 6);
      }
    );
  });
});
