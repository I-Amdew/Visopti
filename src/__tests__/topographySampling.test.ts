import { describe, it, expect } from "vitest";
import { buildSpiralIndexOrder } from "../topographySampling";

describe("buildSpiralIndexOrder", () => {
  it("returns a center-out ring order for a 3x3 grid", () => {
    const order = buildSpiralIndexOrder(3, 3);
    expect(order).toEqual([4, 0, 1, 2, 5, 8, 7, 6, 3]);
  });

  it("covers all indices without decreasing ring distance", () => {
    const rows = 4;
    const cols = 4;
    const centerRow = Math.floor((rows - 1) / 2);
    const centerCol = Math.floor((cols - 1) / 2);
    const order = buildSpiralIndexOrder(rows, cols);
    expect(order).toHaveLength(rows * cols);
    const seen = new Set(order);
    expect(seen.size).toBe(rows * cols);
    const distances = order.map((index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      return Math.max(Math.abs(row - centerRow), Math.abs(col - centerCol));
    });
    for (let i = 1; i < distances.length; i += 1) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
    }
  });
});
