import { createGeoProjector } from "../geo";
import { createMapView } from "../mapView";
import type { TileSource, TileSourceId } from "../mapTiles";
import { getTileSource } from "../mapTiles";
import type { GeoBounds, GeoPoint, GeoProjector } from "../types";
import type {
  DatasetRegion,
  DenseCoverLabel,
  NegativeSample,
  SignLabel,
  TrainerDataset,
  TrainingSamplingConfig,
  TreeLabel
} from "./dataset/schema";
import { migrateDataset } from "./dataset/schema";
import { createDatasetStore } from "./dataset/storage";
import type { DatasetAnalytics, Histogram } from "./analytics";
import { computeDatasetAnalytics, metersPerPixelAtLat, sampleNegativePatches } from "./analytics";
import { exportTrainingBundle, renderPatchImage } from "./export";
import { estimateTreeHeightMeters, TreeType } from "./heightModels/treeAllometry";
import type { SampleRecord } from "./samples/sampleIndex";
import { deleteSample, getSampleImage, putSampleImage } from "./samples/sampleStore";
import type { Prediction, PredictionClass } from "./review/predictionsSchema";
import { parsePredictionSet } from "./review/predictionsSchema";
import {
  detectOnPatch,
  invalidateTreeSignsModelCache,
  loadTreeSignsModel,
  type PatchPrediction,
  type TreeSignsManifest
} from "../ml/inference";

const TRAINER_FLAG = "visoptiTrainer";
const TRAINER_SYNC_FLAG = "visoptiTrainerSync";
const TRAINER_SYNC_STATE_KEY = "visoptiTrainerSyncState";
const TRAINER_SYNC_SCHEMA_VERSION = 1;
const TRAINER_SYNC_DEBOUNCE_MS = 800;
const METERS_TO_FEET = 3.28084;
const DATASET_GOAL_TREES = 300;
const DEFAULT_PATCH_SIZE_PX = 512;
const MIN_NEGATIVE_SAMPLES = 20;
const MAX_NEGATIVE_SAMPLES = 400;
const NEGATIVE_SAMPLE_RATIO = 1;
const DEFAULT_DENSE_REVIEW_COUNT = 60;
const REVIEW_MIN_ZOOM = 18;
const REVIEW_MAX_ZOOM = 19;
const EDIT_HANDLE_RADIUS_PX = 7;
const EDIT_EDGE_THRESHOLD_PX = 6;
const EDIT_CENTER_RADIUS_PX = 10;
const REVIEW_HINT_DEFAULT = "Keys: 0 = Good, 1 = Bad, 3 = Wrong type, [ / ] = Radius.";
const ML_MANIFEST_POLL_MS = 8000;
const ML_PATCH_OVERLAP = 0.35;
const ML_PATCH_THROTTLE_MS = 60;
const ML_NMS_IOU = 0.45;

type Tool =
  | "select"
  | "new_region"
  | "tree_deciduous"
  | "tree_pine"
  | "dense_cover"
  | "sign_billboard"
  | "sign_stop";

type LabelSelection =
  | { kind: "tree"; id: string }
  | { kind: "dense_cover"; id: string }
  | { kind: "sign"; id: string }
  | null;

type DrawingState =
  | {
      kind: "tree";
      treeType: TreeType;
      centerPx: Point;
      centerLatLon: GeoPoint;
      currentPx: Point;
    }
  | { kind: "polygon"; polygonType: "region" | "dense_cover"; points: GeoPoint[] }
  | {
      kind: "sign";
      signType: "billboard" | "stop_sign";
      startPx: Point;
      startLatLon: GeoPoint;
      currentPx: Point | null;
    }
  | null;

type ReviewMode = "predictions" | "dense_random";

type ReviewItem =
  | { kind: "prediction"; prediction: Prediction }
  | { kind: "dense_random"; centerLat: number; centerLon: number; regionId: string };

interface ReviewPatch {
  canvas: HTMLCanvasElement;
  centerLat: number;
  centerLon: number;
  zoom: number;
  sizePx: number;
  tileSource: TileSource;
}

interface Point {
  x: number;
  y: number;
}

type DenseReviewEditDrag =
  | { kind: "vertex"; index: number }
  | { kind: "translate"; start: Point; original: Point[] }
  | null;

interface DenseReviewEditState {
  key: string;
  polygon: Point[];
  drag: DenseReviewEditDrag;
}

const TOOL_LABELS: Record<Tool, string> = {
  select: "Select",
  new_region: "New Region",
  tree_deciduous: "Add Deciduous Tree",
  tree_pine: "Add Pine Tree",
  dense_cover: "Dense Cover Polygon",
  sign_billboard: "Add Billboard",
  sign_stop: "Add Stop Sign"
};

const TOOL_REQUIRES_REGION = new Set<Tool>([
  "tree_deciduous",
  "tree_pine",
  "dense_cover",
  "sign_billboard",
  "sign_stop"
]);

const COLORS = {
  region: "rgba(94, 163, 255, 0.55)",
  regionActive: "rgba(247, 212, 106, 0.75)",
  denseFill: "rgba(56, 189, 100, 0.25)",
  denseStroke: "rgba(56, 189, 100, 0.7)",
  treePine: "rgba(47, 191, 113, 0.28)",
  treeDeciduous: "rgba(228, 180, 63, 0.3)",
  treeStroke: "rgba(15, 20, 26, 0.8)",
  signBillboard: "rgba(245, 158, 11, 0.85)",
  signStop: "rgba(239, 68, 68, 0.9)",
  selection: "rgba(255, 255, 255, 0.9)"
};

const ML_SUPPORTED_CLASSES = new Set<PredictionClass>([
  "tree_pine",
  "tree_deciduous",
  "billboard",
  "stop_sign"
]);

function isTrainerEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (window.location.search.includes("trainer=1")) {
    return true;
  }
  try {
    return window.localStorage.getItem(TRAINER_FLAG) === "1";
  } catch {
    return false;
  }
}

