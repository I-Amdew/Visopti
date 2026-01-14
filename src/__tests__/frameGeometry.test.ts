import { describe, it, expect } from "vitest";
import {
  boundsCenter,
  boundsSizeMeters,
  clampBoundsToCorner,
  clampBoundsToMaxSquare,
  insetBounds
} from "../frameGeometry";

describe("frameGeometry", () => {
  it("insets bounds by percentage", () => {
    const bounds = { north: 10, south: 0, east: 20, west: 0 };
    const inset = insetBounds(bounds, 0.1);
    expect(inset).toEqual({ north: 9, south: 1, east: 18, west: 2 });
  });

  it("clamps oversized bounds to a max square around center", () => {
    const bounds = { north: 1, south: -1, east: 1, west: -1 };
    const center = boundsCenter(bounds);
    const result = clampBoundsToMaxSquare(bounds, center, 1000);
    expect(result.clamped).toBe(true);
    const size = boundsSizeMeters(result.bounds);
    expect(size.widthM).toBeCloseTo(1000, 0);
    expect(size.heightM).toBeCloseTo(1000, 0);
  });

  it("clamps corner drags to min/max size limits", () => {
    const anchor = { lat: 0, lon: 0 };
    const minSideM = 500;
    const maxSideM = 1200;
    const tinyDrag = clampBoundsToCorner(
      anchor,
      "ne",
      { lat: 0.0001, lon: 0.0001 },
      minSideM,
      maxSideM
    );
    const tinySize = boundsSizeMeters(tinyDrag);
    expect(tinySize.widthM).toBeCloseTo(minSideM, 0);
    expect(tinySize.heightM).toBeCloseTo(minSideM, 0);

    const hugeDrag = clampBoundsToCorner(
      anchor,
      "ne",
      { lat: 1, lon: 1 },
      minSideM,
      maxSideM
    );
    const hugeSize = boundsSizeMeters(hugeDrag);
    expect(hugeSize.widthM).toBeCloseTo(maxSideM, 0);
    expect(hugeSize.heightM).toBeCloseTo(maxSideM, 0);
  });
});
