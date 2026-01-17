import { describe, it, expect } from "vitest";
import { DATASET_VERSION, migrateDataset, TrainerDataset } from "../trainer/dataset/schema";

describe("trainer dataset serialization", () => {
  it("round trips labeled data", () => {
    const dataset: TrainerDataset = {
      version: DATASET_VERSION,
      imagery: {
        providerId: "esri_world_imagery",
        zoom: 19
      },
      trainingConfig: {
        patchSizePx: 512,
        treeZoom: 20,
        denseCoverZoom: 18,
        treeContextRadiusMultiplier: 3.0,
        edgeBandMeters: 20,
        denseCoverInteriorSampleSpacingMeters: 60,
        denseCoverEdgeSampleSpacingMeters: 30
      },
      regions: [
        {
          id: "region-1",
          name: "Region 1",
          boundsPolygonLatLon: [
            { lat: 47.61, lon: -122.33 },
            { lat: 47.61, lon: -122.32 },
            { lat: 47.6, lon: -122.32 }
          ],
          labelingMode: "sparse",
          createdAt: 123
        }
      ],
      trees: [
        {
          id: "tree-1",
          regionId: "region-1",
          class: "tree_pine",
          centerLat: 47.605,
          centerLon: -122.321,
          crownRadiusMeters: 3.2,
          derivedHeightMeters: 14.6,
          heightModel: "pine_v1",
          createdAt: 200
        },
        {
          id: "tree-2",
          regionId: "region-1",
          class: "tree_deciduous",
          centerLat: 47.604,
          centerLon: -122.322,
          crownRadiusMeters: 2.4,
          derivedHeightMeters: 10.2,
          heightModel: "deciduous_v1",
          createdAt: 210
        }
      ],
      denseCover: [
        {
          id: "dense-1",
          regionId: "region-1",
          polygonLatLon: [
            { lat: 47.605, lon: -122.325 },
            { lat: 47.605, lon: -122.324 },
            { lat: 47.604, lon: -122.324 }
          ],
          mode: "dense_cover",
          density: 0.7,
          edgeTreesOnly: true,
          createdAt: 300
        }
      ],
      signs: [
        {
          id: "sign-1",
          regionId: "region-1",
          class: "billboard",
          lat: 47.602,
          lon: -122.323,
          yawDeg: 45,
          createdAt: 400
        },
        {
          id: "sign-2",
          regionId: "region-1",
          class: "stop_sign",
          lat: 47.601,
          lon: -122.324,
          createdAt: 410
        }
      ],
      negatives: [
        {
          id: "neg-region-1-1",
          regionId: "region-1",
          centerLat: 47.6025,
          centerLon: -122.3215,
          zoom: 19,
          sizePx: 512
        }
      ],
      samples: [],
      reviews: {
        acceptedIds: ["tree-1"],
        rejectedIds: [],
        switchedTypeIds: ["tree-2"]
      }
    };

    const roundTrip = migrateDataset(JSON.parse(JSON.stringify(dataset)));
    expect(roundTrip).toEqual(dataset);
  });
});