function setupCanvasSizing(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  onResize?: () => void
): void {
  const resize = () => {
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    onResize?.();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
}

async function initTrainer(): Promise<void> {
  const app = document.getElementById("app");
  const disabled = document.getElementById("trainerDisabled");
  if (!isTrainerEnabled()) {
    if (app) {
      app.classList.add("hidden");
    }
    if (disabled) {
      disabled.classList.remove("hidden");
    }
    return;
  }

  if (disabled) {
    disabled.classList.add("hidden");
  }
  if (app) {
    app.classList.remove("hidden");
  }

  const mapContainer = document.getElementById("trainerMap") as HTMLDivElement | null;
  const canvas = document.getElementById("trainerCanvas") as HTMLCanvasElement | null;
  if (!mapContainer || !canvas) {
    return;
  }

  const mapView = createMapView(mapContainer);
  mapView.setTileSourceId("satellite");
  const map = mapView.getLeafletMap();
  const ctx = canvas.getContext("2d")!;

  let geoProjector: GeoProjector | null = null;
  const updateProjector = () => {
    geoProjector = createGeoProjector(mapView.getBounds(), mapView.getSize());
  };

  const store = await createDatasetStore();
  let dataset = store.getSnapshot();
  const trainerSyncEnabledEnv = import.meta.env.VITE_ENABLE_TRAINER_SYNC === "1";
  let trainerSyncEnabled = readTrainerSyncFlag();
  const trainerSyncState = loadTrainerSyncState();
  const syncedSampleUpdatedAt = new Map<string, number>(
    Object.entries(trainerSyncState.sampleUpdatedAtById ?? {}).map(([id, ts]) => [
      id,
      typeof ts === "number" ? ts : 0
    ])
  );
  let lastSyncedAt = trainerSyncState.lastSyncedAt ?? 0;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let syncInFlight = false;
  let syncPending = false;
  let syncDatasetSnapshot: TrainerDataset | null = null;
  let activeTool: Tool = "select";
  let activeRegionId: string | null = dataset.regions[0]?.id ?? null;
  let selectedLabel: LabelSelection = null;
  let drawingState: DrawingState = null;
  let pointerPosition: Point | null = null;
  let reviewMode: ReviewMode | null = null;
  let predictionQueue: Prediction[] = [];
  let predictionCatalog: Prediction[] = [];
  let predictionById = new Map<string, Prediction>();
  let predictionQueueTotal = 0;
  let predictionReviewedCount = 0;
  let denseReviewQueue: Array<{ centerLat: number; centerLon: number; regionId: string }> = [];
  let denseReviewTotal = 0;
  let denseReviewReviewedCount = 0;
  let reviewImagery: { providerId: string; zoom: number } | null = null;
  let reviewOverrideClass: PredictionClass | null = null;
  let reviewPreload: { key: string; promise: Promise<ReviewPatch> } | null = null;
  let reviewRenderToken = 0;
  let currentReviewPatch: ReviewPatch | null = null;
  let reviewDenseEdit: DenseReviewEditState | null = null;
  const reviewTreeRadiusOverrides = new Map<string, number>();
  const reviewAcceptedTreeEdits = new Map<
    string,
    { class: TreeType; radiusMeters: number; derivedHeightMeters: number }
  >();
  let mlManifest: TreeSignsManifest | null = null;
  let mlManifestVersion: string | null = null;
  let mlLoading = false;
  let mlDetecting = false;
  let mlStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let mlPollInFlight = false;
  const REVIEW_RADIUS_STEP_M = 0.1;
  let sampleSignature = "";
  let sampleSyncToken = 0;

  setupCanvasSizing(canvas, mapContainer, () => {
    updateProjector();
    render();
  });

  map.on("move", () => {
    updateProjector();
    render();
  });
  map.on("zoom", () => {
    updateProjector();
    render();
  });
  map.on("resize", () => {
    updateProjector();
    render();
  });
  updateProjector();

  const regionList = document.getElementById("trainerRegionList");
  const statusLine = document.getElementById("trainerStatus");
  const inspectorEmpty = document.getElementById("trainerInspectorEmpty");
  const inspectorBody = document.getElementById("trainerInspectorBody");
  const denseCoverEdgeOnly = document.getElementById("denseCoverEdgeOnly") as
    | HTMLInputElement
    | null;

  const pineCount = document.getElementById("trainerPineCount");
  const deciduousCount = document.getElementById("trainerDeciduousCount");
  const totalTreeCount = document.getElementById("trainerTreeTotalCount");
  const denseCoverCount = document.getElementById("trainerDenseCoverCount");
  const signCount = document.getElementById("trainerSignCount");

  const datasetTreeTotal = document.getElementById("trainerDatasetTreeTotal");
  const datasetGoal = document.getElementById("trainerDatasetGoal");
  const computeAnalyticsButton = document.getElementById(
    "trainerComputeAnalytics"
  ) as HTMLButtonElement | null;
  const exportBundleButton = document.getElementById(
    "trainerExportBundle"
  ) as HTMLButtonElement | null;
  const exportAcceptedTreesButton = document.getElementById(
    "trainerExportAcceptedTrees"
  ) as HTMLButtonElement | null;
  const importDatasetInput = document.getElementById(
    "trainerImportDataset"
  ) as HTMLInputElement | null;
  const trainerSyncToggle = document.getElementById(
    "trainerSyncToggle"
  ) as HTMLInputElement | null;
  const trainerSyncStatus = document.getElementById("trainerSyncStatus");
  const datasetStatus = document.getElementById("trainerDatasetStatus");
  const exportProgressRow = document.getElementById("trainerExportProgress");
  const exportProgressLabel = document.getElementById("trainerExportLabel");
  const exportProgressCount = document.getElementById("trainerExportCount");
  const exportProgressBar = document.getElementById(
    "trainerExportBar"
  ) as HTMLProgressElement | null;
  const analyticsPanel = document.getElementById("trainerAnalytics");
  const analyticsPine = document.getElementById("trainerAnalyticsPine");
  const analyticsDeciduous = document.getElementById("trainerAnalyticsDeciduous");
  const analyticsBillboard = document.getElementById("trainerAnalyticsBillboard");
  const analyticsStop = document.getElementById("trainerAnalyticsStop");
  const analyticsNegatives = document.getElementById("trainerAnalyticsNegatives");
  const analyticsDenseSamples = document.getElementById("trainerAnalyticsDenseSamples");
  const analyticsAvgRadius = document.getElementById("trainerAnalyticsAvgRadius");
  const analyticsAvgHeight = document.getElementById("trainerAnalyticsAvgHeight");
  const analyticsDenseArea = document.getElementById("trainerAnalyticsDenseArea");
  const chartRadius = document.getElementById("trainerChartRadius") as HTMLCanvasElement | null;
  const chartHeight = document.getElementById("trainerChartHeight") as HTMLCanvasElement | null;
  const chartScatter = document.getElementById(
    "trainerChartScatter"
  ) as HTMLCanvasElement | null;
  const mlVersionLabel = document.getElementById("trainerMlVersion");
  const mlStatus = document.getElementById("trainerMlStatus");
  const mlReloadButton = document.getElementById(
    "trainerMlReload"
  ) as HTMLButtonElement | null;
  const mlProposeButton = document.getElementById(
    "trainerMlPropose"
  ) as HTMLButtonElement | null;
  const importPredictionsInput = document.getElementById(
    "trainerImportPredictions"
  ) as HTMLInputElement | null;
  const reviewQueueCount = document.getElementById("trainerReviewQueueCount");
  const startReviewButton = document.getElementById(
    "trainerStartReview"
  ) as HTMLButtonElement | null;
  const clearReviewButton = document.getElementById(
    "trainerClearReview"
  ) as HTMLButtonElement | null;
  const startDenseReviewButton = document.getElementById(
    "trainerStartDenseReview"
  ) as HTMLButtonElement | null;
  const reviewStatus = document.getElementById("trainerReviewStatus");
  const reviewModePanel = document.getElementById("trainerReviewMode");
  const reviewExitButton = document.getElementById(
    "trainerExitReview"
  ) as HTMLButtonElement | null;
  const reviewCanvas = document.getElementById("trainerReviewCanvas") as HTMLCanvasElement | null;
  const reviewIndexLabel = document.getElementById("trainerReviewIndex");
  const reviewConfidenceLabel = document.getElementById("trainerReviewConfidence");
  const reviewClassLabel = document.getElementById("trainerReviewClass");
  const reviewModeLabel = document.getElementById("trainerReviewModeLabel");
  const reviewClassWrap = document.getElementById("trainerReviewClassWrap");
  const reviewClassSelect = document.getElementById(
    "trainerReviewClassSelect"
  ) as HTMLSelectElement | null;
  const reviewRadiusWrap = document.getElementById("trainerReviewRadiusWrap");
  const reviewRadiusInput = document.getElementById(
    "trainerReviewRadiusInput"
  ) as HTMLInputElement | null;
  const reviewRadiusDown = document.getElementById(
    "trainerReviewRadiusDown"
  ) as HTMLButtonElement | null;
  const reviewRadiusUp = document.getElementById(
    "trainerReviewRadiusUp"
  ) as HTMLButtonElement | null;
  const reviewRadiusMeta = document.getElementById("trainerReviewRadiusMeta");
  const reviewAcceptButton = document.getElementById(
    "trainerReviewAccept"
  ) as HTMLButtonElement | null;
  const reviewRejectButton = document.getElementById(
    "trainerReviewReject"
  ) as HTMLButtonElement | null;
  const reviewSwitchButton = document.getElementById(
    "trainerReviewSwitch"
  ) as HTMLButtonElement | null;
  const reviewHint = document.getElementById("trainerReviewHint");

  const trainingPatchSize = document.getElementById(
    "trainingPatchSize"
  ) as HTMLSelectElement | null;
  const trainingTreeZoom = document.getElementById(
    "trainingTreeZoom"
  ) as HTMLInputElement | null;
  const trainingTreeZoomValue = document.getElementById("trainingTreeZoomValue");
  const trainingDenseZoom = document.getElementById(
    "trainingDenseZoom"
  ) as HTMLInputElement | null;
  const trainingDenseZoomValue = document.getElementById("trainingDenseZoomValue");
  const trainingEdgeBand = document.getElementById(
    "trainingEdgeBand"
  ) as HTMLInputElement | null;
  const trainingInteriorSpacing = document.getElementById(
    "trainingInteriorSpacing"
  ) as HTMLInputElement | null;
  const trainingEdgeSpacing = document.getElementById(
    "trainingEdgeSpacing"
  ) as HTMLInputElement | null;

  const toolButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-tool]")
  );

  let analytics: DatasetAnalytics | null = null;
  let exportActive = false;
  let computeActive = false;

  const updateStats = () => {
    const pine = dataset.trees.filter((tree) => tree.class === "tree_pine").length;
    const deciduous = dataset.trees.filter((tree) => tree.class === "tree_deciduous").length;
    if (pineCount) pineCount.textContent = pine.toString();
    if (deciduousCount) deciduousCount.textContent = deciduous.toString();
    if (totalTreeCount) totalTreeCount.textContent = dataset.trees.length.toString();
    if (denseCoverCount) denseCoverCount.textContent = dataset.denseCover.length.toString();
    if (signCount) signCount.textContent = dataset.signs.length.toString();
    if (datasetTreeTotal) datasetTreeTotal.textContent = dataset.trees.length.toString();
    if (datasetGoal) {
      datasetGoal.textContent = `${dataset.trees.length} / ${DATASET_GOAL_TREES}`;
    }
  };

  const updateActionButtons = () => {
    if (computeAnalyticsButton) {
      computeAnalyticsButton.disabled = computeActive;
    }
    if (exportBundleButton) {
      const hasSamples =
        dataset.trees.length + dataset.signs.length + dataset.negatives.length > 0;
      exportBundleButton.disabled = exportActive || !hasSamples;
    }
    if (exportAcceptedTreesButton) {
      const hasAccepted = buildAcceptedTreeExport().length > 0;
      exportAcceptedTreesButton.disabled = !hasAccepted;
    }
  };

  const renderTrainingConfig = () => {
    const config = dataset.trainingConfig;
    if (trainingPatchSize) {
      trainingPatchSize.value = `${config.patchSizePx}`;
    }
    if (trainingTreeZoom) {
      trainingTreeZoom.value = `${config.treeZoom}`;
    }
    if (trainingTreeZoomValue) {
      trainingTreeZoomValue.textContent = `${config.treeZoom}`;
    }
    if (trainingDenseZoom) {
      trainingDenseZoom.value = `${config.denseCoverZoom}`;
    }
    if (trainingDenseZoomValue) {
      trainingDenseZoomValue.textContent = `${config.denseCoverZoom}`;
    }
    if (trainingEdgeBand) {
      trainingEdgeBand.value = formatNumber(config.edgeBandMeters);
    }
    if (trainingInteriorSpacing) {
      trainingInteriorSpacing.value = formatNumber(config.denseCoverInteriorSampleSpacingMeters);
    }
    if (trainingEdgeSpacing) {
      trainingEdgeSpacing.value = formatNumber(config.denseCoverEdgeSampleSpacingMeters);
    }
  };

  const updateTrainingConfig = (next: Partial<TrainingSamplingConfig>) => {
    store.update((draft) => {
      draft.trainingConfig = {
        ...draft.trainingConfig,
        ...next
      };
    });
  };

  const updateReviewControls = () => {
    if (reviewQueueCount) {
      reviewQueueCount.textContent = predictionQueue.length.toString();
    }
    if (startReviewButton) {
      startReviewButton.disabled = predictionQueue.length === 0 || reviewMode !== null;
    }
    if (clearReviewButton) {
      clearReviewButton.disabled = predictionQueue.length === 0 || reviewMode !== null;
    }
    if (startDenseReviewButton) {
      startDenseReviewButton.disabled = reviewMode !== null;
    }
  };

  const applyPredictionQueue = (predictions: Prediction[], imagery: { providerId: string; zoom: number }) => {
    predictionQueue = predictions;
    predictionCatalog = predictions.slice();
    predictionById = new Map(predictionCatalog.map((prediction) => [prediction.id, prediction]));
    reviewTreeRadiusOverrides.clear();
    reviewAcceptedTreeEdits.clear();
    predictionQueueTotal = predictionQueue.length;
    predictionReviewedCount = 0;
    reviewImagery = imagery;
    reviewOverrideClass = null;
    reviewPreload = null;
    updateReviewControls();
  };

  const setDatasetStatus = (message: string | null) => {
    if (!datasetStatus) {
      return;
    }
    if (!message) {
      datasetStatus.textContent = "";
      datasetStatus.classList.add("hidden");
      return;
    }
    datasetStatus.textContent = message;
    datasetStatus.classList.remove("hidden");
  };

  const setSyncStatus = (message: string | null) => {
    if (!trainerSyncStatus) {
      return;
    }
    if (!message) {
      trainerSyncStatus.textContent = "";
      trainerSyncStatus.classList.add("hidden");
      return;
    }
    trainerSyncStatus.textContent = message;
    trainerSyncStatus.classList.remove("hidden");
  };

  const setMlStatus = (message: string | null, options?: { timeoutMs?: number }) => {
    if (!mlStatus) {
      return;
    }
    if (!message) {
      mlStatus.textContent = "";
      mlStatus.classList.add("hidden");
      return;
    }
    mlStatus.textContent = message;
    mlStatus.classList.remove("hidden");
    if (mlStatusTimer) {
      window.clearTimeout(mlStatusTimer);
      mlStatusTimer = null;
    }
    const timeout = options?.timeoutMs ?? 3000;
    if (timeout > 0) {
      mlStatusTimer = window.setTimeout(() => {
        mlStatus.textContent = "";
        mlStatus.classList.add("hidden");
      }, timeout);
    }
  };

  const updateMlStatusLabel = () => {
    if (!mlVersionLabel) {
      return;
    }
    if (!mlManifest) {
      mlVersionLabel.textContent = "--";
      return;
    }
    const size = mlManifest.input?.width ?? mlManifest.input?.height;
    const suffix = size ? ` · ${size}px` : "";
    mlVersionLabel.textContent = `${mlManifest.version ?? "unknown"}${suffix}`;
  };

  const updateMlButtons = () => {
    if (mlReloadButton) {
      mlReloadButton.disabled = mlLoading;
    }
    if (mlProposeButton) {
      mlProposeButton.disabled = mlLoading || mlDetecting || reviewMode !== null;
    }
  };

  const fetchMlManifest = async (): Promise<TreeSignsManifest | null> => {
    try {
      const response = await fetch(`/models/treesigns/manifest.json?ts=${Date.now()}`, {
        cache: "no-store"
      });
      if (!response.ok) {
        return null;
      }
      const manifest = (await response.json()) as TreeSignsManifest;
      if (!manifest || typeof manifest !== "object") {
        return null;
      }
      return manifest;
    } catch {
      return null;
    }
  };

  const loadMlModel = async (options?: { force?: boolean; notify?: boolean }) => {
    if (mlLoading) {
      return;
    }
    mlLoading = true;
    updateMlButtons();
    if (options?.force) {
      invalidateTreeSignsModelCache();
    }
    setMlStatus(options?.force ? "Reloading model…" : "Loading model…", {
      timeoutMs: 0
    });
    try {
      const { manifest } = await loadTreeSignsModel();
      mlManifest = manifest;
      mlManifestVersion = manifest.version ?? manifest.sha256 ?? null;
      updateMlStatusLabel();
      if (options?.notify !== false) {
        setMlStatus("Model ready.", { timeoutMs: 2000 });
      } else {
        setMlStatus(null);
      }
    } catch (err) {
      setMlStatus(
        `Model load failed: ${err instanceof Error ? err.message : "unknown error"}`,
        { timeoutMs: 5000 }
      );
    } finally {
      mlLoading = false;
      updateMlButtons();
    }
  };

  const pollMlManifest = async () => {
    if (mlPollInFlight) {
      return;
    }
    mlPollInFlight = true;
    try {
      const manifest = await fetchMlManifest();
      if (!manifest) {
        return;
      }
      mlManifest = manifest;
      updateMlStatusLabel();
      const nextVersion = manifest.version ?? manifest.sha256 ?? null;
      if (mlManifestVersion && nextVersion && mlManifestVersion !== nextVersion) {
        setMlStatus("New model available — reloading…", { timeoutMs: 0 });
        await loadMlModel({ force: true, notify: false });
        setMlStatus("Model reloaded.", { timeoutMs: 2500 });
      }
      mlManifestVersion = nextVersion ?? mlManifestVersion;
    } finally {
      mlPollInFlight = false;
    }
  };

  if (trainerSyncToggle) {
    trainerSyncToggle.checked = trainerSyncEnabled;
    if (!trainerSyncEnabledEnv) {
      trainerSyncToggle.disabled = true;
    }
  }
  if (!trainerSyncEnabledEnv) {
    setSyncStatus("Trainer sync disabled. Set VITE_ENABLE_TRAINER_SYNC=1.");
  } else if (trainerSyncEnabled && lastSyncedAt > 0) {
    setSyncStatus(`Synced at ${formatClockTime(lastSyncedAt)}.`);
  }

  const setReviewStatus = (message: string | null) => {
    if (!reviewStatus) {
      return;
    }
    if (!message) {
      reviewStatus.textContent = "";
      reviewStatus.classList.add("hidden");
      return;
    }
    reviewStatus.textContent = message;
    reviewStatus.classList.remove("hidden");
  };

  const setReviewHint = (message: string | null) => {
    if (!reviewHint) {
      return;
    }
    if (!message) {
      reviewHint.textContent = "";
      reviewHint.classList.add("hidden");
      return;
    }
    reviewHint.textContent = message;
    reviewHint.classList.remove("hidden");
  };

  const proposeDetectionsInView = async () => {
    if (reviewMode) {
      setReviewStatus("Exit review mode before proposing detections.");
      return;
    }
    if (!geoProjector) {
      setReviewStatus("Map view unavailable for ML detection.");
      return;
    }
    mlDetecting = true;
    updateMlButtons();
    setReviewStatus(null);
    setMlStatus("Scanning view for detections…", { timeoutMs: 0 });
    try {
      await loadMlModel({ notify: false });
      if (!mlManifest) {
        setMlStatus("Model manifest unavailable.", { timeoutMs: 4000 });
        return;
      }
      const tileSource = getTileSource(mapView.getTileSourceId());
      const zoom = Math.min(tileSource.maxZoom, Math.max(0, Math.round(mapView.getZoom())));
      const patchSizePx = normalizePatchSize(mlManifest.input?.width ?? DEFAULT_PATCH_SIZE_PX);
      const bounds = mapView.getBounds();
      const topLeft = projectLatLonForReview(bounds.north, bounds.west, zoom);
      const bottomRight = projectLatLonForReview(bounds.south, bounds.east, zoom);
      const minX = Math.min(topLeft.x, bottomRight.x);
      const maxX = Math.max(topLeft.x, bottomRight.x);
      const minY = Math.min(topLeft.y, bottomRight.y);
      const maxY = Math.max(topLeft.y, bottomRight.y);
      const stride = Math.max(32, patchSizePx * (1 - ML_PATCH_OVERLAP));
      const centers: Array<{ x: number; y: number }> = [];
      if (maxX - minX <= patchSizePx || maxY - minY <= patchSizePx) {
        centers.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
      } else {
        for (let y = minY + patchSizePx / 2; y <= maxY - patchSizePx / 2; y += stride) {
          for (let x = minX + patchSizePx / 2; x <= maxX - patchSizePx / 2; x += stride) {
            centers.push({ x, y });
          }
        }
      }
      const detections: Array<
        PatchPrediction & { worldCx: number; worldCy: number; worldW: number; worldH: number }
      > = [];
      for (let i = 0; i < centers.length; i += 1) {
        const center = centers[i];
        const centerLatLon = unprojectLatLonForReview(center.x, center.y, zoom);
        const canvas = await renderPatchImage({
          centerLatLon,
          zoom,
          sizePx: patchSizePx,
          tileSource
        });
        const patchPredictions = await detectOnPatch(canvas);
        patchPredictions.forEach((prediction) => {
          if (!ML_SUPPORTED_CLASSES.has(prediction.class as PredictionClass)) {
            return;
          }
          detections.push({
            ...prediction,
            worldCx: center.x + (prediction.cx - patchSizePx / 2),
            worldCy: center.y + (prediction.cy - patchSizePx / 2),
            worldW: prediction.w,
            worldH: prediction.h
          });
        });
        setMlStatus(`Scanning ${i + 1} / ${centers.length}…`, { timeoutMs: 0 });
        if (ML_PATCH_THROTTLE_MS > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, ML_PATCH_THROTTLE_MS));
        }
      }
      const merged = applyMlNms(detections, ML_NMS_IOU);
      const predictions = merged.map((prediction) => {
        const centerLatLon = unprojectLatLonForReview(
          prediction.worldCx,
          prediction.worldCy,
          zoom
        );
        const record: Prediction = {
          id: createId("pred"),
          class: prediction.class as PredictionClass,
          centerLat: centerLatLon.lat,
          centerLon: centerLatLon.lon,
          confidence: prediction.confidence
        };
        if (activeRegionId) {
          record.regionHintId = activeRegionId;
        }
        if (isTreeClass(record.class)) {
          const metersPerPixel = metersPerPixelAtLat(centerLatLon.lat, zoom);
          const radiusPx = 0.5 * Math.max(prediction.worldW, prediction.worldH);
          if (Number.isFinite(metersPerPixel)) {
            record.crownRadiusMeters = Math.max(0, radiusPx * metersPerPixel);
          }
        }
        return record;
      });
      if (predictions.length === 0) {
        setReviewStatus("No detections found in view.");
        setMlStatus("No detections found.", { timeoutMs: 3000 });
        return;
      }
      applyPredictionQueue(predictions, {
        providerId: tileSource.id,
        zoom
      });
      setMlStatus(`Queued ${predictions.length} detections.`, { timeoutMs: 3000 });
      enterReviewMode("predictions");
    } catch (err) {
      setReviewStatus(`Detection failed: ${err instanceof Error ? err.message : "unknown error"}`);
      setMlStatus("Detection failed.", { timeoutMs: 4000 });
    } finally {
      mlDetecting = false;
      updateMlButtons();
    }
  };

  const setExportProgress = (progress: { completed: number; total: number; label: string } | null) => {
    if (!exportProgressRow || !exportProgressBar || !exportProgressLabel || !exportProgressCount) {
      return;
    }
    if (!progress) {
      exportProgressRow.classList.add("hidden");
      exportProgressBar.value = 0;
      exportProgressBar.max = 1;
      exportProgressLabel.textContent = "";
      exportProgressCount.textContent = "";
      return;
    }
    exportProgressRow.classList.remove("hidden");
    exportProgressBar.max = Math.max(1, progress.total);
    exportProgressBar.value = Math.min(progress.total, progress.completed);
    exportProgressLabel.textContent = progress.label;
    exportProgressCount.textContent = `${progress.completed} / ${progress.total}`;
  };

  const renderAnalyticsView = () => {
    if (!analyticsPanel) {
      return;
    }
    if (!analytics) {
      analyticsPanel.classList.add("hidden");
      return;
    }
    analyticsPanel.classList.remove("hidden");
    if (analyticsPine) analyticsPine.textContent = analytics.counts.pine.toString();
    if (analyticsDeciduous) {
      analyticsDeciduous.textContent = analytics.counts.deciduous.toString();
    }
    if (analyticsBillboard) {
      analyticsBillboard.textContent = analytics.counts.billboard.toString();
    }
    if (analyticsStop) analyticsStop.textContent = analytics.counts.stopSign.toString();
    if (analyticsNegatives) {
      analyticsNegatives.textContent = analytics.counts.totalNegatives.toString();
    }
    if (analyticsDenseSamples) {
      analyticsDenseSamples.textContent = analytics.counts.denseCoverSamples.toString();
    }
    if (analyticsAvgRadius) {
      analyticsAvgRadius.textContent = formatNumber(analytics.treeStats.averageRadiusMeters);
    }
    if (analyticsAvgHeight) {
      analyticsAvgHeight.textContent = formatNumber(analytics.treeStats.averageHeightMeters);
    }
    if (analyticsDenseArea) {
      analyticsDenseArea.textContent = `${formatAxisNumber(
        analytics.denseCoverAreaM2
      )} sq m / ${formatAxisNumber(analytics.denseCoverAreaFt2)} sq ft`;
    }
    drawHistogram(chartRadius, analytics.radiusHistogram);
    drawHistogram(chartHeight, analytics.heightHistogram);
    drawScatter(chartScatter, analytics.scatter);
  };

  const updateToolAvailability = () => {
    const hasRegion = Boolean(activeRegionId);
    toolButtons.forEach((button) => {
      const tool = button.dataset.tool as Tool | undefined;
      if (!tool) return;
      if (tool === "select" || tool === "new_region") {
        button.disabled = false;
        return;
      }
      button.disabled = !hasRegion;
    });
  };

  const updateStatus = () => {
    if (!statusLine) return;
    const region = dataset.regions.find((value) => value.id === activeRegionId) ?? null;
    if (activeTool === "select") {
      statusLine.textContent = region
        ? `Active region: ${region.name} (${region.labelingMode}).`
        : "No active region. Create or select a region.";
      return;
    }
    if (TOOL_REQUIRES_REGION.has(activeTool) && !region) {
      statusLine.textContent = "Create or select a region before labeling.";
      return;
    }
    statusLine.textContent = region
      ? `${TOOL_LABELS[activeTool]} - Region: ${region.name}`
      : TOOL_LABELS[activeTool];
  };

  const handleComputeAnalytics = () => {
    if (computeActive) {
      return;
    }
    computeActive = true;
    updateActionButtons();
    setDatasetStatus("Computing dataset analytics...");
    try {
      const zoom = normalizeZoom(dataset.imagery.zoom);
      const negatives = buildNegativesForDataset(dataset, zoom, DEFAULT_PATCH_SIZE_PX);
      analytics = computeDatasetAnalytics({ ...dataset, negatives });
      renderAnalyticsView();
      store.update((draft) => {
        draft.negatives = negatives;
      });
      setDatasetStatus(`Analytics computed. Negatives: ${negatives.length}.`);
    } catch (error) {
      console.error("Trainer analytics failed:", error);
      setDatasetStatus("Analytics failed. Check console for details.");
    } finally {
      computeActive = false;
      updateActionButtons();
    }
  };

  const handleExportBundle = async () => {
    if (exportActive) {
      return;
    }
    const totalSamples =
      dataset.trees.length + dataset.signs.length + dataset.negatives.length;
    if (totalSamples === 0) {
      setDatasetStatus("Add labels before exporting.");
      return;
    }
    const needsNegatives = dataset.regions.some(
      (region) => region.labelingMode === "exhaustive"
    );
    if (needsNegatives && dataset.negatives.length === 0) {
      setDatasetStatus("Compute dataset analytics to generate negatives first.");
      return;
    }
    exportActive = true;
    updateActionButtons();
    setDatasetStatus("Rendering training bundle...");
    setExportProgress({ completed: 0, total: totalSamples, label: "Preparing export" });
    try {
      const blob = await exportTrainingBundle(dataset, {
        patchSizePx: DEFAULT_PATCH_SIZE_PX,
        onProgress: (progress) => {
          setExportProgress(progress);
        }
      });
      downloadBlob(blob, "visopti-training-bundle.zip");
      setDatasetStatus("Training bundle exported.");
    } catch (error) {
      console.error("Trainer export failed:", error);
      setDatasetStatus("Export failed. Check console for details.");
    } finally {
      exportActive = false;
      updateActionButtons();
      setExportProgress(null);
    }
  };

  const buildAcceptedTreeExport = (): Array<{
    lat: number;
    lon: number;
    type: TreeType;
    crownRadiusMeters: number;
    derivedHeightMeters: number;
    confidence: number;
  }> => {
    const acceptedIds = dataset.reviews?.acceptedIds ?? [];
    if (acceptedIds.length === 0 || predictionCatalog.length === 0) {
      return [];
    }
    const exports: Array<{
      lat: number;
      lon: number;
      type: TreeType;
      crownRadiusMeters: number;
      derivedHeightMeters: number;
      confidence: number;
    }> = [];
    acceptedIds.forEach((id) => {
      const prediction = predictionById.get(id);
      if (!prediction) {
        return;
      }
      const edit = reviewAcceptedTreeEdits.get(id);
      const treeClass = edit?.class ?? (isTreeClass(prediction.class) ? prediction.class : null);
      if (!treeClass || !isTreeClass(treeClass)) {
        return;
      }
      const radius = edit?.radiusMeters ?? prediction.crownRadiusMeters;
      if (typeof radius !== "number" || !Number.isFinite(radius)) {
        return;
      }
      const derivedHeight =
        edit?.derivedHeightMeters ?? estimateTreeHeightMeters(treeClass, radius).heightMeters;
      exports.push({
        lat: prediction.centerLat,
        lon: prediction.centerLon,
        type: treeClass,
        crownRadiusMeters: radius,
        derivedHeightMeters: derivedHeight,
        confidence: prediction.confidence
      });
    });
    return exports;
  };

  const handleExportAcceptedTrees = () => {
    const accepted = buildAcceptedTreeExport();
    if (accepted.length === 0) {
      setDatasetStatus("No accepted tree predictions to export.");
      return;
    }
    const payload = JSON.stringify(accepted, null, 2);
    downloadBlob(new Blob([payload], { type: "application/json" }), "acceptedTrees.json");
    setDatasetStatus(`Exported ${accepted.length} accepted trees.`);
  };

  const handleImportDataset = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const imported = parseImportedDataset(parsed);
      if (!imported) {
        setDatasetStatus("Unsupported dataset.json format.");
        return;
      }
      analytics = null;
      renderAnalyticsView();
      store.replace(imported);
      setDatasetStatus("Dataset imported.");
    } catch (error) {
      console.error("Trainer import failed:", error);
      setDatasetStatus("Import failed. Check console for details.");
    }
  };

  const handleImportPredictions = async (file: File) => {
    if (reviewMode) {
      setReviewStatus("Exit review mode before importing predictions.");
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const result = parsePredictionSet(parsed);
      if (!result) {
        setReviewStatus("Unsupported predictions.json format.");
        return;
      }
      predictionQueue = result.set.predictions;
      predictionCatalog = result.set.predictions.slice();
      predictionById = new Map(predictionCatalog.map((prediction) => [prediction.id, prediction]));
      reviewTreeRadiusOverrides.clear();
      reviewAcceptedTreeEdits.clear();
      predictionQueueTotal = predictionQueue.length;
      predictionReviewedCount = 0;
      reviewImagery = result.set.imagery;
      reviewOverrideClass = null;
      reviewPreload = null;
      updateActionButtons();
      setReviewStatus(
        result.invalidCount > 0
          ? `Imported ${predictionQueue.length} predictions (${result.invalidCount} invalid skipped).`
          : `Imported ${predictionQueue.length} predictions.`
      );
      updateReviewControls();
    } catch (error) {
      console.error("Prediction import failed:", error);
      setReviewStatus("Prediction import failed. Check console for details.");
    }
  };

  const clearPredictionQueue = () => {
    if (reviewMode) {
      setReviewStatus("Exit review mode before clearing the queue.");
      return;
    }
    predictionQueue = [];
    predictionCatalog = [];
    predictionById = new Map();
    reviewTreeRadiusOverrides.clear();
    reviewAcceptedTreeEdits.clear();
    predictionQueueTotal = 0;
    predictionReviewedCount = 0;
    reviewImagery = null;
    reviewOverrideClass = null;
    reviewPreload = null;
    setReviewStatus("Prediction queue cleared.");
    updateReviewControls();
    updateActionButtons();
  };

  const startPredictionReview = () => {
    if (reviewMode) {
      return;
    }
    if (predictionQueue.length === 0) {
      setReviewStatus("Import predictions before starting review.");
      return;
    }
    if (predictionQueueTotal === 0) {
      predictionQueueTotal = predictionQueue.length;
    }
    enterReviewMode("predictions");
  };

  const startDenseCoverReview = () => {
    if (reviewMode) {
      return;
    }
    const region =
      dataset.regions.find((value) => value.id === activeRegionId) ??
      dataset.regions[0] ??
      null;
    if (!region) {
      setReviewStatus("Select a region before starting dense cover review.");
      return;
    }
    const tileSource = resolveReviewTileSource(dataset.imagery.providerId);
    const zoom = normalizeReviewZoom(dataset.imagery.zoom, tileSource.maxZoom);
    const center = averageLatLon(region.boundsPolygonLatLon);
    if (!center) {
      setReviewStatus("Region bounds are invalid for dense cover review.");
      return;
    }
    const patchSizeMeters = DEFAULT_PATCH_SIZE_PX * metersPerPixelAtLat(center.lat, zoom);
    const regionTrees = dataset.trees.filter((tree) => tree.regionId === region.id);
    const regionSigns = dataset.signs.filter((sign) => sign.regionId === region.id);
    const centers = sampleNegativePatches(
      region,
      { trees: regionTrees, signs: regionSigns },
      patchSizeMeters,
      DEFAULT_DENSE_REVIEW_COUNT
    );
    denseReviewQueue = centers.map((point) => ({
      centerLat: point.centerLat,
      centerLon: point.centerLon,
      regionId: region.id
    }));
    if (denseReviewQueue.length === 0) {
      setReviewStatus("No dense cover patches sampled for this region.");
      return;
    }
    denseReviewTotal = denseReviewQueue.length;
    denseReviewReviewedCount = 0;
    enterReviewMode("dense_random");
  };

  const enterReviewMode = (mode: ReviewMode) => {
    reviewMode = mode;
    reviewOverrideClass = null;
    reviewPreload = null;
    currentReviewPatch = null;
    reviewDenseEdit = null;
    reviewRenderToken += 1;
    setReviewHint(REVIEW_HINT_DEFAULT);
    if (reviewModePanel) {
      reviewModePanel.classList.remove("hidden");
    }
    updateReviewControls();
    updateMlButtons();
    void renderCurrentReviewItem();
  };

  const exitReviewMode = () => {
    reviewMode = null;
    reviewOverrideClass = null;
    reviewPreload = null;
    currentReviewPatch = null;
    reviewDenseEdit = null;
    reviewRenderToken += 1;
    if (reviewModePanel) {
      reviewModePanel.classList.add("hidden");
    }
    setReviewHint(null);
    updateReviewControls();
    updateMlButtons();
  };

  const renderCurrentReviewItem = async () => {
    const item = getReviewItemAt(0);
    if (!item) {
      finishReviewIfNeeded();
      return;
    }
    if (!reviewCanvas) {
      return;
    }
    const token = (reviewRenderToken += 1);
    const key = getReviewItemKey(item);
    const patch =
      reviewPreload && reviewPreload.key === key
        ? await reviewPreload.promise
        : await renderReviewPatch(item);
    if (token !== reviewRenderToken) {
      return;
    }
    currentReviewPatch = patch;
    syncDenseReviewEdit(item, patch);
    updateReviewInfo(item);
    drawReviewCanvas(patch, item);
    scheduleReviewPreload();
  };

  const scheduleReviewPreload = () => {
    const next = getReviewItemAt(1);
    if (!next) {
      reviewPreload = null;
      return;
    }
    const key = getReviewItemKey(next);
    if (reviewPreload && reviewPreload.key === key) {
      return;
    }
    reviewPreload = { key, promise: renderReviewPatch(next) };
  };

  const resolveReviewTreeClass = (prediction: Prediction): TreeType | null => {
    if (reviewOverrideClass && isTreeClass(reviewOverrideClass)) {
      return reviewOverrideClass;
    }
    return isTreeClass(prediction.class) ? prediction.class : null;
  };

  const resolveReviewTreeRadius = (prediction: Prediction): number | null => {
    if (!isTreeClass(prediction.class)) {
      return null;
    }
    const override = reviewTreeRadiusOverrides.get(prediction.id);
    const base = prediction.crownRadiusMeters;
    if (typeof override === "number" && Number.isFinite(override)) {
      return Math.max(0, override);
    }
    if (typeof base === "number" && Number.isFinite(base)) {
      return Math.max(0, base);
    }
    return null;
  };

  const updateReviewRadiusControls = (prediction: Prediction | null) => {
    if (!reviewRadiusWrap || !reviewRadiusInput || !reviewRadiusMeta) {
      return;
    }
    if (!prediction || !isTreeClass(prediction.class)) {
      reviewRadiusWrap.classList.add("hidden");
      reviewRadiusInput.disabled = true;
      reviewRadiusInput.value = "";
      reviewRadiusMeta.textContent = "Derived height: --";
      return;
    }
    const radius = resolveReviewTreeRadius(prediction);
    reviewRadiusWrap.classList.remove("hidden");
    reviewRadiusInput.disabled = false;
    reviewRadiusInput.value = radius !== null ? formatNumber(radius) : "";
    const treeClass = resolveReviewTreeClass(prediction) ?? prediction.class;
    if (radius !== null && isTreeClass(treeClass)) {
      const estimate = estimateTreeHeightMeters(treeClass, radius);
      reviewRadiusMeta.textContent = `Derived height: ${formatNumber(
        estimate.heightMeters
      )} m (${formatNumber(metersToFeet(estimate.heightMeters))} ft)`;
    } else {
      reviewRadiusMeta.textContent = "Derived height: --";
    }
  };

  const adjustReviewRadius = (delta: number) => {
    const item = getReviewItemAt(0);
    if (!item || item.kind !== "prediction" || !isTreeClass(item.prediction.class)) {
      return;
    }
    const current = resolveReviewTreeRadius(item.prediction) ?? 0;
    const next = Math.max(0, current + delta);
    reviewTreeRadiusOverrides.set(item.prediction.id, next);
    updateReviewRadiusControls(item.prediction);
    redrawReviewOverlay();
  };

  const updateReviewInfo = (item: ReviewItem | null) => {
    if (!reviewIndexLabel || !reviewClassLabel || !reviewModeLabel || !reviewConfidenceLabel) {
      return;
    }
    const { total, reviewed, remaining } = getReviewCounts();
    const index = remaining > 0 ? Math.min(total, reviewed + 1) : reviewed;
    reviewIndexLabel.textContent = `${index} / ${total}`;
    reviewModeLabel.textContent =
      reviewMode === "dense_random" ? "Mode: Dense cover" : "Mode: Predictions";
    if (!item) {
      reviewClassLabel.textContent = "Class: --";
      reviewConfidenceLabel.textContent = "Confidence: --";
      return;
    }
    if (item.kind === "prediction") {
      const displayClass = reviewOverrideClass ?? item.prediction.class;
      reviewClassLabel.textContent = `Class: ${formatReviewClass(displayClass)}`;
      reviewConfidenceLabel.textContent = `Confidence: ${formatNumber(
        item.prediction.confidence
      )}`;
      const isTree = isTreeClass(item.prediction.class);
      if (reviewClassWrap) {
        reviewClassWrap.classList.toggle("hidden", !isTree);
      }
      if (reviewSwitchButton) {
        reviewSwitchButton.disabled = !isTree;
      }
      if (reviewClassSelect) {
        reviewClassSelect.value = reviewOverrideClass ?? "";
      }
      if (reviewRadiusDown) {
        reviewRadiusDown.disabled = !isTree;
      }
      if (reviewRadiusUp) {
        reviewRadiusUp.disabled = !isTree;
      }
      updateReviewRadiusControls(item.prediction);
      return;
    }
    reviewClassLabel.textContent = "Dense cover?";
    reviewConfidenceLabel.textContent = "Confidence: --";
    if (reviewClassWrap) {
      reviewClassWrap.classList.add("hidden");
    }
    if (reviewSwitchButton) {
      reviewSwitchButton.disabled = true;
    }
    updateReviewRadiusControls(null);
  };

  const drawReviewCanvas = (patch: ReviewPatch, item: ReviewItem) => {
    if (!reviewCanvas) {
      return;
    }
    const ctx = reviewCanvas.getContext("2d");
    if (!ctx) {
      return;
    }
    reviewCanvas.width = patch.sizePx;
    reviewCanvas.height = patch.sizePx;
    ctx.clearRect(0, 0, patch.sizePx, patch.sizePx);
    ctx.drawImage(patch.canvas, 0, 0, patch.sizePx, patch.sizePx);
    drawReviewOverlay(ctx, patch, item);
  };

  const handleReviewDecision = (decision: "accept" | "reject" | "switch") => {
    if (!reviewMode) {
      return;
    }
    const item = getReviewItemAt(0);
    if (!item) {
      finishReviewIfNeeded();
      return;
    }
    if (item.kind === "dense_random") {
      if (decision === "accept") {
        acceptDenseCoverPatch(item);
      }
      advanceReviewQueue();
      return;
    }

    const prediction = item.prediction;
    if (decision === "reject") {
      rejectPrediction(prediction);
      advanceReviewQueue();
      return;
    }
    if (decision === "switch") {
      if (!isTreeClass(prediction.class)) {
        setReviewHint("Switch type is only available for tree predictions.");
        return;
      }
      const switchedClass =
        prediction.class === "tree_pine" ? "tree_deciduous" : "tree_pine";
      const treeRadiusOverride = resolveReviewTreeRadius(prediction);
      const accepted = acceptPrediction(prediction, switchedClass, true, null, treeRadiusOverride);
      if (accepted) {
        advanceReviewQueue();
      }
      return;
    }
    const acceptedClass = reviewOverrideClass ?? prediction.class;
    const treeRadiusOverride = resolveReviewTreeRadius(prediction);
    const denseOverride =
      acceptedClass === "dense_cover" && currentReviewPatch
        ? getDenseReviewPolygonLatLon(currentReviewPatch)
        : null;
    const accepted = acceptPrediction(
      prediction,
      acceptedClass,
      false,
      denseOverride,
      treeRadiusOverride
    );
    if (accepted) {
      advanceReviewQueue();
    }
  };

  const acceptPrediction = (
    prediction: Prediction,
    acceptedClass: PredictionClass,
    switched: boolean,
    densePolygonOverride?: GeoPoint[] | null,
    treeRadiusOverride?: number | null
  ): boolean => {
    const regionId = resolvePredictionRegionId(prediction);
    if (!regionId) {
      setReviewHint("Select an active region before accepting predictions.");
      return false;
    }
    let labelAdded = false;
    store.update((draft) => {
      const reviews = ensureReviewMetadata(draft);
      if (acceptedClass === "tree_pine" || acceptedClass === "tree_deciduous") {
        const tree = buildTreeLabelFromPrediction(
          prediction,
          acceptedClass,
          regionId,
          treeRadiusOverride
        );
        if (!tree) {
          return;
        }
        draft.trees.push(tree);
        labelAdded = true;
        reviewAcceptedTreeEdits.set(prediction.id, {
          class: acceptedClass,
          radiusMeters: tree.crownRadiusMeters,
          derivedHeightMeters: tree.derivedHeightMeters
        });
      } else if (acceptedClass === "dense_cover") {
        const dense =
          densePolygonOverride && densePolygonOverride.length >= 3
            ? buildDenseCoverLabelFromPolygon(densePolygonOverride, regionId)
            : buildDenseCoverLabelFromPrediction(prediction, regionId);
        if (!dense) {
          return;
        }
        draft.denseCover.push(dense);
        labelAdded = true;
      } else {
        const sign = buildSignLabelFromPrediction(prediction, regionId);
        if (!sign) {
          return;
        }
        draft.signs.push(sign);
        labelAdded = true;
      }

      if (labelAdded) {
        addReviewId(reviews.acceptedIds, prediction.id);
        if (switched) {
          addReviewId(reviews.rejectedIds, prediction.id);
          addReviewId(reviews.switchedTypeIds, prediction.id);
        }
      }
    });
    if (!labelAdded) {
      setReviewHint("Prediction is missing required geometry for acceptance.");
      return false;
    }
    setReviewHint(REVIEW_HINT_DEFAULT);
    return true;
  };

  const rejectPrediction = (prediction: Prediction) => {
    store.update((draft) => {
      const reviews = ensureReviewMetadata(draft);
      addReviewId(reviews.rejectedIds, prediction.id);
    });
    setReviewHint(REVIEW_HINT_DEFAULT);
  };

  const acceptDenseCoverPatch = (item: Extract<ReviewItem, { kind: "dense_random" }>) => {
    const patch = currentReviewPatch;
    const polygonOverride = patch ? getDenseReviewPolygonLatLon(patch) : null;
    const zoom =
      patch?.zoom ??
      normalizeReviewZoom(
        dataset.imagery.zoom,
        resolveReviewTileSource(dataset.imagery.providerId).maxZoom
      );
    const dense =
      polygonOverride && polygonOverride.length >= 3
        ? buildDenseCoverLabelFromPolygon(polygonOverride, item.regionId)
        : buildDenseCoverLabelFromPatch(item.centerLat, item.centerLon, item.regionId, zoom);
    if (!dense) {
      return;
    }
    store.update((draft) => {
      draft.denseCover.push(dense);
    });
  };

  const advanceReviewQueue = () => {
    if (reviewMode === "predictions") {
      const next = predictionQueue.shift();
      if (next) {
        predictionReviewedCount += 1;
      }
      updateReviewControls();
    } else if (reviewMode === "dense_random") {
      const next = denseReviewQueue.shift();
      if (next) {
        denseReviewReviewedCount += 1;
      }
    }
    reviewOverrideClass = null;
    currentReviewPatch = null;
    reviewDenseEdit = null;
    setReviewHint(REVIEW_HINT_DEFAULT);
    if (getReviewItemAt(0)) {
      void renderCurrentReviewItem();
      return;
    }
    finishReviewIfNeeded();
  };

  const finishReviewIfNeeded = () => {
    if (!reviewMode) {
      return;
    }
    if (reviewMode === "predictions" && predictionQueue.length === 0) {
      setReviewStatus("Prediction review complete.");
    }
    if (reviewMode === "dense_random" && denseReviewQueue.length === 0) {
      setReviewStatus("Dense cover review complete.");
    }
    exitReviewMode();
  };

  const redrawReviewOverlay = () => {
    const item = getReviewItemAt(0);
    if (!item || !currentReviewPatch) {
      return;
    }
    updateReviewInfo(item);
    drawReviewCanvas(currentReviewPatch, item);
  };

  const handleReviewKeyboard = (event: KeyboardEvent) => {
    switch (event.key) {
      case "0":
      case "a":
      case "A":
      case "Enter":
        event.preventDefault();
        handleReviewDecision("accept");
        break;
      case "1":
      case "r":
      case "R":
      case "Backspace":
        event.preventDefault();
        handleReviewDecision("reject");
        break;
      case "3":
      case "t":
      case "T":
        event.preventDefault();
        handleReviewDecision("switch");
        break;
      case "[":
        event.preventDefault();
        adjustReviewRadius(-REVIEW_RADIUS_STEP_M);
        break;
      case "]":
        event.preventDefault();
        adjustReviewRadius(REVIEW_RADIUS_STEP_M);
        break;
      case "Escape":
        event.preventDefault();
        exitReviewMode();
        break;
      default:
        break;
    }
  };

  const getReviewCounts = () => {
    if (reviewMode === "predictions") {
      return {
        total: predictionQueueTotal,
        reviewed: predictionReviewedCount,
        remaining: predictionQueue.length
      };
    }
    if (reviewMode === "dense_random") {
      return {
        total: denseReviewTotal,
        reviewed: denseReviewReviewedCount,
        remaining: denseReviewQueue.length
      };
    }
    return { total: 0, reviewed: 0, remaining: 0 };
  };

  const getReviewItemAt = (offset: number): ReviewItem | null => {
    if (reviewMode === "predictions") {
      const prediction = predictionQueue[offset];
      return prediction ? { kind: "prediction", prediction } : null;
    }
    if (reviewMode === "dense_random") {
      const item = denseReviewQueue[offset];
      return item
        ? {
            kind: "dense_random",
            centerLat: item.centerLat,
            centerLon: item.centerLon,
            regionId: item.regionId
          }
        : null;
    }
    return null;
  };

  const getReviewItemKey = (item: ReviewItem): string => {
    if (item.kind === "prediction") {
      return `pred:${item.prediction.id}`;
    }
    return `dense:${item.regionId}:${item.centerLat.toFixed(6)}:${item.centerLon.toFixed(6)}`;
  };

  const renderReviewPatch = async (item: ReviewItem): Promise<ReviewPatch> => {
    const imagery =
      item.kind === "prediction" ? reviewImagery ?? dataset.imagery : dataset.imagery;
    const tileSource = resolveReviewTileSource(imagery.providerId);
    const zoom = normalizeReviewZoom(imagery.zoom, tileSource.maxZoom);
    const centerLat = item.kind === "prediction" ? item.prediction.centerLat : item.centerLat;
    const centerLon = item.kind === "prediction" ? item.prediction.centerLon : item.centerLon;
    const canvas = await renderPatchImage({
      centerLatLon: { lat: centerLat, lon: centerLon },
      zoom,
      sizePx: DEFAULT_PATCH_SIZE_PX,
      tileSource
    });
    return {
      canvas,
      centerLat,
      centerLon,
      zoom,
      sizePx: DEFAULT_PATCH_SIZE_PX,
      tileSource
    };
  };

  const drawReviewOverlay = (
    ctx: CanvasRenderingContext2D,
    patch: ReviewPatch,
    item: ReviewItem
  ) => {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.selection;
    const densePolygon = resolveDenseReviewPolygon(item, patch);
    if (densePolygon) {
      drawDenseReviewPolygon(ctx, densePolygon);
      ctx.restore();
      return;
    }
    if (item.kind === "dense_random") {
      ctx.beginPath();
      ctx.arc(patch.sizePx / 2, patch.sizePx / 2, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const prediction = item.prediction;
    if (isTreeClass(prediction.class)) {
      const treeClass = resolveReviewTreeClass(prediction) ?? prediction.class;
      const radiusMeters = resolveReviewTreeRadius(prediction);
      const radiusPx =
        radiusMeters !== null
          ? radiusMeters /
            Math.max(0.0001, metersPerPixelAtLat(prediction.centerLat, patch.zoom))
          : 0;
      ctx.beginPath();
      ctx.arc(patch.sizePx / 2, patch.sizePx / 2, radiusPx, 0, Math.PI * 2);
      ctx.fillStyle =
        treeClass === "tree_pine" ? COLORS.treePine : COLORS.treeDeciduous;
      ctx.strokeStyle = COLORS.treeStroke;
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(patch.sizePx / 2, patch.sizePx / 2, 6, 0, Math.PI * 2);
      ctx.fillStyle =
        prediction.class === "billboard" ? COLORS.signBillboard : COLORS.signStop;
      ctx.fill();
      if (typeof prediction.yawDeg === "number") {
        const dir = yawToVector(prediction.yawDeg, 16);
        ctx.beginPath();
        ctx.moveTo(patch.sizePx / 2, patch.sizePx / 2);
        ctx.lineTo(patch.sizePx / 2 + dir.x, patch.sizePx / 2 + dir.y);
        ctx.strokeStyle = COLORS.selection;
        ctx.stroke();
      }
    }
    ctx.restore();
  };

  const resolveDenseReviewPolygon = (item: ReviewItem, patch: ReviewPatch): Point[] | null => {
    if (reviewDenseEdit && reviewDenseEdit.key === getReviewItemKey(item)) {
      return reviewDenseEdit.polygon;
    }
    if (item.kind === "dense_random") {
      return defaultDensePolygonForPatch(patch);
    }
    if (item.kind === "prediction" && item.prediction.class === "dense_cover") {
      if (item.prediction.polygonLatLon && item.prediction.polygonLatLon.length >= 3) {
        return item.prediction.polygonLatLon.map((point) =>
          toPatchPoint(point.lat, point.lon, patch)
        );
      }
      return defaultDensePolygonForPrediction(patch);
    }
    return null;
  };

  const syncDenseReviewEdit = (item: ReviewItem, patch: ReviewPatch) => {
    const key = getReviewItemKey(item);
    if (reviewDenseEdit && reviewDenseEdit.key === key) {
      return;
    }
    const polygon = resolveDenseReviewPolygon(item, patch);
    if (!polygon) {
      reviewDenseEdit = null;
      return;
    }
    reviewDenseEdit = {
      key,
      polygon: polygon.map((point) => ({ ...point })),
      drag: null
    };
  };

  const getDenseReviewPolygonLatLon = (patch: ReviewPatch): GeoPoint[] | null => {
    if (!reviewDenseEdit || reviewDenseEdit.polygon.length < 3) {
      return null;
    }
    return reviewDenseEdit.polygon.map((point) => patchPointToLatLon(point, patch));
  };

  const drawDenseReviewPolygon = (ctx: CanvasRenderingContext2D, polygon: Point[]) => {
    if (polygon.length < 3) {
      return;
    }
    ctx.beginPath();
    polygon.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fillStyle = COLORS.denseFill;
    ctx.strokeStyle = COLORS.denseStroke;
    ctx.fill();
    ctx.stroke();
    polygon.forEach((point) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.selection;
      ctx.fill();
    });
    const center = polygonCentroid(polygon);
    ctx.beginPath();
    ctx.arc(center.x, center.y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.selection;
    ctx.stroke();
  };

  const isDenseReviewItem = (item: ReviewItem): boolean =>
    item.kind === "dense_random" ||
    (item.kind === "prediction" && item.prediction.class === "dense_cover");

  const defaultDensePolygonForPrediction = (patch: ReviewPatch): Point[] => {
    const half = patch.sizePx * 0.18;
    return [
      { x: patch.sizePx / 2 - half, y: patch.sizePx / 2 - half },
      { x: patch.sizePx / 2 + half, y: patch.sizePx / 2 - half },
      { x: patch.sizePx / 2 + half, y: patch.sizePx / 2 + half },
      { x: patch.sizePx / 2 - half, y: patch.sizePx / 2 + half }
    ];
  };

  const defaultDensePolygonForPatch = (patch: ReviewPatch): Point[] => [
    { x: 0, y: 0 },
    { x: patch.sizePx, y: 0 },
    { x: patch.sizePx, y: patch.sizePx },
    { x: 0, y: patch.sizePx }
  ];

  const buildNegativesForDataset = (
    source: TrainerDataset,
    zoom: number,
    sizePx: number
  ): NegativeSample[] => {
    const negatives: NegativeSample[] = [];
    const regions = [...source.regions].sort((a, b) => a.id.localeCompare(b.id));
    regions.forEach((region) => {
      if (region.labelingMode !== "exhaustive") {
        return;
      }
      const regionTrees = source.trees.filter((tree) => tree.regionId === region.id);
      const regionSigns = source.signs.filter((sign) => sign.regionId === region.id);
      const positiveCount = regionTrees.length + regionSigns.length;
      const targetCount = Math.min(
        MAX_NEGATIVE_SAMPLES,
        Math.max(MIN_NEGATIVE_SAMPLES, Math.round(positiveCount * NEGATIVE_SAMPLE_RATIO))
      );
      const center = averageLatLon(region.boundsPolygonLatLon);
      if (!center) {
        return;
      }
      const patchSizeMeters = sizePx * metersPerPixelAtLat(center.lat, zoom);
      const centers = sampleNegativePatches(
        region,
        { trees: regionTrees, signs: regionSigns },
        patchSizeMeters,
        targetCount
      );
      centers.forEach((point, index) => {
        negatives.push({
          id: `neg_${region.id}_${index + 1}`,
          regionId: region.id,
          centerLat: point.centerLat,
          centerLon: point.centerLon,
          zoom,
          sizePx
        });
      });
    });
    return negatives;
  };

  const normalizeZoom = (value: number): number => {
    if (!Number.isFinite(value)) {
      return 19;
    }
    return Math.max(1, Math.round(value));
  };

  const parseImportedDataset = (raw: unknown): TrainerDataset | null => {
    if (isTrainerDataset(raw)) {
      return migrateDataset(raw);
    }
    if (isTrainingBundle(raw)) {
      const source = (raw as { sourceDataset?: unknown }).sourceDataset;
      if (isTrainerDataset(source)) {
        return migrateDataset(source);
      }
    }
    return null;
  };

  const isTrainerDataset = (value: unknown): value is TrainerDataset => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const record = value as TrainerDataset;
    return (
      Array.isArray(record.regions) &&
      Array.isArray(record.trees) &&
      Array.isArray(record.denseCover) &&
      Array.isArray(record.signs)
    );
  };

  const isTrainingBundle = (value: unknown): value is { sourceDataset?: unknown } => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const record = value as { samples?: unknown; sourceDataset?: unknown };
    return Array.isArray(record.samples) || "sourceDataset" in record;
  };

  const averageLatLon = (
    points: Array<{ lat: number; lon: number }>
  ): GeoPoint | null => {
    if (points.length === 0) {
      return null;
    }
    let latSum = 0;
    let lonSum = 0;
    points.forEach((point) => {
      latSum += point.lat;
      lonSum += point.lon;
    });
    return { lat: latSum / points.length, lon: lonSum / points.length };
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const setActiveRegion = (regionId: string | null) => {
    activeRegionId = regionId;
    updateToolAvailability();
    renderRegionList();
    updateStatus();
    render();
  };

  const ensureActiveRegion = () => {
    if (activeRegionId && dataset.regions.some((region) => region.id === activeRegionId)) {
      return;
    }
    activeRegionId = dataset.regions[0]?.id ?? null;
  };

  const renderRegionList = () => {
    if (!regionList) return;
    regionList.innerHTML = "";
    if (dataset.regions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "status-line";
      empty.textContent = "No regions yet.";
      regionList.appendChild(empty);
      return;
    }
    dataset.regions.forEach((region) => {
      const button = document.createElement("button");
      button.className = "trainer-region-item";
      if (region.id === activeRegionId) {
        button.classList.add("is-active");
      }
      button.dataset.regionId = region.id;
      button.textContent = `${region.name} (${region.labelingMode})`;
      regionList.appendChild(button);
    });
  };

  const setTool = (tool: Tool) => {
    if (activeTool === tool) {
      return;
    }
    activeTool = tool;
    drawingState = null;
    pointerPosition = null;
    toolButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tool === tool);
    });
    if (activeTool === "select") {
      mapView.enableInteractions();
      canvas.style.pointerEvents = "none";
      canvas.style.cursor = "grab";
    } else {
      mapView.disableInteractions();
      canvas.style.pointerEvents = "auto";
      canvas.style.cursor = "crosshair";
    }
    if (tool === "new_region") {
      createRegionFromBounds();
      setTool("select");
      return;
    }
    updateStatus();
    render();
  };

  const setSelection = (selection: LabelSelection) => {
    selectedLabel = selection;
    renderInspector();
    render();
  };

  const clearSelectionIfMissing = () => {
    const selection = selectedLabel;
    if (!selection) {
      return;
    }
    const exists =
      (selection.kind === "tree" &&
        dataset.trees.some((tree) => tree.id === selection.id)) ||
      (selection.kind === "dense_cover" &&
        dataset.denseCover.some((label) => label.id === selection.id)) ||
      (selection.kind === "sign" &&
        dataset.signs.some((label) => label.id === selection.id));
    if (!exists) {
      selectedLabel = null;
    }
  };

  function boundsToPolygon(bounds: GeoBounds): GeoPoint[] {
    return [
      { lat: bounds.north, lon: bounds.west },
      { lat: bounds.north, lon: bounds.east },
      { lat: bounds.south, lon: bounds.east },
      { lat: bounds.south, lon: bounds.west }
    ];
  }

  function createRegionFromBounds(): void {
    const bounds = mapView.getBounds();
    const polygon = boundsToPolygon(bounds);
    const region: DatasetRegion = {
      id: createId("region"),
      name: `Region ${dataset.regions.length + 1}`,
      boundsPolygonLatLon: polygon,
      labelingMode: readRegionMode(),
      createdAt: Date.now()
    };
    store.update((draft) => {
      draft.regions.push(region);
    });
    setActiveRegion(region.id);
    setDatasetStatus(`Region ${region.name} created from the current frame.`);
  }

  const updateDataset = (next: TrainerDataset) => {
    dataset = next;
    ensureActiveRegion();
    updateStats();
    updateActionButtons();
    updateReviewControls();
    updateToolAvailability();
    updateStatus();
    renderTrainingConfig();
    clearSelectionIfMissing();
    renderRegionList();
    renderInspector();
    render();
    scheduleSampleSync(next);
    scheduleRepoSync(next);
  };

  updateDataset(dataset);
  store.subscribe(updateDataset);
  updateMlButtons();
  void pollMlManifest();
  window.setInterval(() => {
    void pollMlManifest();
  }, ML_MANIFEST_POLL_MS);

  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tool = button.dataset.tool as Tool | undefined;
      if (!tool) return;
      setTool(tool);
    });
  });

  trainingPatchSize?.addEventListener("change", () => {
    const value = parseInt(trainingPatchSize.value, 10);
    if (!Number.isFinite(value)) {
      return;
    }
    updateTrainingConfig({ patchSizePx: value });
  });

  trainingTreeZoom?.addEventListener("input", () => {
    const value = parseInt(trainingTreeZoom.value, 10);
    if (!Number.isFinite(value)) {
      return;
    }
    if (trainingTreeZoomValue) {
      trainingTreeZoomValue.textContent = `${value}`;
    }
    updateTrainingConfig({ treeZoom: value });
  });

  trainingDenseZoom?.addEventListener("input", () => {
    const value = parseInt(trainingDenseZoom.value, 10);
    if (!Number.isFinite(value)) {
      return;
    }
    if (trainingDenseZoomValue) {
      trainingDenseZoomValue.textContent = `${value}`;
    }
    updateTrainingConfig({ denseCoverZoom: value });
  });

  trainingEdgeBand?.addEventListener("change", () => {
    const value = parseFloat(trainingEdgeBand.value);
    if (!Number.isFinite(value)) {
      return;
    }
    updateTrainingConfig({ edgeBandMeters: Math.max(1, value) });
  });

  trainingInteriorSpacing?.addEventListener("change", () => {
    const value = parseFloat(trainingInteriorSpacing.value);
    if (!Number.isFinite(value)) {
      return;
    }
    updateTrainingConfig({ denseCoverInteriorSampleSpacingMeters: Math.max(1, value) });
  });

  trainingEdgeSpacing?.addEventListener("change", () => {
    const value = parseFloat(trainingEdgeSpacing.value);
    if (!Number.isFinite(value)) {
      return;
    }
    updateTrainingConfig({ denseCoverEdgeSampleSpacingMeters: Math.max(1, value) });
  });

  computeAnalyticsButton?.addEventListener("click", () => {
    handleComputeAnalytics();
  });

  exportBundleButton?.addEventListener("click", () => {
    void handleExportBundle();
  });

  exportAcceptedTreesButton?.addEventListener("click", () => {
    handleExportAcceptedTrees();
  });

  importDatasetInput?.addEventListener("change", () => {
    const file = importDatasetInput.files?.[0];
    if (!file) {
      return;
    }
    void handleImportDataset(file);
    importDatasetInput.value = "";
  });

  trainerSyncToggle?.addEventListener("change", () => {
    trainerSyncEnabled = trainerSyncToggle.checked;
    writeTrainerSyncFlag(trainerSyncEnabled);
    if (!trainerSyncEnabledEnv) {
      setSyncStatus("Trainer sync disabled. Set VITE_ENABLE_TRAINER_SYNC=1.");
      return;
    }
    if (trainerSyncEnabled) {
      setSyncStatus("Sync enabled. Waiting for changes...");
      scheduleRepoSync(dataset, true);
    } else {
      setSyncStatus(null);
    }
  });

  mlReloadButton?.addEventListener("click", () => {
    void loadMlModel({ force: true });
  });

  mlProposeButton?.addEventListener("click", () => {
    void proposeDetectionsInView();
  });

  importPredictionsInput?.addEventListener("change", () => {
    const file = importPredictionsInput.files?.[0];
    if (!file) {
      return;
    }
    void handleImportPredictions(file);
    importPredictionsInput.value = "";
  });

  startReviewButton?.addEventListener("click", () => {
    startPredictionReview();
  });

  clearReviewButton?.addEventListener("click", () => {
    clearPredictionQueue();
  });

  startDenseReviewButton?.addEventListener("click", () => {
    startDenseCoverReview();
  });

  reviewExitButton?.addEventListener("click", () => {
    exitReviewMode();
  });

  reviewAcceptButton?.addEventListener("click", () => {
    handleReviewDecision("accept");
  });

  reviewRejectButton?.addEventListener("click", () => {
    handleReviewDecision("reject");
  });

  reviewSwitchButton?.addEventListener("click", () => {
    handleReviewDecision("switch");
  });

  reviewRadiusDown?.addEventListener("click", () => {
    adjustReviewRadius(-REVIEW_RADIUS_STEP_M);
  });

  reviewRadiusUp?.addEventListener("click", () => {
    adjustReviewRadius(REVIEW_RADIUS_STEP_M);
  });

  reviewRadiusInput?.addEventListener("input", () => {
    const item = getReviewItemAt(0);
    if (!item || item.kind !== "prediction" || !isTreeClass(item.prediction.class)) {
      return;
    }
    const value = Number.parseFloat(reviewRadiusInput.value);
    if (!Number.isFinite(value)) {
      return;
    }
    const next = Math.max(0, value);
    reviewTreeRadiusOverrides.set(item.prediction.id, next);
    updateReviewRadiusControls(item.prediction);
    redrawReviewOverlay();
  });

  reviewClassSelect?.addEventListener("change", () => {
    if (!reviewClassSelect.value) {
      reviewOverrideClass = null;
    } else {
      reviewOverrideClass =
        reviewClassSelect.value === "tree_pine" ? "tree_pine" : "tree_deciduous";
    }
    redrawReviewOverlay();
  });

  const getActiveDenseReviewState = () => {
    if (!reviewMode || !currentReviewPatch || !reviewDenseEdit) {
      return null;
    }
    const item = getReviewItemAt(0);
    if (!item || !isDenseReviewItem(item)) {
      return null;
    }
    if (reviewDenseEdit.key !== getReviewItemKey(item)) {
      return null;
    }
    return { item, patch: currentReviewPatch, polygon: reviewDenseEdit.polygon };
  };

  reviewCanvas?.addEventListener("pointerdown", (event) => {
    const state = getActiveDenseReviewState();
    if (!state || !reviewDenseEdit) {
      return;
    }
    const point = toReviewCanvasPoint(event, reviewCanvas);
    const handleIndex = findVertexHandleIndex(point, state.polygon);
    if (handleIndex !== null) {
      reviewDenseEdit.drag = { kind: "vertex", index: handleIndex };
    } else {
      const center = polygonCentroid(state.polygon);
      if (distancePx(point, center) <= EDIT_CENTER_RADIUS_PX) {
        reviewDenseEdit.drag = {
          kind: "translate",
          start: point,
          original: state.polygon.map((value) => ({ ...value }))
        };
      } else {
        const edgeInsert = findEdgeInsert(point, state.polygon);
        if (edgeInsert) {
          state.polygon.splice(edgeInsert.index + 1, 0, edgeInsert.point);
          reviewDenseEdit.drag = { kind: "vertex", index: edgeInsert.index + 1 };
        }
      }
    }
    if (reviewDenseEdit.drag) {
      event.preventDefault();
      event.stopPropagation();
      reviewCanvas.setPointerCapture(event.pointerId);
      redrawReviewOverlay();
    }
  });

  reviewCanvas?.addEventListener("pointermove", (event) => {
    if (!reviewDenseEdit?.drag || !currentReviewPatch) {
      return;
    }
    const patch = currentReviewPatch;
    const point = toReviewCanvasPoint(event, reviewCanvas);
    if (reviewDenseEdit.drag.kind === "vertex") {
      reviewDenseEdit.polygon[reviewDenseEdit.drag.index] = clampPointToPatch(point, patch);
      redrawReviewOverlay();
      return;
    }
    if (reviewDenseEdit.drag.kind === "translate") {
      const dx = point.x - reviewDenseEdit.drag.start.x;
      const dy = point.y - reviewDenseEdit.drag.start.y;
      reviewDenseEdit.polygon = reviewDenseEdit.drag.original.map((value) =>
        clampPointToPatch({ x: value.x + dx, y: value.y + dy }, patch)
      );
      redrawReviewOverlay();
    }
  });

  const endReviewDrag = () => {
    if (reviewDenseEdit) {
      reviewDenseEdit.drag = null;
    }
  };

  reviewCanvas?.addEventListener("pointerup", (event) => {
    if (reviewCanvas.hasPointerCapture(event.pointerId)) {
      reviewCanvas.releasePointerCapture(event.pointerId);
    }
    endReviewDrag();
  });
  reviewCanvas?.addEventListener("pointerleave", () => {
    endReviewDrag();
  });
  reviewCanvas?.addEventListener("pointercancel", (event) => {
    if (reviewCanvas.hasPointerCapture(event.pointerId)) {
      reviewCanvas.releasePointerCapture(event.pointerId);
    }
    endReviewDrag();
  });

  window.addEventListener("resize", () => {
    if (analytics) {
      renderAnalyticsView();
    }
  });

  regionList?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const button = target.closest<HTMLButtonElement>("[data-region-id]");
    if (!button) return;
    setActiveRegion(button.dataset.regionId ?? null);
  });

  document.addEventListener("keydown", (event) => {
    if (shouldIgnoreKeyboard(event)) return;
    if (reviewMode) {
      handleReviewKeyboard(event);
      return;
    }
    switch (event.key) {
      case "1":
        setTool("tree_deciduous");
        break;
      case "2":
        setTool("tree_pine");
        break;
      case "d":
      case "D":
        setTool("dense_cover");
        break;
      case "b":
      case "B":
        setTool("sign_billboard");
        break;
      case "s":
      case "S":
        setTool("sign_stop");
        break;
      case "Escape":
        setTool("select");
        break;
      case "Backspace":
      case "Delete":
        if (selectedLabel) {
          deleteSelectedLabel(selectedLabel);
        }
        break;
      default:
        break;
    }
  });

  map.on("click", (event: { latlng?: { lat: number; lng: number } }) => {
    if (activeTool !== "select") {
      return;
    }
    if (!geoProjector || !event.latlng) {
      return;
    }
    const pixel = geoProjector.latLonToPixel(event.latlng.lat, event.latlng.lng);
    setSelection(pickLabelAtPixel(pixel));
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (!geoProjector || activeTool === "select") {
      return;
    }
    const point = toCanvasPoint(event, canvas);
    pointerPosition = point;
    event.preventDefault();
    event.stopPropagation();
    canvas.setPointerCapture(event.pointerId);

    if (activeTool === "tree_deciduous" || activeTool === "tree_pine") {
      if (!activeRegionId) {
        updateStatus();
        return;
      }
      const centerLatLon = geoProjector.pixelToLatLon(point.x, point.y);
      drawingState = {
        kind: "tree",
        treeType: activeTool === "tree_pine" ? "tree_pine" : "tree_deciduous",
        centerPx: point,
        centerLatLon,
        currentPx: point
      };
      render();
      return;
    }

    if (activeTool === "dense_cover" || activeTool === "new_region") {
      if (activeTool !== "new_region" && !activeRegionId) {
        updateStatus();
        return;
      }
      const latLon = geoProjector.pixelToLatLon(point.x, point.y);
      if (drawingState?.kind === "polygon" && drawingState.polygonType === polygonTypeForTool(activeTool)) {
        drawingState.points.push(latLon);
      } else {
        drawingState = {
          kind: "polygon",
          polygonType: polygonTypeForTool(activeTool),
          points: [latLon]
        };
      }
      render();
      return;
    }

    if (activeTool === "sign_billboard" || activeTool === "sign_stop") {
      if (!activeRegionId) {
        updateStatus();
        return;
      }
      const startLatLon = geoProjector.pixelToLatLon(point.x, point.y);
      drawingState = {
        kind: "sign",
        signType: activeTool === "sign_billboard" ? "billboard" : "stop_sign",
        startPx: point,
        startLatLon,
        currentPx: point
      };
      render();
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!geoProjector || activeTool === "select") {
      return;
    }
    const point = toCanvasPoint(event, canvas);
    pointerPosition = point;
    if (!drawingState) {
      return;
    }
    if (drawingState.kind === "tree") {
      drawingState.currentPx = point;
      render();
      return;
    }
    if (drawingState.kind === "sign") {
      drawingState.currentPx = point;
      render();
      return;
    }
    if (drawingState.kind === "polygon") {
      render();
    }
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!geoProjector || !drawingState) {
      return;
    }
    const point = toCanvasPoint(event, canvas);
    pointerPosition = point;
    if (drawingState.kind === "tree") {
      finalizeTree(drawingState, geoProjector);
      drawingState = null;
      render();
      return;
    }
    if (drawingState.kind === "sign") {
      finalizeSign(drawingState, geoProjector);
      drawingState = null;
      render();
    }
  });

  canvas.addEventListener("dblclick", (event) => {
    if (!drawingState || drawingState.kind !== "polygon") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    finalizePolygon(drawingState);
    drawingState = null;
    render();
  });

  function finalizeTree(state: Extract<DrawingState, { kind: "tree" }>, projector: GeoProjector) {
    if (!activeRegionId) {
      return;
    }
    const edgeLatLon = projector.pixelToLatLon(state.currentPx.x, state.currentPx.y);
    const radiusMeters = distanceMeters(state.centerLatLon, edgeLatLon);
    if (!Number.isFinite(radiusMeters)) {
      return;
    }
    const estimate = estimateTreeHeightMeters(state.treeType, radiusMeters);
    const label: TreeLabel = {
      id: createId("tree"),
      regionId: activeRegionId,
      class: state.treeType,
      centerLat: state.centerLatLon.lat,
      centerLon: state.centerLatLon.lon,
      crownRadiusMeters: radiusMeters,
      derivedHeightMeters: estimate.heightMeters,
      heightModel: estimate.modelId,
      createdAt: Date.now()
    };
    selectedLabel = { kind: "tree", id: label.id };
    store.update((draft) => {
      draft.trees.push(label);
    });
  }

  function finalizePolygon(state: Extract<DrawingState, { kind: "polygon" }>) {
    if (state.points.length < 3) {
      return;
    }
    if (state.polygonType === "region") {
      const regionMode = readRegionMode();
      const label: DatasetRegion = {
        id: createId("region"),
        name: `Region ${dataset.regions.length + 1}`,
        boundsPolygonLatLon: state.points,
        labelingMode: regionMode,
        createdAt: Date.now()
      };
      activeRegionId = label.id;
      store.update((draft) => {
        draft.regions.push(label);
      });
      return;
    }
    if (!activeRegionId) {
      return;
    }
    const denseLabel = createDenseCoverLabel(activeRegionId, state.points, {
      edgeTreesOnly: denseCoverEdgeOnly?.checked ?? false
    });
    selectedLabel = { kind: "dense_cover", id: denseLabel.id };
    store.update((draft) => {
      draft.denseCover.push(denseLabel);
    });
  }

  function finalizeSign(state: Extract<DrawingState, { kind: "sign" }>, projector: GeoProjector) {
    if (!activeRegionId) {
      return;
    }
    const endLatLon = state.currentPx
      ? projector.pixelToLatLon(state.currentPx.x, state.currentPx.y)
      : state.startLatLon;
    const dragDistance = state.currentPx
      ? distancePx(state.startPx, state.currentPx)
      : 0;
    const yawDeg =
      state.signType === "billboard" && dragDistance > 6
        ? bearingDegrees(state.startLatLon, endLatLon)
        : undefined;
    const label: SignLabel = {
      id: createId("sign"),
      regionId: activeRegionId,
      class: state.signType,
      lat: state.startLatLon.lat,
      lon: state.startLatLon.lon,
      yawDeg,
      createdAt: Date.now()
    };
    selectedLabel = { kind: "sign", id: label.id };
    store.update((draft) => {
      draft.signs.push(label);
    });
  }

  function deleteSelectedLabel(selection: Exclude<LabelSelection, null>) {
    store.update((draft) => {
      if (selection.kind === "tree") {
        draft.trees = draft.trees.filter((tree) => tree.id !== selection.id);
      } else if (selection.kind === "dense_cover") {
        draft.denseCover = draft.denseCover.filter((label) => label.id !== selection.id);
      } else {
        draft.signs = draft.signs.filter((label) => label.id !== selection.id);
      }
    });
    setSelection(null);
  }

  function renderInspector() {
    if (!inspectorBody || !inspectorEmpty) {
      return;
    }
    const selection = selectedLabel;
    if (!selection) {
      inspectorBody.classList.add("hidden");
      inspectorEmpty.classList.remove("hidden");
      return;
    }
    const selected =
      selection.kind === "tree"
        ? dataset.trees.find((tree) => tree.id === selection.id)
        : selection.kind === "dense_cover"
        ? dataset.denseCover.find((label) => label.id === selection.id)
        : dataset.signs.find((label) => label.id === selection.id);
    if (!selected) {
      inspectorBody.classList.add("hidden");
      inspectorEmpty.classList.remove("hidden");
      return;
    }
    inspectorEmpty.classList.add("hidden");
    inspectorBody.classList.remove("hidden");
    if (selection.kind === "tree") {
      const tree = selected as TreeLabel;
      inspectorBody.innerHTML = `
        <div class="trainer-field">
          <label>
            Tree type
            <select id="inspectTreeType">
              <option value="tree_pine">Pine</option>
              <option value="tree_deciduous">Deciduous</option>
            </select>
          </label>
        </div>
        <div class="trainer-inline">
          <label>
            Radius (m)
            <input type="number" step="0.1" id="inspectTreeRadiusMeters" />
          </label>
          <label>
            Radius (ft)
            <input type="number" step="0.1" id="inspectTreeRadiusFeet" />
          </label>
        </div>
        <div class="value-row">
          <span>Derived height (m)</span>
          <span>${formatNumber(tree.derivedHeightMeters)}</span>
        </div>
        <div class="value-row">
          <span>Model</span>
          <span>${tree.heightModel}</span>
        </div>
        <button class="trainer-delete" id="inspectDelete">Delete</button>
      `;
      const typeSelect = document.getElementById("inspectTreeType") as HTMLSelectElement | null;
      const radiusMetersInput = document.getElementById(
        "inspectTreeRadiusMeters"
      ) as HTMLInputElement | null;
      const radiusFeetInput = document.getElementById(
        "inspectTreeRadiusFeet"
      ) as HTMLInputElement | null;
      const deleteButton = document.getElementById("inspectDelete") as HTMLButtonElement | null;

      if (typeSelect) {
        typeSelect.value = tree.class;
        typeSelect.addEventListener("change", () => {
          const nextType = typeSelect.value === "tree_pine" ? "tree_pine" : "tree_deciduous";
          store.update((draft) => {
            const target = draft.trees.find((label) => label.id === tree.id);
            if (!target) return;
            target.class = nextType;
            applyHeightModel(target);
          });
        });
      }

      if (radiusMetersInput && radiusFeetInput) {
        radiusMetersInput.value = formatNumber(tree.crownRadiusMeters);
        radiusFeetInput.value = formatNumber(metersToFeet(tree.crownRadiusMeters));
        radiusMetersInput.addEventListener("change", () => {
          const value = parseFloat(radiusMetersInput.value);
          if (!Number.isFinite(value)) return;
          store.update((draft) => {
            const target = draft.trees.find((label) => label.id === tree.id);
            if (!target) return;
            target.crownRadiusMeters = Math.max(0, value);
            applyHeightModel(target);
          });
        });
        radiusFeetInput.addEventListener("change", () => {
          const value = parseFloat(radiusFeetInput.value);
          if (!Number.isFinite(value)) return;
          store.update((draft) => {
            const target = draft.trees.find((label) => label.id === tree.id);
            if (!target) return;
            target.crownRadiusMeters = Math.max(0, feetToMeters(value));
            applyHeightModel(target);
          });
        });
      }

      deleteButton?.addEventListener("click", () => {
        deleteSelectedLabel({ kind: "tree", id: tree.id });
      });
      return;
    }
    if (selection.kind === "dense_cover") {
      const dense = selected as DenseCoverLabel;
      inspectorBody.innerHTML = `
        <div class="trainer-field">
          <label>
            Density
            <select id="inspectDenseDensity">
              <option value="0.4">Low</option>
              <option value="0.7">Medium</option>
              <option value="1.0">High</option>
            </select>
          </label>
        </div>
        <label class="toggle-option">
          <input type="checkbox" id="inspectDenseEdgeOnly" />
          Edge trees only
        </label>
        <div class="trainer-field">
          <label>
            Edge band (m)
            <input type="number" step="1" id="inspectDenseEdgeBand" />
          </label>
        </div>
        <button class="trainer-delete" id="inspectDelete">Delete</button>
      `;
      const densitySelect = document.getElementById(
        "inspectDenseDensity"
      ) as HTMLSelectElement | null;
      const edgeToggle = document.getElementById("inspectDenseEdgeOnly") as HTMLInputElement | null;
      const edgeBandInput = document.getElementById(
        "inspectDenseEdgeBand"
      ) as HTMLInputElement | null;
      const deleteButton = document.getElementById("inspectDelete") as HTMLButtonElement | null;
      if (densitySelect) {
        densitySelect.value = normalizeDenseCoverDensity(dense.density).toFixed(1);
        densitySelect.addEventListener("change", () => {
          const value = parseFloat(densitySelect.value);
          if (!Number.isFinite(value)) return;
          store.update((draft) => {
            const target = draft.denseCover.find((label) => label.id === dense.id);
            if (!target) return;
            target.density = normalizeDenseCoverDensity(value);
          });
        });
      }
      if (edgeToggle) {
        edgeToggle.checked = dense.edgeTreesOnly;
        edgeToggle.addEventListener("change", () => {
          store.update((draft) => {
            const target = draft.denseCover.find((label) => label.id === dense.id);
            if (!target) return;
            target.edgeTreesOnly = edgeToggle.checked;
          });
        });
      }
      if (edgeBandInput) {
        edgeBandInput.placeholder = `${formatNumber(dataset.trainingConfig.edgeBandMeters)}`;
        edgeBandInput.value =
          typeof dense.edgeBandMeters === "number" ? formatNumber(dense.edgeBandMeters) : "";
        edgeBandInput.addEventListener("change", () => {
          const value = edgeBandInput.value.trim();
          store.update((draft) => {
            const target = draft.denseCover.find((label) => label.id === dense.id);
            if (!target) return;
            if (!value) {
              delete target.edgeBandMeters;
              return;
            }
            const numeric = parseFloat(value);
            if (Number.isFinite(numeric)) {
              target.edgeBandMeters = Math.max(1, numeric);
            }
          });
        });
      }
      deleteButton?.addEventListener("click", () => {
        deleteSelectedLabel({ kind: "dense_cover", id: dense.id });
      });
      return;
    }
    const sign = selected as SignLabel;
    inspectorBody.innerHTML = `
      <div class="trainer-field">
        <label>
          Sign type
          <select id="inspectSignClass">
            <option value="billboard">Billboard</option>
            <option value="stop_sign">Stop sign</option>
          </select>
        </label>
      </div>
      <div class="trainer-field">
        <label>
          Yaw (deg)
          <input type="number" step="1" id="inspectSignYaw" />
        </label>
      </div>
      <button class="trainer-delete" id="inspectDelete">Delete</button>
    `;
    const signClass = document.getElementById("inspectSignClass") as HTMLSelectElement | null;
    const signYaw = document.getElementById("inspectSignYaw") as HTMLInputElement | null;
    const deleteButton = document.getElementById("inspectDelete") as HTMLButtonElement | null;
    if (signClass) {
      signClass.value = sign.class;
      signClass.addEventListener("change", () => {
        const nextClass = signClass.value === "stop_sign" ? "stop_sign" : "billboard";
        store.update((draft) => {
          const target = draft.signs.find((label) => label.id === sign.id);
          if (!target) return;
          target.class = nextClass;
        });
      });
    }
    if (signYaw) {
      signYaw.value = sign.yawDeg === undefined ? "" : formatNumber(sign.yawDeg);
      signYaw.addEventListener("change", () => {
        const value = signYaw.value.trim();
        store.update((draft) => {
          const target = draft.signs.find((label) => label.id === sign.id);
          if (!target) return;
          if (!value) {
            delete target.yawDeg;
            return;
          }
          const numeric = parseFloat(value);
          if (Number.isFinite(numeric)) {
            target.yawDeg = normalizeDegrees(numeric);
          }
        });
      });
    }
    deleteButton?.addEventListener("click", () => {
      deleteSelectedLabel({ kind: "sign", id: sign.id });
    });
  }

  function applyHeightModel(tree: TreeLabel) {
    const estimate = estimateTreeHeightMeters(tree.class, tree.crownRadiusMeters);
    tree.derivedHeightMeters = estimate.heightMeters;
    tree.heightModel = estimate.modelId;
  }

  function resolvePredictionRegionId(prediction: Prediction): string | null {
    if (
      prediction.regionHintId &&
      dataset.regions.some((region) => region.id === prediction.regionHintId)
    ) {
      return prediction.regionHintId;
    }
    if (activeRegionId && dataset.regions.some((region) => region.id === activeRegionId)) {
      return activeRegionId;
    }
    return dataset.regions[0]?.id ?? null;
  }

  function ensureReviewMetadata(
    draft: TrainerDataset
  ): NonNullable<TrainerDataset["reviews"]> {
    if (!draft.reviews) {
      draft.reviews = {
        acceptedIds: [],
        rejectedIds: [],
        switchedTypeIds: []
      };
    }
    return draft.reviews;
  }

  function addReviewId(list: string[], id: string) {
    if (!list.includes(id)) {
      list.push(id);
    }
  }

  function buildTreeLabelFromPrediction(
    prediction: Prediction,
    treeClass: TreeType,
    regionId: string,
    radiusOverride?: number | null
  ): TreeLabel | null {
    const crownRadius = radiusOverride ?? prediction.crownRadiusMeters;
    if (typeof crownRadius !== "number" || !Number.isFinite(crownRadius)) {
      return null;
    }
    const radius = Math.max(0, crownRadius);
    const estimate = estimateTreeHeightMeters(treeClass, radius);
    return {
      id: createId("tree"),
      regionId,
      class: treeClass,
      centerLat: prediction.centerLat,
      centerLon: prediction.centerLon,
      crownRadiusMeters: radius,
      derivedHeightMeters: estimate.heightMeters,
      heightModel: estimate.modelId,
      createdAt: Date.now()
    };
  }

  function createDenseCoverLabel(
    regionId: string,
    polygonLatLon: Array<{ lat: number; lon: number }>,
    options?: { edgeTreesOnly?: boolean; density?: number; edgeBandMeters?: number }
  ): DenseCoverLabel {
    return {
      id: createId("dense"),
      regionId,
      polygonLatLon,
      mode: "dense_cover",
      density: normalizeDenseCoverDensity(options?.density),
      edgeTreesOnly: options?.edgeTreesOnly ?? false,
      edgeBandMeters:
        typeof options?.edgeBandMeters === "number" ? options.edgeBandMeters : undefined,
      createdAt: Date.now()
    };
  }

  function buildDenseCoverLabelFromPrediction(
    prediction: Prediction,
    regionId: string
  ): DenseCoverLabel | null {
    if (!prediction.polygonLatLon || prediction.polygonLatLon.length < 3) {
      return null;
    }
    return createDenseCoverLabel(regionId, prediction.polygonLatLon, {
      edgeTreesOnly: denseCoverEdgeOnly?.checked ?? false
    });
  }

  function buildDenseCoverLabelFromPolygon(
    polygonLatLon: Array<{ lat: number; lon: number }>,
    regionId: string
  ): DenseCoverLabel | null {
    if (polygonLatLon.length < 3) {
      return null;
    }
    return createDenseCoverLabel(regionId, polygonLatLon, {
      edgeTreesOnly: denseCoverEdgeOnly?.checked ?? false
    });
  }

  function buildDenseCoverLabelFromPatch(
    centerLat: number,
    centerLon: number,
    regionId: string,
    zoom: number
  ): DenseCoverLabel | null {
    const metersPerPixel = metersPerPixelAtLat(centerLat, zoom);
    if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
      return null;
    }
    const halfMeters = (DEFAULT_PATCH_SIZE_PX * metersPerPixel) / 2;
    const deltaLat = (halfMeters / 6371000) * (180 / Math.PI);
    const deltaLon = deltaLat / Math.cos(toRadians(centerLat));
    if (!Number.isFinite(deltaLon)) {
      return null;
    }
    return createDenseCoverLabel(
      regionId,
      [
        { lat: centerLat - deltaLat, lon: centerLon - deltaLon },
        { lat: centerLat - deltaLat, lon: centerLon + deltaLon },
        { lat: centerLat + deltaLat, lon: centerLon + deltaLon },
        { lat: centerLat + deltaLat, lon: centerLon - deltaLon }
      ],
      {
        edgeTreesOnly: denseCoverEdgeOnly?.checked ?? false
      }
    );
  }

  function buildSignLabelFromPrediction(
    prediction: Prediction,
    regionId: string
  ): SignLabel | null {
    if (prediction.class !== "billboard" && prediction.class !== "stop_sign") {
      return null;
    }
    return {
      id: createId("sign"),
      regionId,
      class: prediction.class,
      lat: prediction.centerLat,
      lon: prediction.centerLon,
      yawDeg: prediction.yawDeg,
      createdAt: Date.now()
    };
  }

  function isTreeClass(value: PredictionClass): value is TreeType {
    return value === "tree_pine" || value === "tree_deciduous";
  }

  function formatReviewClass(value: PredictionClass): string {
    switch (value) {
      case "tree_pine":
        return "Pine tree";
      case "tree_deciduous":
        return "Deciduous tree";
      case "dense_cover":
        return "Dense cover";
      case "billboard":
        return "Billboard";
      case "stop_sign":
        return "Stop sign";
      default:
        return value;
    }
  }

  function normalizeReviewZoom(value: number, maxZoom: number): number {
    const upper = Math.min(maxZoom, REVIEW_MAX_ZOOM);
    const lower = Math.min(upper, REVIEW_MIN_ZOOM);
    if (!Number.isFinite(value)) {
      return upper;
    }
    return Math.max(lower, Math.min(upper, Math.round(value)));
  }

  function resolveReviewTileSource(providerId: string): TileSource {
    const normalized = providerId.trim().toLowerCase();
    if (normalized === "street" || normalized.includes("osm")) {
      return getTileSource("street");
    }
    if (normalized === "autostreet" || normalized === "auto_street" || normalized === "auto-street") {
      return getTileSource("autoStreet");
    }
    if (normalized === "satellite" || normalized.includes("esri") || normalized.includes("imagery")) {
      return getTileSource("satellite");
    }
    if (isTileSourceId(providerId)) {
      return getTileSource(providerId);
    }
    return getTileSource("satellite");
  }

  function isTileSourceId(value: string): value is TileSourceId {
    return value === "street" || value === "satellite" || value === "autoStreet";
  }

  function toPatchPoint(lat: number, lon: number, patch: ReviewPatch): Point {
    const center = projectLatLonForReview(patch.centerLat, patch.centerLon, patch.zoom);
    const target = projectLatLonForReview(lat, lon, patch.zoom);
    return {
      x: patch.sizePx / 2 + (target.x - center.x),
      y: patch.sizePx / 2 + (target.y - center.y)
    };
  }

  function patchPointToLatLon(point: Point, patch: ReviewPatch): GeoPoint {
    const center = projectLatLonForReview(patch.centerLat, patch.centerLon, patch.zoom);
    const world = {
      x: center.x + (point.x - patch.sizePx / 2),
      y: center.y + (point.y - patch.sizePx / 2)
    };
    return unprojectLatLonForReview(world.x, world.y, patch.zoom);
  }

  function projectLatLonForReview(lat: number, lon: number, zoom: number): Point {
    const sinLat = Math.sin((lat * Math.PI) / 180);
    const scale = 256 * Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * scale;
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return { x, y };
  }

  function unprojectLatLonForReview(x: number, y: number, zoom: number): GeoPoint {
    const scale = 256 * Math.pow(2, zoom);
    const lon = (x / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lon };
  }

  function render() {
    if (!geoProjector) {
      return;
    }
    ctx.clearRect(0, 0, geoProjector.size.width, geoProjector.size.height);
    drawRegions();
    drawDenseCover();
    drawTrees();
    drawSigns();
    drawSelection();
    drawInProgress();
  }

  function drawRegions() {
    dataset.regions.forEach((region) => {
      const points = region.boundsPolygonLatLon.map((point) =>
        geoProjector!.latLonToPixel(point.lat, point.lon)
      );
      if (points.length < 2) {
        return;
      }
      ctx.save();
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.closePath();
      ctx.strokeStyle = region.id === activeRegionId ? COLORS.regionActive : COLORS.region;
      ctx.lineWidth = region.id === activeRegionId ? 2 : 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawDenseCover() {
    dataset.denseCover.forEach((dense) => {
      const points = dense.polygonLatLon.map((point) =>
        geoProjector!.latLonToPixel(point.lat, point.lon)
      );
      if (points.length < 3) {
        return;
      }
      ctx.save();
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.closePath();
      ctx.fillStyle = COLORS.denseFill;
      ctx.strokeStyle = COLORS.denseStroke;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawTrees() {
    dataset.trees.forEach((tree) => {
      const center = geoProjector!.latLonToPixel(tree.centerLat, tree.centerLon);
      const radiusPx = metersToPixels(tree.crownRadiusMeters, tree.centerLat, tree.centerLon);
      ctx.save();
      ctx.beginPath();
      ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
      ctx.fillStyle = tree.class === "tree_pine" ? COLORS.treePine : COLORS.treeDeciduous;
      ctx.strokeStyle = COLORS.treeStroke;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawSigns() {
    dataset.signs.forEach((sign) => {
      const center = geoProjector!.latLonToPixel(sign.lat, sign.lon);
      ctx.save();
      ctx.beginPath();
      ctx.arc(center.x, center.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = sign.class === "billboard" ? COLORS.signBillboard : COLORS.signStop;
      ctx.fill();
      if (typeof sign.yawDeg === "number") {
        const dir = yawToVector(sign.yawDeg, 14);
        ctx.beginPath();
        ctx.moveTo(center.x, center.y);
        ctx.lineTo(center.x + dir.x, center.y + dir.y);
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  function drawSelection() {
    const selection = selectedLabel;
    const projector = geoProjector;
    if (!selection || !projector) return;
    ctx.save();
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 2.5;
    if (selection.kind === "tree") {
      const tree = dataset.trees.find((label) => label.id === selection.id);
      if (!tree) return;
      const center = projector.latLonToPixel(tree.centerLat, tree.centerLon);
      const radiusPx = metersToPixels(tree.crownRadiusMeters, tree.centerLat, tree.centerLon);
      ctx.beginPath();
      ctx.arc(center.x, center.y, radiusPx + 3, 0, Math.PI * 2);
      ctx.stroke();
    } else if (selection.kind === "dense_cover") {
      const dense = dataset.denseCover.find((label) => label.id === selection.id);
      if (!dense) return;
      const points = dense.polygonLatLon.map((point) =>
        projector.latLonToPixel(point.lat, point.lon)
      );
      if (points.length < 3) return;
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.stroke();
    } else if (selection.kind === "sign") {
      const sign = dataset.signs.find((label) => label.id === selection.id);
      if (!sign) return;
      const center = projector.latLonToPixel(sign.lat, sign.lon);
      ctx.beginPath();
      ctx.arc(center.x, center.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawInProgress() {
    const projector = geoProjector;
    if (!drawingState || !projector) return;
    ctx.save();
    if (drawingState.kind === "tree") {
      const radiusPx = distancePx(drawingState.centerPx, drawingState.currentPx);
      ctx.beginPath();
      ctx.arc(drawingState.centerPx.x, drawingState.centerPx.y, radiusPx, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      const edgeLatLon = projector.pixelToLatLon(drawingState.currentPx.x, drawingState.currentPx.y);
      const radiusMeters = distanceMeters(drawingState.centerLatLon, edgeLatLon);
      const estimate = estimateTreeHeightMeters(drawingState.treeType, radiusMeters);
      const text = `r ${formatNumber(radiusMeters)} m (${formatNumber(
        metersToFeet(radiusMeters)
      )} ft) · h ${formatNumber(estimate.heightMeters)} m`;
      const textX = drawingState.currentPx.x + 12;
      const textY = drawingState.currentPx.y - 12;
      ctx.save();
      ctx.font = "12px 'Segoe UI', sans-serif";
      ctx.fillStyle = "rgba(10, 14, 20, 0.7)";
      const width = ctx.measureText(text).width + 10;
      ctx.fillRect(textX - 5, textY - 14, width, 18);
      ctx.fillStyle = "#e2e8f0";
      ctx.fillText(text, textX, textY);
      ctx.restore();
    } else if (drawingState.kind === "polygon") {
      const points = drawingState.points.map((point) =>
        projector.latLonToPixel(point.lat, point.lon)
      );
      if (points.length > 0) {
        ctx.beginPath();
        points.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        if (pointerPosition) {
          ctx.lineTo(pointerPosition.x, pointerPosition.y);
        }
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
      }
    } else if (drawingState.kind === "sign") {
      ctx.beginPath();
      ctx.arc(drawingState.startPx.x, drawingState.startPx.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (drawingState.currentPx) {
        ctx.beginPath();
        ctx.moveTo(drawingState.startPx.x, drawingState.startPx.y);
        ctx.lineTo(drawingState.currentPx.x, drawingState.currentPx.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function pickLabelAtPixel(point: Point): LabelSelection {
    const projector = geoProjector;
    if (!projector) return null;
    for (let i = dataset.signs.length - 1; i >= 0; i -= 1) {
      const sign = dataset.signs[i];
      const center = projector.latLonToPixel(sign.lat, sign.lon);
      if (distancePx(point, center) <= 8) {
        return { kind: "sign", id: sign.id };
      }
    }
    for (let i = dataset.trees.length - 1; i >= 0; i -= 1) {
      const tree = dataset.trees[i];
      const center = projector.latLonToPixel(tree.centerLat, tree.centerLon);
      const radiusPx = metersToPixels(tree.crownRadiusMeters, tree.centerLat, tree.centerLon);
      if (distancePx(point, center) <= radiusPx + 4) {
        return { kind: "tree", id: tree.id };
      }
    }
    for (let i = dataset.denseCover.length - 1; i >= 0; i -= 1) {
      const dense = dataset.denseCover[i];
      const polygon = dense.polygonLatLon.map((node) =>
        projector.latLonToPixel(node.lat, node.lon)
      );
      if (polygon.length >= 3 && pointInPolygon(point, polygon)) {
        return { kind: "dense_cover", id: dense.id };
      }
    }
    return null;
  }

  function polygonTypeForTool(tool: Tool): "region" | "dense_cover" {
    return tool === "new_region" ? "region" : "dense_cover";
  }

  function readRegionMode(): DatasetRegion["labelingMode"] {
    const selected = document.querySelector<HTMLInputElement>(
      'input[name="trainerRegionMode"]:checked'
    );
    return selected?.value === "exhaustive" ? "exhaustive" : "sparse";
  }

  function shouldIgnoreKeyboard(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
  }

  function toCanvasPoint(event: PointerEvent, target: HTMLCanvasElement): Point {
    const rect = target.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function toReviewCanvasPoint(event: PointerEvent, target: HTMLCanvasElement): Point {
    const rect = target.getBoundingClientRect();
    const scaleX = target.width / Math.max(1, rect.width);
    const scaleY = target.height / Math.max(1, rect.height);
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  }

  function polygonCentroid(points: Point[]): Point {
    let x = 0;
    let y = 0;
    points.forEach((point) => {
      x += point.x;
      y += point.y;
    });
    const count = points.length || 1;
    return { x: x / count, y: y / count };
  }

  function clampPointToPatch(point: Point, patch: ReviewPatch): Point {
    return {
      x: Math.max(0, Math.min(patch.sizePx, point.x)),
      y: Math.max(0, Math.min(patch.sizePx, point.y))
    };
  }

  function findVertexHandleIndex(point: Point, polygon: Point[]): number | null {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    polygon.forEach((vertex, index) => {
      const distance = distancePx(point, vertex);
      if (distance <= EDIT_HANDLE_RADIUS_PX && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex >= 0 ? bestIndex : null;
  }

  function findEdgeInsert(
    point: Point,
    polygon: Point[]
  ): { index: number; point: Point } | null {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestPoint: Point | null = null;
    for (let i = 0; i < polygon.length; i += 1) {
      const next = polygon[(i + 1) % polygon.length];
      const result = distanceToSegment(point, polygon[i], next);
      if (result.distance < bestDistance) {
        bestDistance = result.distance;
        bestIndex = i;
        bestPoint = result.closest;
      }
    }
    if (bestIndex < 0 || bestDistance > EDIT_EDGE_THRESHOLD_PX || !bestPoint) {
      return null;
    }
    return { index: bestIndex, point: bestPoint };
  }

  function distanceToSegment(point: Point, start: Point, end: Point): {
    distance: number;
    closest: Point;
  } {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) {
      return { distance: distancePx(point, start), closest: { ...start } };
    }
    const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
    const clamped = Math.max(0, Math.min(1, t));
    const closest = { x: start.x + clamped * dx, y: start.y + clamped * dy };
    return { distance: distancePx(point, closest), closest };
  }

  function metersToFeet(meters: number): number {
    return meters * METERS_TO_FEET;
  }

  function feetToMeters(feet: number): number {
    return feet / METERS_TO_FEET;
  }

  function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return "0";
    return value.toFixed(2);
  }

  function formatAxisNumber(value: number): string {
    if (!Number.isFinite(value)) return "0";
    const abs = Math.abs(value);
    if (abs >= 1000) return value.toFixed(0);
    if (abs >= 100) return value.toFixed(1);
    if (abs >= 10) return value.toFixed(2);
    return value.toFixed(2);
  }

  function drawHistogram(canvas: HTMLCanvasElement | null, histogram: Histogram): void {
    if (!canvas) {
      return;
    }
    const prepared = prepareChartCanvas(canvas);
    if (!prepared) {
      return;
    }
    const { ctx, width, height } = prepared;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#12171f";
    ctx.fillRect(0, 0, width, height);

    if (histogram.bins.length === 0) {
      drawNoData(ctx, width, height);
      return;
    }

    const padding = { left: 28, right: 10, top: 16, bottom: 20 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const maxCount = Math.max(1, histogram.maxCount);
    const barWidth = plotWidth / histogram.bins.length;

    ctx.strokeStyle = "#2e3846";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    histogram.bins.forEach((bin, index) => {
      const barHeight = (bin.count / maxCount) * plotHeight;
      const x = padding.left + index * barWidth + barWidth * 0.15;
      const y = height - padding.bottom - barHeight;
      ctx.fillStyle = "#7fb6ff";
      ctx.fillRect(x, y, barWidth * 0.7, barHeight);
    });

    ctx.fillStyle = "#cfd6e3";
    ctx.font = "11px sans-serif";
    const minLabel = formatAxisNumber(histogram.min);
    const maxLabel = formatAxisNumber(histogram.max);
    ctx.fillText(minLabel, padding.left, height - 6);
    const maxWidth = ctx.measureText(maxLabel).width;
    ctx.fillText(maxLabel, padding.left + plotWidth - maxWidth, height - 6);
  }

  function drawScatter(
    canvas: HTMLCanvasElement | null,
    points: Array<{ x: number; y: number }>
  ): void {
    if (!canvas) {
      return;
    }
    const prepared = prepareChartCanvas(canvas);
    if (!prepared) {
      return;
    }
    const { ctx, width, height } = prepared;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#12171f";
    ctx.fillRect(0, 0, width, height);

    if (points.length === 0) {
      drawNoData(ctx, width, height);
      return;
    }

    let minX = points[0].x;
    let maxX = points[0].x;
    let minY = points[0].y;
    let maxY = points[0].y;
    points.forEach((point) => {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    });
    if (minX === maxX) {
      minX -= 1;
      maxX += 1;
    }
    if (minY === maxY) {
      minY -= 1;
      maxY += 1;
    }

    const padding = { left: 28, right: 10, top: 16, bottom: 20 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    ctx.strokeStyle = "#2e3846";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    ctx.fillStyle = "#f7d46a";
    points.forEach((point) => {
      const x = padding.left + ((point.x - minX) / (maxX - minX)) * plotWidth;
      const y = height - padding.bottom - ((point.y - minY) / (maxY - minY)) * plotHeight;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = "#cfd6e3";
    ctx.font = "11px sans-serif";
    ctx.fillText(formatAxisNumber(minX), padding.left, height - 6);
    const maxXLabel = formatAxisNumber(maxX);
    ctx.fillText(
      maxXLabel,
      padding.left + plotWidth - ctx.measureText(maxXLabel).width,
      height - 6
    );
    ctx.fillText(formatAxisNumber(maxY), 4, padding.top + 8);
  }

  function prepareChartCanvas(
    canvas: HTMLCanvasElement
  ): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: rect.width, height: rect.height };
  }

  function drawNoData(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = "#5f6977";
    ctx.font = "11px sans-serif";
    const label = "No data";
    const metrics = ctx.measureText(label);
    ctx.fillText(label, (width - metrics.width) / 2, height / 2);
  }

  function scheduleRepoSync(next: TrainerDataset, immediate = false): void {
    if (!trainerSyncEnabledEnv || !trainerSyncEnabled) {
      return;
    }
    syncDatasetSnapshot = next;
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (immediate) {
      void performRepoSync(next);
      return;
    }
    syncTimer = setTimeout(() => {
      syncTimer = null;
      if (syncDatasetSnapshot) {
        void performRepoSync(syncDatasetSnapshot);
      }
    }, TRAINER_SYNC_DEBOUNCE_MS);
  }

  async function performRepoSync(next: TrainerDataset): Promise<void> {
    if (!trainerSyncEnabledEnv || !trainerSyncEnabled) {
      return;
    }
    if (syncInFlight) {
      syncPending = true;
      return;
    }
    syncInFlight = true;
    syncPending = false;
    try {
      await syncDatasetAndManifest(next);
      await syncSamplesToRepo(next);
      lastSyncedAt = Date.now();
      saveTrainerSyncState({
        lastSyncedAt,
        sampleUpdatedAtById: Object.fromEntries(syncedSampleUpdatedAt)
      });
      setSyncStatus(`Synced at ${formatClockTime(lastSyncedAt)}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed.";
      setSyncStatus(`Sync failed: ${message}`);
    } finally {
      syncInFlight = false;
      if (syncPending && syncDatasetSnapshot) {
        syncPending = false;
        scheduleRepoSync(syncDatasetSnapshot, true);
      }
    }
  }

  async function syncDatasetAndManifest(next: TrainerDataset): Promise<void> {
    const datasetPayload = buildRepoDataset(next);
    const manifestPayload = buildRepoManifest(next);
    await postTrainerSync("/__trainer/sync/dataset", datasetPayload);
    await postTrainerSync("/__trainer/sync/manifest", manifestPayload);
  }

  async function syncSamplesToRepo(next: TrainerDataset): Promise<void> {
    const changedSamples = next.samples.filter((sample) => {
      const lastSynced = syncedSampleUpdatedAt.get(sample.id) ?? 0;
      return sample.updatedAt > lastSynced;
    });
    for (const sample of changedSamples) {
      const blob = await getSampleImage(sample.id);
      if (!blob) {
        continue;
      }
      const pngBase64 = await blobToBase64(blob);
      if (!pngBase64) {
        continue;
      }
      await postTrainerSync("/__trainer/sync/sample", {
        sampleId: sample.id,
        pngBase64,
        labelJson: sanitizeSampleLabel(sample)
      });
      syncedSampleUpdatedAt.set(sample.id, sample.updatedAt);
    }
    const activeIds = new Set(next.samples.map((sample) => sample.id));
    Array.from(syncedSampleUpdatedAt.keys()).forEach((id) => {
      if (!activeIds.has(id)) {
        syncedSampleUpdatedAt.delete(id);
      }
    });
  }

  async function postTrainerSync(path: string, payload: unknown): Promise<void> {
    const response = await fetch(path, {
      method: "POST",
      headers: buildTrainerSyncHeaders(),
      body: JSON.stringify(payload ?? {})
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed (${response.status}).`);
    }
  }

  function buildTrainerSyncHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-VisOpti-Trainer": "1"
    };
    if (trainerSyncEnabled && readTrainerSyncFlag()) {
      headers["X-VisOpti-Trainer-Token"] = "1";
    }
    return headers;
  }

  function buildRepoDataset(next: TrainerDataset) {
    return {
      version: next.version,
      imagery: next.imagery,
      trainingConfig: next.trainingConfig,
      samples: next.samples.map((sample) => sanitizeSampleLabel(sample)),
      reviews: next.reviews,
      metadata: {
        schemaVersion: TRAINER_SYNC_SCHEMA_VERSION,
        syncedAt: Date.now()
      }
    };
  }

  function buildRepoManifest(next: TrainerDataset) {
    const sampleCounts: Record<string, number> = {};
    next.samples.forEach((sample) => {
      sampleCounts[sample.class] = (sampleCounts[sample.class] ?? 0) + 1;
    });
    return {
      schemaVersion: TRAINER_SYNC_SCHEMA_VERSION,
      lastSyncClientTs: Date.now(),
      counts: {
        regions: next.regions.length,
        trees: next.trees.length,
        denseCover: next.denseCover.length,
        signs: next.signs.length,
        negatives: next.negatives.length,
        samples: next.samples.length,
        samplesByClass: sampleCounts
      }
    };
  }

  function sanitizeSampleLabel(sample: SampleRecord) {
    return {
      id: sample.id,
      class: sample.class,
      annotations: sample.annotations,
      sourceKey: sample.sourceKey,
      createdAt: sample.createdAt,
      updatedAt: sample.updatedAt
    };
  }

  function scheduleSampleSync(next: TrainerDataset): void {
    const signature = buildSampleSignature(next);
    if (signature === sampleSignature) {
      return;
    }
    sampleSignature = signature;
    const token = (sampleSyncToken += 1);
    void regenerateTrainingSamples(next, token);
  }

  function buildSampleSignature(next: TrainerDataset): string {
    const treeSignature = next.trees
      .map(
        (tree) =>
          `${tree.id}:${tree.class}:${tree.centerLat.toFixed(6)}:${tree.centerLon.toFixed(
            6
          )}:${tree.crownRadiusMeters.toFixed(3)}`
      )
      .sort()
      .join("|");
    const denseSignature = next.denseCover
      .map((dense) => {
        const polygon = dense.polygonLatLon
          .map((point) => `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`)
          .join(";");
        return `${dense.id}:${normalizeDenseCoverDensity(dense.density)}:${dense.edgeTreesOnly}:${
          dense.edgeBandMeters ?? ""
        }:${polygon}`;
      })
      .sort()
      .join("|");
    return [
      next.imagery.providerId,
      JSON.stringify(next.trainingConfig),
      treeSignature,
      denseSignature
    ].join("::");
  }

  async function regenerateTrainingSamples(next: TrainerDataset, token: number): Promise<void> {
    const tileSource = resolveReviewTileSource(next.imagery.providerId);
    const config = next.trainingConfig;
    const patchSizePx = normalizePatchSize(config.patchSizePx);
    const treeZoom = normalizeTrainingZoom(config.treeZoom, tileSource.maxZoom);
    const denseZoom = normalizeTrainingZoom(config.denseCoverZoom, tileSource.maxZoom);
    const existingById = new Map(next.samples.map((sample) => [sample.id, sample]));
    const managedClasses = new Set<SampleRecord["class"]>([
      "tree_pine",
      "tree_deciduous",
      "dense_cover"
    ]);
    const desiredSamples: SampleRecord[] = [];
    const desiredIds = new Set<string>();

    for (const tree of next.trees) {
      const result = await buildTreeSample(tree, {
        patchSizePx,
        zoom: treeZoom,
        contextMultiplier: config.treeContextRadiusMultiplier,
        maxZoom: tileSource.maxZoom,
        providerId: next.imagery.providerId,
        tileSource,
        existingById
      });
      if (!result) {
        continue;
      }
      if (token !== sampleSyncToken) {
        return;
      }
      desiredSamples.push(result.record);
      desiredIds.add(result.record.id);
      await putSampleImage(result.record.id, result.blob);
    }

    const denseCenters = buildDenseCoverSampleCenters(next.denseCover, config);
    for (const center of denseCenters) {
      const result = await buildDenseCoverSample(center, {
        patchSizePx,
        zoom: denseZoom,
        providerId: next.imagery.providerId,
        tileSource,
        existingById
      });
      if (!result) {
        continue;
      }
      if (token !== sampleSyncToken) {
        return;
      }
      if (!desiredIds.has(result.record.id)) {
        desiredSamples.push(result.record);
        desiredIds.add(result.record.id);
        await putSampleImage(result.record.id, result.blob);
      }
    }

    if (token !== sampleSyncToken) {
      return;
    }

    const obsoleteIds = next.samples
      .filter((sample) => managedClasses.has(sample.class) && !desiredIds.has(sample.id))
      .map((sample) => sample.id);
    for (const id of obsoleteIds) {
      await deleteSample(id);
    }

    store.update((draft) => {
      const preserved = draft.samples.filter(
        (sample) => !managedClasses.has(sample.class) && !desiredIds.has(sample.id)
      );
      draft.samples = [...preserved, ...desiredSamples];
    });
  }

  async function buildTreeSample(
    tree: TreeLabel,
    options: {
      patchSizePx: number;
      zoom: number;
      contextMultiplier: number;
      maxZoom: number;
      providerId: string;
      tileSource: TileSource;
      existingById: Map<string, SampleRecord>;
    }
  ): Promise<{ record: SampleRecord; blob: Blob } | null> {
    const adjustedZoom = adjustTreeZoom(
      tree,
      options.zoom,
      options.patchSizePx,
      options.contextMultiplier,
      options.maxZoom
    );
    const sourceKey = await buildSourceKey({
      providerId: options.providerId,
      zoom: adjustedZoom,
      lat: tree.centerLat,
      lon: tree.centerLon,
      patchSizePx: options.patchSizePx
    });
    if (!sourceKey) {
      return null;
    }
    const metersPerPixel = metersPerPixelAtLat(tree.centerLat, adjustedZoom);
    const radiusPx =
      metersPerPixel > 0 ? tree.crownRadiusMeters / metersPerPixel : 0;
    const centerPx = options.patchSizePx / 2;
    const existing = options.existingById.get(sourceKey);
    const now = Date.now();
    const record: SampleRecord = {
      id: sourceKey,
      class: tree.class,
      annotations: [
        {
          kind: "circle",
          centerPx: { x: centerPx, y: centerPx },
          radiusPx
        }
      ],
      sourceKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const blob = await renderSampleBlob({
      centerLat: tree.centerLat,
      centerLon: tree.centerLon,
      zoom: adjustedZoom,
      sizePx: options.patchSizePx,
      tileSource: options.tileSource
    });
    return { record, blob };
  }

  async function buildDenseCoverSample(
    center: GeoPoint,
    options: {
      patchSizePx: number;
      zoom: number;
      providerId: string;
      tileSource: TileSource;
      existingById: Map<string, SampleRecord>;
    }
  ): Promise<{ record: SampleRecord; blob: Blob } | null> {
    const sourceKey = await buildSourceKey({
      providerId: options.providerId,
      zoom: options.zoom,
      lat: center.lat,
      lon: center.lon,
      patchSizePx: options.patchSizePx
    });
    if (!sourceKey) {
      return null;
    }
    const existing = options.existingById.get(sourceKey);
    const now = Date.now();
    const record: SampleRecord = {
      id: sourceKey,
      class: "dense_cover",
      annotations: [],
      sourceKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const blob = await renderSampleBlob({
      centerLat: center.lat,
      centerLon: center.lon,
      zoom: options.zoom,
      sizePx: options.patchSizePx,
      tileSource: options.tileSource
    });
    return { record, blob };
  }

  async function renderSampleBlob(input: {
    centerLat: number;
    centerLon: number;
    zoom: number;
    sizePx: number;
    tileSource: TileSource;
  }): Promise<Blob> {
    const canvas = await renderPatchImage({
      centerLatLon: { lat: input.centerLat, lon: input.centerLon },
      zoom: input.zoom,
      sizePx: input.sizePx,
      tileSource: input.tileSource
    });
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (!value) {
          reject(new Error("Failed to encode PNG."));
          return;
        }
        resolve(value);
      }, "image/png");
    });
    return blob;
  }

  async function buildSourceKey(input: {
    providerId: string;
    zoom: number;
    lat: number;
    lon: number;
    patchSizePx: number;
  }): Promise<string | null> {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      return null;
    }
    const latKey = Number.isFinite(input.lat) ? input.lat.toFixed(5) : "0";
    const lonKey = Number.isFinite(input.lon) ? input.lon.toFixed(5) : "0";
    const payload = `${input.providerId}|z${input.zoom}|cx${latKey}|cy${lonKey}|px${input.patchSizePx}`;
    const data = new TextEncoder().encode(payload);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  function buildDenseCoverSampleCenters(
    denseCover: DenseCoverLabel[],
    config: TrainingSamplingConfig
  ): GeoPoint[] {
    const points: GeoPoint[] = [];
    const seen = new Set<string>();
    denseCover.forEach((dense) => {
      if (dense.polygonLatLon.length < 3) {
        return;
      }
      const projection = buildLocalProjection(dense.polygonLatLon);
      if (!projection) {
        return;
      }
      const polygon = dense.polygonLatLon.map((point) => toLocalPoint(point, projection));
      const bounds = computeBounds(polygon);
      if (!bounds) {
        return;
      }
      const interiorSpacing = Math.max(1, config.denseCoverInteriorSampleSpacingMeters);
      const edgeSpacing = Math.max(1, config.denseCoverEdgeSampleSpacingMeters);
      const edgeBand = Math.max(
        0,
        typeof dense.edgeBandMeters === "number" ? dense.edgeBandMeters : config.edgeBandMeters
      );

      const pushPoint = (localPoint: LocalPoint) => {
        const latLon = toLatLon(localPoint, projection);
        const key = `${latLon.lat.toFixed(5)}:${latLon.lon.toFixed(5)}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        points.push(latLon);
      };

      samplePolygonGrid(polygon, bounds, interiorSpacing, undefined, pushPoint);
      if (dense.edgeTreesOnly && edgeBand > 0) {
        samplePolygonGrid(polygon, bounds, edgeSpacing, edgeBand, pushPoint);
      }
    });
    return points;
  }

  function samplePolygonGrid(
    polygon: LocalPoint[],
    bounds: LocalBounds,
    spacing: number,
    edgeBandMeters: number | undefined,
    onPoint: (point: LocalPoint) => void
  ): void {
    if (spacing <= 0) {
      return;
    }
    const offset = spacing / 2;
    for (let x = bounds.minX + offset; x <= bounds.maxX; x += spacing) {
      for (let y = bounds.minY + offset; y <= bounds.maxY; y += spacing) {
        const point = { x, y };
        if (!pointInPolygon(point, polygon)) {
          continue;
        }
        if (edgeBandMeters !== undefined) {
          const distance = distanceToPolygon(point, polygon);
          if (distance > edgeBandMeters) {
            continue;
          }
        }
        onPoint(point);
      }
    }
  }

  function distanceToPolygon(point: LocalPoint, polygon: LocalPoint[]): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < polygon.length; i += 1) {
      const next = polygon[(i + 1) % polygon.length];
      const result = distanceToSegment(point, polygon[i], next);
      best = Math.min(best, result.distance);
    }
    return best;
  }

  interface LocalPoint {
    x: number;
    y: number;
  }

  interface LocalBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  interface LocalProjection {
    originLat: number;
    originLon: number;
    metersPerDegLat: number;
    metersPerDegLon: number;
  }

  function buildLocalProjection(points: Array<{ lat: number; lon: number }>): LocalProjection | null {
    const origin = averageLatLon(points);
    if (!origin) {
      return null;
    }
    const latRad = toRadians(origin.lat);
    const metersPerDegLat = 111132;
    const metersPerDegLon = 111320 * Math.cos(latRad);
    if (!Number.isFinite(metersPerDegLon) || metersPerDegLon === 0) {
      return null;
    }
    return {
      originLat: origin.lat,
      originLon: origin.lon,
      metersPerDegLat,
      metersPerDegLon
    };
  }

  function toLocalPoint(point: GeoPoint, projection: LocalProjection): LocalPoint {
    return {
      x: (point.lon - projection.originLon) * projection.metersPerDegLon,
      y: (point.lat - projection.originLat) * projection.metersPerDegLat
    };
  }

  function toLatLon(point: LocalPoint, projection: LocalProjection): GeoPoint {
    return {
      lat: point.y / projection.metersPerDegLat + projection.originLat,
      lon: point.x / projection.metersPerDegLon + projection.originLon
    };
  }

  function computeBounds(points: LocalPoint[]): LocalBounds | null {
    if (points.length === 0) {
      return null;
    }
    let minX = points[0].x;
    let maxX = points[0].x;
    let minY = points[0].y;
    let maxY = points[0].y;
    points.forEach((point) => {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    });
    return { minX, minY, maxX, maxY };
  }

  function normalizeDenseCoverDensity(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 0.7;
    }
    if (value <= 0.4) {
      return 0.4;
    }
    if (value <= 0.7) {
      return 0.7;
    }
    return 1.0;
  }

  function normalizeTrainingZoom(value: number, maxZoom: number): number {
    if (!Number.isFinite(value)) {
      return Math.min(20, maxZoom);
    }
    return Math.max(1, Math.min(maxZoom, Math.round(value)));
  }

  function adjustTreeZoom(
    tree: TreeLabel,
    baseZoom: number,
    patchSizePx: number,
    contextMultiplier: number,
    maxZoom: number
  ): number {
    if (!Number.isFinite(contextMultiplier) || contextMultiplier <= 0) {
      return baseZoom;
    }
    const desiredRadiusMeters = tree.crownRadiusMeters * contextMultiplier;
    if (!Number.isFinite(desiredRadiusMeters) || desiredRadiusMeters <= 0) {
      return baseZoom;
    }
    const desiredMetersPerPixel = desiredRadiusMeters / (patchSizePx / 2);
    if (!Number.isFinite(desiredMetersPerPixel) || desiredMetersPerPixel <= 0) {
      return baseZoom;
    }
    const zoomForContext = zoomFromMetersPerPixel(tree.centerLat, desiredMetersPerPixel);
    return normalizeTrainingZoom(Math.min(baseZoom, zoomForContext), maxZoom);
  }

  function zoomFromMetersPerPixel(lat: number, metersPerPixel: number): number {
    const latRad = toRadians(lat);
    const circumference = 2 * Math.PI * 6378137;
    const denominator = 256 * metersPerPixel;
    if (denominator <= 0) {
      return 0;
    }
    const scale = (Math.cos(latRad) * circumference) / denominator;
    if (!Number.isFinite(scale) || scale <= 0) {
      return 0;
    }
    return Math.log2(scale);
  }

  function normalizePatchSize(value: number): number {
    if (!Number.isFinite(value)) {
      return 512;
    }
    return Math.max(64, Math.round(value));
  }

  function applyMlNms<
    T extends PatchPrediction & { worldCx: number; worldCy: number; worldW: number; worldH: number }
  >(detections: T[], iouThreshold: number): T[] {
    const byClass = new Map<string, T[]>();
    detections.forEach((detection) => {
      const list = byClass.get(detection.class) ?? [];
      list.push(detection);
      byClass.set(detection.class, list);
    });
    const results: T[] = [];
    byClass.forEach((list) => {
      list.sort((a, b) => b.confidence - a.confidence);
      const kept: T[] = [];
      list.forEach((candidate) => {
        const overlaps = kept.some((existing) => mlIou(candidate, existing) > iouThreshold);
        if (!overlaps) {
          kept.push(candidate);
        }
      });
      results.push(...kept);
    });
    return results;
  }

  function mlIou(
    a: PatchPrediction & { worldCx: number; worldCy: number; worldW: number; worldH: number },
    b: PatchPrediction & { worldCx: number; worldCy: number; worldW: number; worldH: number }
  ): number {
    const aMinX = a.worldCx - a.worldW / 2;
    const aMinY = a.worldCy - a.worldH / 2;
    const aMaxX = a.worldCx + a.worldW / 2;
    const aMaxY = a.worldCy + a.worldH / 2;
    const bMinX = b.worldCx - b.worldW / 2;
    const bMinY = b.worldCy - b.worldH / 2;
    const bMaxX = b.worldCx + b.worldW / 2;
    const bMaxY = b.worldCy + b.worldH / 2;
    const interW = Math.max(0, Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX));
    const interH = Math.max(0, Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY));
    const interArea = interW * interH;
    if (interArea <= 0) {
      return 0;
    }
    const areaA = a.worldW * a.worldH;
    const areaB = b.worldW * b.worldH;
    return interArea / (areaA + areaB - interArea);
  }

  function createId(prefix: string): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function distancePx(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function distanceMeters(a: GeoPoint, b: GeoPoint): number {
    if (map && typeof map.distance === "function") {
      return map.distance({ lat: a.lat, lng: a.lon }, { lat: b.lat, lng: b.lon });
    }
    return haversineMeters(a, b);
  }

  function haversineMeters(a: GeoPoint, b: GeoPoint): number {
    const radius = 6371000;
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const deltaLat = toRadians(b.lat - a.lat);
    const deltaLon = toRadians(b.lon - a.lon);
    const sinLat = Math.sin(deltaLat / 2);
    const sinLon = Math.sin(deltaLon / 2);
    const h =
      sinLat * sinLat +
      Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearingDegrees(a: GeoPoint, b: GeoPoint): number {
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const deltaLon = toRadians(b.lon - a.lon);
    const y = Math.sin(deltaLon) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    return normalizeDegrees(toDegrees(Math.atan2(y, x)));
  }

  function normalizeDegrees(value: number): number {
    const normalized = value % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  function yawToVector(yawDeg: number, length: number): Point {
    const radians = toRadians(yawDeg);
    return {
      x: Math.sin(radians) * length,
      y: -Math.cos(radians) * length
    };
  }

  function toRadians(deg: number): number {
    return (deg * Math.PI) / 180;
  }

  function toDegrees(rad: number): number {
    return (rad * 180) / Math.PI;
  }

  function metersToPixels(radiusMeters: number, lat: number, lon: number): number {
    if (!geoProjector) return 0;
    const earth = 6371000;
    const deltaLat = (radiusMeters / earth) * (180 / Math.PI);
    const deltaLon = deltaLat / Math.cos(toRadians(lat));
    const center = geoProjector.latLonToPixel(lat, lon);
    const edge = geoProjector.latLonToPixel(lat, lon + deltaLon);
    return distancePx(center, edge);
  }

  function pointInPolygon(point: Point, polygon: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;
      const intersect =
        yi > point.y !== yj > point.y &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
}

function readTrainerSyncFlag(): boolean {
  try {
    return window.localStorage.getItem(TRAINER_SYNC_FLAG) === "1";
  } catch {
    return false;
  }
}

function writeTrainerSyncFlag(enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage.setItem(TRAINER_SYNC_FLAG, "1");
    } else {
      window.localStorage.removeItem(TRAINER_SYNC_FLAG);
    }
  } catch {
    // Ignore storage failures.
  }
}

function loadTrainerSyncState(): {
  lastSyncedAt?: number;
  sampleUpdatedAtById?: Record<string, number>;
} {
  try {
    const raw = window.localStorage.getItem(TRAINER_SYNC_STATE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as {
      lastSyncedAt?: number;
      sampleUpdatedAtById?: Record<string, number>;
    };
    return {
      lastSyncedAt: typeof parsed.lastSyncedAt === "number" ? parsed.lastSyncedAt : undefined,
      sampleUpdatedAtById:
        parsed.sampleUpdatedAtById && typeof parsed.sampleUpdatedAtById === "object"
          ? parsed.sampleUpdatedAtById
          : undefined
    };
  } catch {
    return {};
  }
}

function saveTrainerSyncState(state: {
  lastSyncedAt?: number;
  sampleUpdatedAtById?: Record<string, number>;
}): void {
  try {
    window.localStorage.setItem(TRAINER_SYNC_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures.
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64] = result.split(",", 2);
      resolve(base64 || "");
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

void initTrainer();
