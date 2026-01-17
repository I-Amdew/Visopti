export type TreeType = "tree_pine" | "tree_deciduous";

export interface HeightModelParams {
  minMeters: number;
  maxMeters: number;
  a: number;
  b: number;
  exponent: number;
}

export interface HeightEstimate {
  heightMeters: number;
  modelId: "pine_v1" | "deciduous_v1";
  debug?: {
    radiusMeters: number;
    unclampedHeightMeters: number;
    params: HeightModelParams;
  };
}

export const TREE_HEIGHT_MODELS: Record<
  TreeType,
  { modelId: HeightEstimate["modelId"]; params: HeightModelParams }
> = {
  tree_pine: {
    modelId: "pine_v1",
    params: {
      minMeters: 3,
      maxMeters: 55,
      a: 8.5,
      b: 2,
      exponent: 0.9
    }
  },
  tree_deciduous: {
    modelId: "deciduous_v1",
    params: {
      minMeters: 2.5,
      maxMeters: 40,
      a: 6.8,
      b: 2,
      exponent: 0.95
    }
  }
};

export function estimateTreeHeightMeters(
  type: TreeType,
  crownRadiusMeters: number
): HeightEstimate {
  const model = TREE_HEIGHT_MODELS[type];
  const radiusMeters = Math.max(0, crownRadiusMeters);
  const rawHeight = model.params.a * radiusMeters ** model.params.exponent + model.params.b;
  const heightMeters = clamp(rawHeight, model.params.minMeters, model.params.maxMeters);
  return {
    heightMeters,
    modelId: model.modelId,
    debug: {
      radiusMeters,
      unclampedHeightMeters: rawHeight,
      params: model.params
    }
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
