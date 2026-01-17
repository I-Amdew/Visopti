import type { SampleRecord } from "../samples/sampleIndex";

export const DATASET_VERSION = 2;

export type LabelClass =
  | "tree_pine"
  | "tree_deciduous"
  | "dense_cover"
  | "billboard"
  | "stop_sign";

export interface TrainingSamplingConfig {
  patchSizePx: number;
  treeZoom: number;
  denseCoverZoom: number;
  treeContextRadiusMultiplier: number;
  edgeBandMeters: number;
  denseCoverInteriorSampleSpacingMeters: number;
  denseCoverEdgeSampleSpacingMeters: number;
}

export interface DatasetRegion {
  id: string;
  name: string;
  boundsPolygonLatLon: Array<{ lat: number; lon: number }>;
  labelingMode: "sparse" | "exhaustive";
  notes?: string;
  createdAt: number;
}

export interface TreeLabel {
  id: string;
  regionId: string;
  class: "tree_pine" | "tree_deciduous";
  centerLat: number;
  centerLon: number;
  crownRadiusMeters: number;
  derivedHeightMeters: number;
  heightModel: "pine_v1" | "deciduous_v1";
  createdAt: number;
}

export interface DenseCoverLabel {
  id: string;
  regionId: string;
  polygonLatLon: Array<{ lat: number; lon: number }>;
  mode: "dense_cover";
  density: number;
  edgeTreesOnly: boolean;
  edgeBandMeters?: number;
  createdAt: number;
}

export interface SignLabel {
  id: string;
  regionId: string;
  class: "billboard" | "stop_sign";
  lat: number;
  lon: number;
  yawDeg?: number;
  createdAt: number;
}

export interface NegativeSample {
  id: string;
  regionId: string;
  centerLat: number;
  centerLon: number;
  zoom: number;
  sizePx: number;
}

export interface TrainerDataset {
  version: number;
  imagery: {
    providerId: string;
    zoom: number;
  };
  trainingConfig: TrainingSamplingConfig;
  regions: DatasetRegion[];
  trees: TreeLabel[];
  denseCover: DenseCoverLabel[];
  signs: SignLabel[];
  negatives: NegativeSample[];
  samples: SampleRecord[];
  reviews?: {
    acceptedIds: string[];
    rejectedIds: string[];
    switchedTypeIds: string[];
  };
}

const DEFAULT_IMAGERY_PROVIDER_ID = "esri_world_imagery";
const DEFAULT_IMAGERY_ZOOM = 19;
const DEFAULT_TRAINING_CONFIG: TrainingSamplingConfig = {
  patchSizePx: 512,
  treeZoom: 20,
  denseCoverZoom: 18,
  treeContextRadiusMultiplier: 3.0,
  edgeBandMeters: 20,
  denseCoverInteriorSampleSpacingMeters: 60,
  denseCoverEdgeSampleSpacingMeters: 30
};

export function createEmptyDataset(): TrainerDataset {
  return {
    version: DATASET_VERSION,
    imagery: {
      providerId: DEFAULT_IMAGERY_PROVIDER_ID,
      zoom: DEFAULT_IMAGERY_ZOOM
    },
    trainingConfig: { ...DEFAULT_TRAINING_CONFIG },
    regions: [],
    trees: [],
    denseCover: [],
    signs: [],
    negatives: [],
    samples: []
  };
}

export function migrateDataset(input: unknown): TrainerDataset {
  if (!input || typeof input !== "object") {
    return createEmptyDataset();
  }

  const version = getDatasetVersion(input);
  switch (version) {
    case 1:
    case DATASET_VERSION:
      return normalizeDataset(input as Partial<TrainerDataset>);
    default:
      return createEmptyDataset();
  }
}

function getDatasetVersion(input: unknown): number {
  if (!input || typeof input !== "object") {
    return 0;
  }
  const version = (input as { version?: number }).version;
  return typeof version === "number" ? version : 0;
}

