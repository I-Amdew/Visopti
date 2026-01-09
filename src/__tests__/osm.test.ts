import { describe, it, expect } from "vitest";
import { parseOverpassPayload } from "../osm/overpass";

describe("parseOverpassPayload", () => {
  it("builds roads and buildings from Overpass data", () => {
    const payload = {
      elements: [
        { type: "node", id: 1, lat: 37.0000, lon: -122.0000 },
        { type: "node", id: 2, lat: 37.0001, lon: -122.0001 },
        { type: "node", id: 3, lat: 37.0002, lon: -122.0001 },
        { type: "node", id: 4, lat: 37.0002, lon: -122.0000 },
        {
          type: "way",
          id: 10,
          nodes: [1, 2],
          tags: { highway: "residential", oneway: "yes", name: "Main St" }
        },
        {
          type: "way",
          id: 20,
          nodes: [1, 2, 3, 4],
          tags: { building: "yes", height: "10 ft", name: "Block A" }
        }
      ]
    };

    const { roads, buildings, nodeCount, wayCount } = parseOverpassPayload(payload);

    expect(nodeCount).toBe(4);
    expect(wayCount).toBe(2);
    expect(roads).toHaveLength(1);
    expect(buildings).toHaveLength(1);

    const road = roads[0];
    expect(road.id).toBe("osm:way:10");
    expect(road.class).toBe("residential");
    expect(road.oneway).toBe("forward");
    expect(road.points).toHaveLength(2);
    expect(road.name).toBe("Main St");
    expect(road.traffic.basis).toBe("simulated");

    const building = buildings[0];
    expect(building.id).toBe("osm:way:20");
    expect(building.name).toBe("Block A");
    expect(building.footprint).toHaveLength(5);
    expect(building.footprint[0]).toEqual(building.footprint[4]);
    expect(building.heightM).toBeCloseTo(3.048, 3);
  });
});
