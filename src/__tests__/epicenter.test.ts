import { describe, expect, it } from "vitest";
import { inferJobCenterEpicenters } from "../traffic/epicenter";
import type { Building } from "../traffic/types";

const buildSquare = (lat: number, lon: number, size: number): Building => {
  const half = size / 2;
  return {
    id: `${lat},${lon}`,
    outline: [
      { lat: lat - half, lon: lon - half },
      { lat: lat - half, lon: lon + half },
      { lat: lat + half, lon: lon + half },
      { lat: lat + half, lon: lon - half }
    ]
  };
};

describe("inferJobCenterEpicenters", () => {
  it("favors the densest building cluster", () => {
    const simBounds = { north: 1, south: 0, east: 1, west: 0 };
    const buildings: Building[] = [
      buildSquare(0.82, 0.78, 0.01),
      buildSquare(0.79, 0.81, 0.012),
      buildSquare(0.84, 0.83, 0.009),
      buildSquare(0.81, 0.85, 0.011),
      buildSquare(0.77, 0.79, 0.01),
      buildSquare(0.22, 0.2, 0.01)
    ];

    const first = inferJobCenterEpicenters({ simBounds, roads: [], buildings });
    const second = inferJobCenterEpicenters({ simBounds, roads: [], buildings });

    expect(first.length).toBeGreaterThan(0);
    expect(first[0].lat).toBeGreaterThan(0.6);
    expect(first[0].lon).toBeGreaterThan(0.6);
    expect(second).toEqual(first);
  });
});