function normalizeDataset(input: Partial<TrainerDataset>): TrainerDataset {
  return {
    version: DATASET_VERSION,
    imagery: {
      providerId:
        typeof input.imagery?.providerId === "string"
          ? input.imagery.providerId
          : DEFAULT_IMAGERY_PROVIDER_ID,
      zoom: typeof input.imagery?.zoom === "number" ? input.imagery.zoom : DEFAULT_IMAGERY_ZOOM
    },
    trainingConfig: normalizeTrainingConfig(input.trainingConfig),
    regions: Array.isArray(input.regions) ? input.regions : [],
    trees: Array.isArray(input.trees) ? input.trees : [],
    denseCover: normalizeDenseCover(input.denseCover),
    signs: normalizeSigns(input.signs),
    negatives: Array.isArray(input.negatives) ? input.negatives : [],
    samples: normalizeSamples(input.samples),
    reviews: normalizeReviews(input.reviews)
  };
}

function normalizeReviews(
  input: TrainerDataset["reviews"] | undefined
): TrainerDataset["reviews"] | undefined {
  if (!input) {
    return undefined;
  }
  return {
    acceptedIds: normalizeIdArray(input.acceptedIds),
    rejectedIds: normalizeIdArray(input.rejectedIds),
    switchedTypeIds: normalizeIdArray(input.switchedTypeIds)
  };
}

function normalizeIdArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((value): value is string => typeof value === "string");
}

function normalizeTrainingConfig(input: Partial<TrainingSamplingConfig> | undefined): TrainingSamplingConfig {
  return {
    patchSizePx: normalizeNumber(input?.patchSizePx, DEFAULT_TRAINING_CONFIG.patchSizePx, 64),
    treeZoom: normalizeNumber(input?.treeZoom, DEFAULT_TRAINING_CONFIG.treeZoom, 1),
    denseCoverZoom: normalizeNumber(input?.denseCoverZoom, DEFAULT_TRAINING_CONFIG.denseCoverZoom, 1),
    treeContextRadiusMultiplier: normalizeNumber(
      input?.treeContextRadiusMultiplier,
      DEFAULT_TRAINING_CONFIG.treeContextRadiusMultiplier,
      0.1
    ),
    edgeBandMeters: normalizeNumber(input?.edgeBandMeters, DEFAULT_TRAINING_CONFIG.edgeBandMeters, 1),
    denseCoverInteriorSampleSpacingMeters: normalizeNumber(
      input?.denseCoverInteriorSampleSpacingMeters,
      DEFAULT_TRAINING_CONFIG.denseCoverInteriorSampleSpacingMeters,
      1
    ),
    denseCoverEdgeSampleSpacingMeters: normalizeNumber(
      input?.denseCoverEdgeSampleSpacingMeters,
      DEFAULT_TRAINING_CONFIG.denseCoverEdgeSampleSpacingMeters,
      1
    )
  };
}

function normalizeDenseCover(input: unknown): DenseCoverLabel[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((value): value is DenseCoverLabel => Boolean(value && typeof value === "object"))
    .map((label) => ({
      ...label,
      density: typeof label.density === "number" ? label.density : 0.7,
      edgeTreesOnly: Boolean(label.edgeTreesOnly),
      edgeBandMeters:
        typeof label.edgeBandMeters === "number" && Number.isFinite(label.edgeBandMeters)
          ? label.edgeBandMeters
          : undefined
    }));
}

function normalizeSigns(input: unknown): SignLabel[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((value): value is SignLabel => Boolean(value && typeof value === "object"))
    .map((sign) => ({
      ...sign,
      class: sign.class === "stop_sign" ? "billboard" : sign.class
    }));
}

function normalizeSamples(input: unknown): SampleRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter(
    (value): value is SampleRecord => Boolean(value && typeof value === "object")
  );
}

function normalizeNumber(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, value);
}
