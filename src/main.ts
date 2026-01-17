import {
  createDrawingManager,
  ToolMode,
  type FeatureSelection,
  type StructureOverlayData,
  type StructureRenderData,
  type WorldLayer
} from "./drawing";
import { createThreeView, type TrafficFlowData, type ThreeViewMode } from "./three/threeView";
import {
  AppSettings,
  Building,
  DenseCover,
  GeoBounds,
  GeoProjector,
  MapPoint,
  Road,
  RoadHourlyDirectionalScore,
  RoadTraffic,
  Shape,
  Sign,
  SignHeightSource,
  SignKind,
  FacePriorityArc,
  StructureParams,
  TrafficSignal,
  TrafficByHour,
  TrafficByPreset,
  TrafficByRoadId,
  TrafficConfig,
  TrafficFlowDensity,
  TrafficDirectionalScores,
  TrafficViewState,
  Tree,
  TreeHeightSource,
  TreeType
} from "./types";
import {
  DEFAULT_SIGN_DIMENSIONS,
  DEFAULT_SIGN_HEIGHT_SOURCE,
  DEFAULT_SIGN_KIND,
  DEFAULT_SIGN_YAW_DEGREES,
  DEFAULT_TREE_HEIGHT_SOURCE,
  DEFAULT_TREE_RADIUS_METERS,
  DEFAULT_TREE_TYPE,
  deriveTreeHeightMeters
} from "./obstacles";
import { createFrameOverlay } from "./frameOverlay";
import {
  boundsCenter,
  boundsSizeMeters,
  clampBoundsToMaxSquare,
  expandBoundsByMeters,
  insetBounds
} from "./frameGeometry";
import { createGeoProjector, createGeoReference, GeoMapper, type ElevationGrid } from "./geo";
import {
  buildCombinedHeightGrid,
  buildTrafficViewerSamples,
  computeVisibilityHeatmap,
  sampleCandidatePoints,
  sampleViewerPoints
} from "./visibility";
import { generateContourSegments } from "./contours";
import { getTileSource, TileSourceId, TILE_SOURCES, renderMapFrameImage } from "./mapTiles";
import { createMapView } from "./mapView";
import { fetchElevationGrid } from "./topography";
import { fetchOsmRoadsAndBuildings } from "./osm/overpass";
import { buildLabelDataset, buildPredictionFeatures, parseLabelDataset, type LabelDataset } from "./ml/labels";
import { detectOnPatch, loadTreeSignsModel, type PatchPrediction } from "./ml/inference";
import { deserializeProject, RuntimeProjectState, serializeProject } from "./project";
import { createStructurePreview } from "./structurePreview";
import { createStructureEditor, type StructureEditorState, type StructureFrameInfo } from "./structureEditor";
import {
  buildPolygonFootprintTemplate,
  computeStructureFaces,
  labelFaceDirection,
  resolveFacePriorityIndices,
  optimizeStructurePlacement,
  type StructureOptimizationResult
} from "./structureOptimizer";
import { renderPatchImage } from "./trainer/export";
import {
  resolveStructureFootprintPoints,
  resolveStructureRotationDeg
} from "./structureFootprint";
import type {
  Building as OsmBuilding,
  Road as OsmRoad,
  RoadDirection as OsmRoadDirection,
  Sign as OsmSign,
  TrafficSignal as OsmTrafficSignal,
  Tree as OsmTree
} from "./osm/types";
import type {
  TrafficSimProgress,
  TrafficSimRequest,
  TrafficSimResult
} from "./traffic/types";
import {
  getState as getWorkflowState,
  setMode as setWorkflowMode,
  subscribe as subscribeWorkflow,
  type WorkflowState
} from "./workflowState";
import { buildWorldModelFromProject, type WorldModel } from "./world/worldModel";
import {
  applyBuildingHeightEstimates,
  getDefaultBuildingHeightProviders,
  resolveBuildingHeightInfo,
  resolveBuildingHeights
} from "./world/height";

type MapViewInstance = ReturnType<typeof createMapView>;
type BasemapMode = TileSourceId;
type RoadMode = "auto" | "custom";
type RoadDirection = "both" | "forward" | "backward";
type TrafficPreset = "am" | "pm" | "neutral";
type TrafficPresetKey = "am" | "pm" | "neutral";
type TopographyProgress = {
  completedPoints: number;
  totalPoints: number;
  coverage: number;
  phase: "coarse" | "full";
  rateLimitedCount: number;
  currentQps: number;
  grid: ElevationGrid;
};

interface AutoDataState {
  bounds: GeoBounds | null;
  roads: Road[];
  buildings: Building[];
  trees: Tree[];
  signs: Sign[];
  trafficSignals: TrafficSignal[];
  fetchedAt: string | null;
  endpoint: string | null;
  counts?: {
    roads: number;
    buildings: number;
    trees?: number;
    signs?: number;
    trafficSignals?: number;
  } | null;
}

interface MlDataState {
  trees: Tree[];
  signs: Sign[];
  importedAt: string | null;
  sourceLabel?: string | null;
}

type TrafficConfigInput = Partial<{
  preset: string;
  hour: number;
  detail: number;
  showOverlay: boolean;
  showDirectionArrows: boolean;
  flowDensity: string;
  seed: number;
  centralShare: number;
}>;

interface EpicenterState {
  lat: number;
  lon: number;
  radiusM: number;
}

interface ProjectExtras {
  roadMode?: RoadMode;
  autoData?: {
    bounds?: GeoBounds | null;
    fetchedAt?: string | null;
    endpoint?: string | null;
    counts?: {
      roads: number;
      buildings: number;
      trees?: number;
      signs?: number;
      trafficSignals?: number;
    } | null;
  };
  fetchOsmObstacles?: boolean;
  epicenter?: EpicenterState | null;
  roadDirections?: Record<string, RoadDirection>;
  trafficMeta?: TrafficSimResult["meta"] | null;
  trafficEpicenters?: TrafficSimResult["epicenters"] | null;
  mlData?: {
    trees?: Tree[];
    signs?: Sign[];
    importedAt?: string | null;
    sourceLabel?: string | null;
  };
}

type LoadedProject = { state: RuntimeProjectState; extras?: ProjectExtras };

const AUTOSAVE_KEY = "visopti-autosave-v1";
const DEFAULT_CUSTOM_TRAFFIC_CAPACITY = 1200;
const EXTRA_KEY = "__visopti";
const FEET_TO_METERS = 0.3048;
const METERS_TO_FEET = 1 / FEET_TO_METERS;
const METERS_PER_MILE = 1609.344;
const SIM_BUFFER_MILES = 5;
const SIM_BUFFER_METERS = SIM_BUFFER_MILES * METERS_PER_MILE;
const TRAFFIC_MAX_GRAPH_EDGES = 120000;
const TOPO_MIN_COVERAGE_ENABLE = 0.15;
const TOPO_APPROX_COVERAGE = 0.85;
const TOPO_PROGRESS_THROTTLE_MS = 100;
const TRAFFIC_HOUR_MIN = 6;
const TRAFFIC_HOUR_MAX = 20;
const RUSH_WINDOW_HALF_SPAN = 1;
const ML_PATCH_OVERLAP = 0.35;
const ML_PATCH_THROTTLE_MS = 60;
const ML_NMS_IOU = 0.45;

function isDebugModeEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get("debug") === "1") {
    return true;
  }
  try {
    return window.localStorage.getItem("visoptiDebug") === "1";
  } catch {
    return false;
  }
}

async function init() {
  const canvas = document.getElementById("mainCanvas") as HTMLCanvasElement | null;
  const workspace = document.getElementById("workspace") as HTMLDivElement | null;
  const controls = document.getElementById("controls") as HTMLDivElement | null;
  const statusOverlay = document.getElementById("statusOverlay");
  const statusMessage = document.getElementById("statusMessage");
  const addressForm = document.getElementById("addressForm") as HTMLFormElement | null;
  const addressInput = document.getElementById("addressInput") as HTMLInputElement | null;
  const addressGo = document.getElementById("addressGo") as HTMLButtonElement | null;
  const btnUseMapCenter = document.getElementById("btnUseMapCenter") as HTMLButtonElement | null;
  const btnSetFrame = document.getElementById("btnSetFrame") as HTMLButtonElement | null;
  const btnResetFrame = document.getElementById("btnResetFrame") as HTMLButtonElement | null;
  const btnUnlockFrame = document.getElementById("btnUnlockFrame") as HTMLButtonElement | null;
  const frameWidthValue = document.getElementById("frameWidthValue");
  const frameHeightValue = document.getElementById("frameHeightValue");
  const frameAreaValue = document.getElementById("frameAreaValue");
  const frameStatus = document.getElementById("frameStatus");
  const warningBanner = document.getElementById("warningBanner");
  const mapContainer = document.getElementById("mapView") as HTMLDivElement | null;
  const threeViewContainer = document.getElementById("threeView") as HTMLDivElement | null;
  const mapStatus = document.getElementById("mapStatus");
  const btnLockFrame = document.getElementById("btnLockFrame") as HTMLButtonElement | null;
  const btnLoadTopography = document.getElementById("btnLoadTopography") as HTMLButtonElement | null;
  const basemapStyle = document.getElementById("basemapStyle") as HTMLSelectElement | null;
  const toggleImageryBackground = document.getElementById(
    "toggleImageryBackground"
  ) as HTMLInputElement | null;
  const toggle3dView = document.getElementById("toggle3dView") as HTMLInputElement | null;
  const btnReturn2d = document.getElementById("btnReturn2d") as HTMLButtonElement | null;
  const basemapWarning = document.getElementById("basemapWarning");
  const threeViewFallback = document.getElementById("threeViewFallback");
  const btnReturnFrame = document.getElementById("btnReturnFrame") as HTMLButtonElement | null;
  const modeAuto = document.getElementById("modeAuto") as HTMLInputElement | null;
  const modeCustom = document.getElementById("modeCustom") as HTMLInputElement | null;
  const btnAutoPopulate = document.getElementById("btnAutoPopulate") as HTMLButtonElement | null;
  const btnRefreshAuto = document.getElementById("btnRefreshAuto") as HTMLButtonElement | null;
  const autoDataStatus = document.getElementById("autoDataStatus");
  const simulationExtentStatus = document.getElementById("simulationExtentStatus");
  const btnPickEpicenter = document.getElementById("btnPickEpicenter") as HTMLButtonElement | null;
  const epicenterRadius = document.getElementById("epicenterRadius") as HTMLInputElement | null;
  const epicenterRadiusValue = document.getElementById("epicenterRadiusValue");
  const epicenterStatus = document.getElementById("epicenterStatus");
  const trafficPreset = document.getElementById("trafficPreset") as HTMLSelectElement | null;
  const trafficHourRow = document.getElementById("trafficHourRow");
  const trafficHour = document.getElementById("trafficHour") as HTMLInputElement | null;
  const trafficHourValue = document.getElementById("trafficHourValue");
  const trafficWindowHint = document.getElementById("trafficWindowHint");
  const trafficDetail = document.getElementById("trafficDetail") as HTMLInputElement | null;
  const trafficDetailValue = document.getElementById("trafficDetailValue");
  const btnComputeTraffic = document.getElementById("btnComputeTraffic") as HTMLButtonElement | null;
  const btnRecomputeTraffic = document.getElementById("btnRecomputeTraffic") as HTMLButtonElement | null;
  const toggleTrafficOverlay = document.getElementById("toggleTrafficOverlay") as HTMLInputElement | null;
  const toggleDirectionArrows = document.getElementById("toggleDirectionArrows") as HTMLInputElement | null;
  const trafficFlowDensity = document.getElementById("trafficFlowDensity") as HTMLSelectElement | null;
  const trafficCentralShare = document.getElementById("trafficCentralShare") as HTMLInputElement | null;
  const trafficProgress = document.getElementById("trafficProgress");
  const trafficProgressLabel = document.getElementById("trafficProgressLabel");
  const trafficProgressBar = document.getElementById("trafficProgressBar") as HTMLProgressElement | null;
  const btnCancelTraffic = document.getElementById("btnCancelTraffic") as HTMLButtonElement | null;
  const trafficStatus = document.getElementById("trafficStatus");
  const btnAddRoad = document.getElementById("btnAddRoad") as HTMLButtonElement | null;
  const btnEditRoad = document.getElementById("btnEditRoad") as HTMLButtonElement | null;
  const btnDeleteRoad = document.getElementById("btnDeleteRoad") as HTMLButtonElement | null;
  const roadProperties = document.getElementById("roadProperties");
  const roadName = document.getElementById("roadName") as HTMLInputElement | null;
  const roadDirection = document.getElementById("roadDirection") as HTMLSelectElement | null;
  const roadShowCenterline = document.getElementById("roadShowCenterline") as HTMLInputElement | null;
  const roadCarsForward = document.getElementById("roadCarsForward") as HTMLInputElement | null;
  const roadCarsBackward = document.getElementById("roadCarsBackward") as HTMLInputElement | null;
  const structureHeight = document.getElementById("structureHeight") as HTMLInputElement | null;
  const structureWidth = document.getElementById("structureWidth") as HTMLInputElement | null;
  const structureLength = document.getElementById("structureLength") as HTMLInputElement | null;
  const structureCentered = document.getElementById("structureCentered") as HTMLInputElement | null;
  const structurePreviewWidget = document.getElementById(
    "structurePreviewWidget"
  ) as HTMLDivElement | null;
  const structurePreviewCanvas = document.getElementById(
    "structurePreviewCanvas"
  ) as HTMLCanvasElement | null;
  const structureEditorModal = document.getElementById(
    "structureEditorModal"
  ) as HTMLDivElement | null;
  const structureEditorCanvas = document.getElementById(
    "structureEditorCanvas"
  ) as HTMLCanvasElement | null;
  const structureEditorHeight = document.getElementById(
    "structureEditorHeight"
  ) as HTMLInputElement | null;
  const structureEditorHeightSlider = document.getElementById(
    "structureEditorHeightSlider"
  ) as HTMLInputElement | null;
  const structureEditorRotation = document.getElementById(
    "structureEditorRotation"
  ) as HTMLInputElement | null;
  const structureEditorPerimeterValue = document.getElementById(
    "structureEditorPerimeterValue"
  );
  const structureEditorAreaValue = document.getElementById("structureEditorAreaValue");
  const structureEditorFrontEdgeValue = document.getElementById(
    "structureEditorFrontEdgeValue"
  );
  const structureEditorTabButtons = structureEditorModal
    ? Array.from(
        structureEditorModal.querySelectorAll<HTMLButtonElement>("[data-structure-tab]")
      )
    : null;
  const structureEditorTabPanels = structureEditorModal
    ? Array.from(
        structureEditorModal.querySelectorAll<HTMLElement>("[data-structure-panel]")
      )
    : null;
  const structureEditorToolButtons = structureEditorModal
    ? Array.from(
        structureEditorModal.querySelectorAll<HTMLButtonElement>("[data-mode]")
      )
    : null;
  const structureEditorArcButtons = structureEditorModal
    ? Array.from(
        structureEditorModal.querySelectorAll<HTMLButtonElement>("[data-arc]")
      )
    : null;
  const structureEditorClose = document.getElementById(
    "structureEditorClose"
  ) as HTMLButtonElement | null;
  const structureEditorCancel = document.getElementById(
    "structureEditorCancel"
  ) as HTMLButtonElement | null;
  const structureEditorApply = document.getElementById(
    "structureEditorApply"
  ) as HTMLButtonElement | null;
  const structureEditorImportFile = document.getElementById(
    "structureEditorImportFile"
  ) as HTMLInputElement | null;
  const structureEditorImportName = document.getElementById("structureEditorImportName");
  const structureEditorImportFormat = document.getElementById("structureEditorImportFormat");
  const structureEditorImportScale = document.getElementById(
    "structureEditorImportScale"
  ) as HTMLInputElement | null;
  const structureEditorImportRotation = document.getElementById(
    "structureEditorImportRotation"
  ) as HTMLInputElement | null;
  const structureEditorImportOffsetX = document.getElementById(
    "structureEditorImportOffsetX"
  ) as HTMLInputElement | null;
  const structureEditorImportOffsetY = document.getElementById(
    "structureEditorImportOffsetY"
  ) as HTMLInputElement | null;
  const structureEditorImportOffsetZ = document.getElementById(
    "structureEditorImportOffsetZ"
  ) as HTMLInputElement | null;
  const structureEditorGenerateProxy = document.getElementById(
    "structureEditorGenerateProxy"
  ) as HTMLButtonElement | null;
  const structureEditorProxyStatus = document.getElementById("structureEditorProxyStatus");
  const structureSquareToRoad = document.getElementById(
    "structureSquareToRoad"
  ) as HTMLInputElement | null;
  const structureFacePriority = document.getElementById(
    "structureFacePriority"
  ) as HTMLSelectElement | null;
  const structureBestScore = document.getElementById("structureBestScore");
  const structureBestRotation = document.getElementById("structureBestRotation");
  const structureFaceScores = document.getElementById("structureFaceScores");
  const btnAddCandidate = document.getElementById("btnAddCandidate") as HTMLButtonElement | null;
  const candidateItems = document.getElementById("candidateItems");
  const candidateCount = document.getElementById("candidateCount");
  const btnRunOptimization = document.getElementById(
    "btnRunOptimization"
  ) as HTMLButtonElement | null;
  const optimizationProgress = document.getElementById("optimizationProgress");
  const optimizationProgressLabel = document.getElementById("optimizationProgressLabel");
  const optimizationProgressBar = document.getElementById(
    "optimizationProgressBar"
  ) as HTMLProgressElement | null;
  const btnCancelOptimization = document.getElementById(
    "btnCancelOptimization"
  ) as HTMLButtonElement | null;
  const layerRoads = document.getElementById("layerRoads") as HTMLInputElement | null;
  const layerBuildings = document.getElementById("layerBuildings") as HTMLInputElement | null;
  const layerTrees = document.getElementById("layerTrees") as HTMLInputElement | null;
  const layerSigns = document.getElementById("layerSigns") as HTMLInputElement | null;
  const layerCandidates = document.getElementById("layerCandidates") as HTMLInputElement | null;
  const layerTraffic = document.getElementById("layerTraffic") as HTMLInputElement | null;
  const btnAddTreeDeciduous = document.getElementById(
    "btnAddTreeDeciduous"
  ) as HTMLButtonElement | null;
  const btnAddTreePine = document.getElementById(
    "btnAddTreePine"
  ) as HTMLButtonElement | null;
  const btnAddSign = document.getElementById("btnAddSign") as HTMLButtonElement | null;
  const toggleInspectMode = document.getElementById("toggleInspectMode") as HTMLInputElement | null;
  const inspectEmpty = document.getElementById("inspectEmpty");
  const inspectGenericDetails = document.getElementById("inspectGenericDetails");
  const inspectFeatureLabel = document.getElementById("inspectFeatureLabel");
  const inspectBuildingDetails = document.getElementById("inspectBuildingDetails");
  const inspectBuildingId = document.getElementById("inspectBuildingId");
  const inspectEffectiveHeight = document.getElementById("inspectEffectiveHeight");
  const inspectInferredHeight = document.getElementById("inspectInferredHeight");
  const inspectHeightSource = document.getElementById("inspectHeightSource");
  const inspectHeightConfidence = document.getElementById("inspectHeightConfidence");
  const inspectHeightFeet = document.getElementById("inspectHeightFeet") as HTMLInputElement | null;
  const inspectResetHeight = document.getElementById(
    "inspectResetHeight"
  ) as HTMLButtonElement | null;
  const inspectTreeDetails = document.getElementById("inspectTreeDetails");
  const inspectTreeId = document.getElementById("inspectTreeId");
  const inspectTreeType = document.getElementById("inspectTreeType") as HTMLSelectElement | null;
  const inspectTreeRadius = document.getElementById("inspectTreeRadius") as HTMLInputElement | null;
  const inspectTreeDerivedHeight = document.getElementById("inspectTreeDerivedHeight");
  const inspectTreeHeightMeters = document.getElementById(
    "inspectTreeHeightMeters"
  ) as HTMLInputElement | null;
  const inspectTreeHeightFeet = document.getElementById(
    "inspectTreeHeightFeet"
  ) as HTMLInputElement | null;
  const inspectTreeResetHeight = document.getElementById(
    "inspectTreeResetHeight"
  ) as HTMLButtonElement | null;
  const inspectSignDetails = document.getElementById("inspectSignDetails");
  const inspectSignId = document.getElementById("inspectSignId");
  const inspectSignKind = document.getElementById("inspectSignKind") as HTMLSelectElement | null;
  const inspectSignWidth = document.getElementById("inspectSignWidth") as HTMLInputElement | null;
  const inspectSignHeight = document.getElementById("inspectSignHeight") as HTMLInputElement | null;
  const inspectSignClearance = document.getElementById(
    "inspectSignClearance"
  ) as HTMLInputElement | null;
  const inspectSignYaw = document.getElementById("inspectSignYaw") as HTMLInputElement | null;
  const inspectSignResetHeight = document.getElementById(
    "inspectSignResetHeight"
  ) as HTMLButtonElement | null;
  const toggleFetchOsmObstacles = document.getElementById(
    "toggleFetchOsmObstacles"
  ) as HTMLInputElement | null;
  const debugPanel = document.getElementById("debugPanel") as HTMLDetailsElement | null;
  const debugStats = document.getElementById("debugStats");
  const toggleLabelingMode = document.getElementById(
    "toggleLabelingMode"
  ) as HTMLInputElement | null;
  const btnExportLabels = document.getElementById("btnExportLabels") as HTMLButtonElement | null;
  const importPredictionsFile = document.getElementById(
    "importPredictionsFile"
  ) as HTMLInputElement | null;
  const importMlTreesFile = document.getElementById(
    "importMlTreesFile"
  ) as HTMLInputElement | null;
  const btnClearPredictions = document.getElementById(
    "btnClearPredictions"
  ) as HTMLButtonElement | null;
  const btnDetectMlFrame = document.getElementById(
    "btnDetectMlFrame"
  ) as HTMLButtonElement | null;
  const labelStatus = document.getElementById("labelStatus");
  const customRoadControls = document.getElementById("customRoadControls");
  const customRoadHint = document.getElementById("customRoadHint");
  const debugEnabled = isDebugModeEnabled();
  if (debugPanel && !debugEnabled) {
    debugPanel.classList.add("hidden");
  }
  if (!canvas || !workspace || !controls || !statusOverlay || !statusMessage) {
    throw new Error("Missing core DOM elements");
  }
  if (!addressForm || !addressInput || !addressGo) {
    throw new Error("Address controls missing from DOM");
  }
  if (
    !btnUseMapCenter ||
    !btnSetFrame ||
    !btnResetFrame ||
    !btnUnlockFrame ||
    !frameWidthValue ||
    !frameHeightValue ||
    !frameAreaValue ||
    !frameStatus
  ) {
    throw new Error("Workflow controls missing from DOM");
  }
  if (
    !mapContainer ||
    !threeViewContainer ||
    !mapStatus ||
    !btnLockFrame ||
    !btnLoadTopography ||
    !basemapStyle ||
    !toggleImageryBackground ||
    !toggle3dView ||
    !btnReturn2d ||
    !threeViewFallback
  ) {
    throw new Error("Map controls missing from DOM");
  }
  if (
    !modeAuto ||
    !modeCustom ||
    !btnAutoPopulate ||
    !btnRefreshAuto ||
    !autoDataStatus ||
    !simulationExtentStatus ||
    !toggleFetchOsmObstacles ||
    !btnPickEpicenter ||
    !epicenterRadius ||
    !epicenterRadiusValue ||
    !epicenterStatus ||
    !trafficPreset ||
    !trafficHourRow ||
    !trafficHour ||
    !trafficHourValue ||
    !trafficWindowHint ||
    !trafficDetail ||
    !trafficDetailValue ||
    !btnComputeTraffic ||
    !btnRecomputeTraffic ||
    !toggleTrafficOverlay ||
    !toggleDirectionArrows ||
    !trafficFlowDensity ||
    !trafficCentralShare ||
    !trafficProgress ||
    !trafficProgressLabel ||
    !trafficProgressBar ||
    !btnCancelTraffic ||
    !trafficStatus ||
    !btnAddRoad ||
    !btnEditRoad ||
    !btnDeleteRoad ||
    !roadProperties ||
    !roadName ||
    !roadDirection ||
    !roadShowCenterline ||
    !roadCarsForward ||
    !roadCarsBackward
  ) {
    throw new Error("Road and traffic controls missing from DOM");
  }
  if (
    !structureHeight ||
    !structureWidth ||
    !structureLength ||
    !structureCentered ||
    !structurePreviewWidget ||
    !structurePreviewCanvas ||
    !structureEditorModal ||
    !structureEditorCanvas ||
    !structureEditorHeight ||
    !structureEditorHeightSlider ||
    !structureEditorRotation ||
    !structureEditorPerimeterValue ||
    !structureEditorAreaValue ||
    !structureEditorFrontEdgeValue ||
    !structureEditorTabButtons ||
    !structureEditorTabPanels ||
    !structureEditorToolButtons ||
    !structureEditorArcButtons ||
    !structureEditorClose ||
    !structureEditorCancel ||
    !structureEditorApply ||
    !structureEditorImportFile ||
    !structureEditorImportName ||
    !structureEditorImportFormat ||
    !structureEditorImportScale ||
    !structureEditorImportRotation ||
    !structureEditorImportOffsetX ||
    !structureEditorImportOffsetY ||
    !structureEditorImportOffsetZ ||
    !structureEditorGenerateProxy ||
    !structureEditorProxyStatus ||
    !structureSquareToRoad ||
    !structureFacePriority ||
    !structureBestScore ||
    !structureBestRotation ||
    !structureFaceScores
  ) {
    throw new Error("Structure controls missing from DOM");
  }
  if (
    !btnRunOptimization ||
    !optimizationProgress ||
    !optimizationProgressLabel ||
    !optimizationProgressBar ||
    !btnCancelOptimization
  ) {
    throw new Error("Optimization controls missing from DOM");
  }
  if (
    !layerRoads ||
    !layerBuildings ||
    !layerTrees ||
    !layerSigns ||
    !layerCandidates ||
    !layerTraffic ||
    !btnAddTreeDeciduous ||
    !btnAddTreePine ||
    !btnAddSign ||
    !toggleInspectMode ||
    !inspectEmpty ||
    !inspectGenericDetails ||
    !inspectFeatureLabel ||
    !inspectBuildingDetails ||
    !inspectBuildingId ||
    !inspectEffectiveHeight ||
    !inspectInferredHeight ||
    !inspectHeightSource ||
    !inspectHeightConfidence ||
    !inspectHeightFeet ||
    !inspectResetHeight ||
    !inspectTreeDetails ||
    !inspectTreeId ||
    !inspectTreeType ||
    !inspectTreeRadius ||
    !inspectTreeDerivedHeight ||
    !inspectTreeHeightMeters ||
    !inspectTreeHeightFeet ||
    !inspectTreeResetHeight ||
    !inspectSignDetails ||
    !inspectSignId ||
    !inspectSignKind ||
    !inspectSignWidth ||
    !inspectSignHeight ||
    !inspectSignClearance ||
    !inspectSignYaw ||
    !inspectSignResetHeight
  ) {
    throw new Error("Inspect controls missing from DOM");
  }
  if (
    !toggleLabelingMode ||
    !btnExportLabels ||
    !importPredictionsFile ||
    !btnClearPredictions ||
    !labelStatus
  ) {
    throw new Error("Labeling controls missing from DOM");
  }

  const statusOverlayEl = statusOverlay;
  const statusMessageEl = statusMessage;
  const workspaceEl = workspace;
  const controlsEl = controls;
  const addressFormEl = addressForm;
  const addressInputEl = addressInput;
  const addressGoEl = addressGo;
  const btnUseMapCenterEl = btnUseMapCenter;
  const btnSetFrameEl = btnSetFrame;
  const btnResetFrameEl = btnResetFrame;
  const btnUnlockFrameEl = btnUnlockFrame;
  const frameWidthValueEl = frameWidthValue;
  const frameHeightValueEl = frameHeightValue;
  const frameAreaValueEl = frameAreaValue;
  const frameStatusEl = frameStatus;
  const warningBannerEl = warningBanner;
  const threeViewContainerEl = threeViewContainer;
  const threeViewFallbackEl = threeViewFallback;
  const mapStatusEl = mapStatus;
  const basemapStyleEl = basemapStyle;
  const toggleImageryBackgroundEl = toggleImageryBackground;
  const toggle3dViewEl = toggle3dView;
  const btnReturn2dEl = btnReturn2d;
  const basemapWarningEl = basemapWarning;
  const btnReturnFrameEl = btnReturnFrame;
  const modeAutoEl = modeAuto;
  const modeCustomEl = modeCustom;
  const btnAutoPopulateEl = btnAutoPopulate;
  const btnRefreshAutoEl = btnRefreshAuto;
  const autoDataStatusEl = autoDataStatus;
  const simulationExtentStatusEl = simulationExtentStatus;
  const btnPickEpicenterEl = btnPickEpicenter;
  const epicenterRadiusEl = epicenterRadius;
  const epicenterRadiusValueEl = epicenterRadiusValue;
  const epicenterStatusEl = epicenterStatus;
  const trafficPresetEl = trafficPreset;
  const trafficHourRowEl = trafficHourRow;
  const trafficHourEl = trafficHour;
  const trafficHourValueEl = trafficHourValue;
  const trafficWindowHintEl = trafficWindowHint;
  const trafficDetailEl = trafficDetail;
  const trafficDetailValueEl = trafficDetailValue;
  const btnComputeTrafficEl = btnComputeTraffic;
  const btnRecomputeTrafficEl = btnRecomputeTraffic;
  const toggleTrafficOverlayEl = toggleTrafficOverlay;
  const toggleDirectionArrowsEl = toggleDirectionArrows;
  const trafficFlowDensityEl = trafficFlowDensity;
  const trafficCentralShareEl = trafficCentralShare;
  const trafficProgressEl = trafficProgress;
  const trafficProgressLabelEl = trafficProgressLabel;
  const trafficProgressBarEl = trafficProgressBar;
  const btnCancelTrafficEl = btnCancelTraffic;
  const trafficStatusEl = trafficStatus;
  const btnAddRoadEl = btnAddRoad;
  const btnEditRoadEl = btnEditRoad;
  const btnDeleteRoadEl = btnDeleteRoad;
  const roadPropertiesEl = roadProperties;
  const roadNameEl = roadName;
  const roadDirectionEl = roadDirection;
  const roadShowCenterlineEl = roadShowCenterline;
  const roadCarsForwardEl = roadCarsForward;
  const roadCarsBackwardEl = roadCarsBackward;
  const structureHeightEl = structureHeight;
  const structureWidthEl = structureWidth;
  const structureLengthEl = structureLength;
  const structureCenteredEl = structureCentered;
  const structurePreviewWidgetEl = structurePreviewWidget;
  const structurePreviewCanvasEl = structurePreviewCanvas;
  const structureEditorModalEl = structureEditorModal;
  const structureEditorCanvasEl = structureEditorCanvas;
  const structureEditorHeightEl = structureEditorHeight;
  const structureEditorHeightSliderEl = structureEditorHeightSlider;
  const structureEditorRotationEl = structureEditorRotation;
  const structureEditorPerimeterValueEl = structureEditorPerimeterValue;
  const structureEditorAreaValueEl = structureEditorAreaValue;
  const structureEditorFrontEdgeValueEl = structureEditorFrontEdgeValue;
  const structureEditorToolButtonsEl = structureEditorToolButtons;
  const structureEditorArcButtonsEl = structureEditorArcButtons;
  const structureEditorCloseEl = structureEditorClose;
  const structureEditorCancelEl = structureEditorCancel;
  const structureEditorApplyEl = structureEditorApply;
  const structureSquareToRoadEl = structureSquareToRoad;
  const structureFacePriorityEl = structureFacePriority;
  const structureBestScoreEl = structureBestScore;
  const structureBestRotationEl = structureBestRotation;
  const structureFaceScoresEl = structureFaceScores;
  const candidateItemsEl = candidateItems;
  const candidateCountEl = candidateCount;
  const btnRunOptimizationEl = btnRunOptimization;
  const optimizationProgressEl = optimizationProgress;
  const optimizationProgressLabelEl = optimizationProgressLabel;
  const optimizationProgressBarEl = optimizationProgressBar;
  const btnCancelOptimizationEl = btnCancelOptimization;
  const layerRoadsEl = layerRoads;
  const layerBuildingsEl = layerBuildings;
  const layerTreesEl = layerTrees;
  const layerSignsEl = layerSigns;
  const layerCandidatesEl = layerCandidates;
  const layerTrafficEl = layerTraffic;
  const btnAddTreeDeciduousEl = btnAddTreeDeciduous;
  const btnAddTreePineEl = btnAddTreePine;
  const btnAddSignEl = btnAddSign;
  const toggleInspectModeEl = toggleInspectMode;
  const inspectEmptyEl = inspectEmpty;
  const inspectGenericDetailsEl = inspectGenericDetails;
  const inspectFeatureLabelEl = inspectFeatureLabel;
  const inspectBuildingDetailsEl = inspectBuildingDetails;
  const inspectBuildingIdEl = inspectBuildingId;
  const inspectEffectiveHeightEl = inspectEffectiveHeight;
  const inspectInferredHeightEl = inspectInferredHeight;
  const inspectHeightSourceEl = inspectHeightSource;
  const inspectHeightConfidenceEl = inspectHeightConfidence;
  const inspectHeightFeetEl = inspectHeightFeet;
  const inspectResetHeightEl = inspectResetHeight;
  const inspectTreeDetailsEl = inspectTreeDetails;
  const inspectTreeIdEl = inspectTreeId;
  const inspectTreeTypeEl = inspectTreeType;
  const inspectTreeRadiusEl = inspectTreeRadius;
  const inspectTreeDerivedHeightEl = inspectTreeDerivedHeight;
  const inspectTreeHeightMetersEl = inspectTreeHeightMeters;
  const inspectTreeHeightFeetEl = inspectTreeHeightFeet;
  const inspectTreeResetHeightEl = inspectTreeResetHeight;
  const inspectSignDetailsEl = inspectSignDetails;
  const inspectSignIdEl = inspectSignId;
  const inspectSignKindEl = inspectSignKind;
  const inspectSignWidthEl = inspectSignWidth;
  const inspectSignHeightEl = inspectSignHeight;
  const inspectSignClearanceEl = inspectSignClearance;
  const inspectSignYawEl = inspectSignYaw;
  const inspectSignResetHeightEl = inspectSignResetHeight;
  const toggleFetchOsmObstaclesEl = toggleFetchOsmObstacles;
  const debugStatsEl = debugStats;
  const toggleLabelingModeEl = toggleLabelingMode;
  const btnExportLabelsEl = btnExportLabels;
  const importPredictionsFileEl = importPredictionsFile;
  const importMlTreesFileEl = importMlTreesFile;
  const btnClearPredictionsEl = btnClearPredictions;
  const labelStatusEl = labelStatus;
  const customRoadControlsEl = customRoadControls;
  const customRoadHintEl = customRoadHint;
  const workflowSteps = Array.from(
    document.querySelectorAll<HTMLLIElement>(".workflow-step[data-step]")
  );
  const workflowStepMap = new Map<string, HTMLLIElement>();
  workflowSteps.forEach((step) => {
    const key = step.dataset.step;
    if (key) {
      workflowStepMap.set(key, step);
    }
  });
  const obstacleToolButtons: Array<{ button: HTMLButtonElement; tool: ToolMode }> = [
    { button: btnAddTreeDeciduousEl, tool: "placeTreeDeciduous" },
    { button: btnAddTreePineEl, tool: "placeTreePine" },
    { button: btnAddSignEl, tool: "placeSign" }
  ];
  const clearObstacleToolButtons = () => {
    obstacleToolButtons.forEach(({ button }) => button.classList.remove("active"));
  };

  statusOverlayEl.textContent = "Zoom the map to pick your frame.";
  const mapView = createMapView(mapContainer);
  const basemapSupport = new Set(TILE_SOURCES.map((source) => source.id));
  const autoStreetSupported = basemapSupport.has("autoStreet");
  let basemapMode: BasemapMode = mapView.getTileSourceId();
  basemapStyleEl.value = basemapMode;

  const setBasemapWarning = (message: string | null) => {
    if (!basemapWarningEl) return;
    if (message) {
      basemapWarningEl.textContent = message;
      basemapWarningEl.classList.remove("hidden");
    } else {
      basemapWarningEl.textContent = "";
      basemapWarningEl.classList.add("hidden");
    }
  };

  const applyBasemapMode = (mode: BasemapMode, options?: { warn?: boolean }) => {
    basemapMode = mode;
    basemapStyleEl.value = mode;
    const tileId = getTileSourceIdForBasemap(mode, autoStreetSupported);
    mapView.setTileSourceId(tileId);
    if (mode === "autoStreet" && !autoStreetSupported) {
      if (options?.warn !== false) {
        setBasemapWarning("Auto street filter not available. Using Street tiles.");
      }
    } else {
      setBasemapWarning(null);
    }
  };

  basemapStyleEl.addEventListener("change", () => {
    applyBasemapMode(basemapStyleEl.value as BasemapMode, { warn: true });
    scheduleAutosave();
  });
  toggleImageryBackgroundEl.addEventListener("change", () => {
    showImageryBackground = toggleImageryBackgroundEl.checked;
    updateFrameStatus();
  });

  const placeholderImage = createPlaceholderCanvas(1200, 800);
  let baseImageSize = { width: placeholderImage.width, height: placeholderImage.height };

  const settings = createDefaultSettings();
  const structure = createDefaultStructure();
  let structureBaseElevationM = 0;
  let structureOverlay: StructureOverlayData | null = null;
  let structureAnalysis: StructureOptimizationResult | null = null;
  let facePriority: FacePriorityArc | null = null;
  const frameOverlay = createFrameOverlay(mapView.getLeafletMap(), {
    minSideM: settings.frame.minSideFt * FEET_TO_METERS,
    maxSideM: settings.frame.maxSideFt * FEET_TO_METERS,
    editable: true,
    visible: false,
    onChange: () => {
      if (trafficInFlight) {
        cancelTrafficRun({ message: "Traffic simulation canceled." });
      }
      if (!frameLocked) {
        updateFrameReadout();
      }
    }
  });
  let roadMode: RoadMode = "auto";
  let autoData: AutoDataState = {
    bounds: null,
    roads: [],
    buildings: [],
    trees: [],
    signs: [],
    trafficSignals: [],
    fetchedAt: null,
    endpoint: null,
    counts: null
  };
  let mlData: MlDataState = {
    trees: [],
    signs: [],
    importedAt: null,
    sourceLabel: null
  };
  let mlDetecting = false;
  let customRoads: Road[] = [];
  let trees: Tree[] = [];
  let signs: Sign[] = [];
  let denseCover: DenseCover[] = [];
  let selectedRoadId: string | null = null;
  let selectedShapeId: string | null = null;
  let worldModel: WorldModel | null = null;
  let selectedFeature: FeatureSelection | null = null;
  let inspectMode = toggleInspectModeEl.checked;
  let fetchOsmObstacles = toggleFetchOsmObstaclesEl.checked;
  const layerVisibility: Record<WorldLayer, boolean> = {
    roads: layerRoadsEl.checked,
    buildings: layerBuildingsEl.checked,
    trees: layerTreesEl.checked,
    signs: layerSignsEl.checked,
    candidates: layerCandidatesEl.checked,
    traffic: layerTrafficEl.checked
  };
  let inspectSyncing = false;
  let epicenter: EpicenterState | null = null;
  let epicenterRadiusM = Number.parseFloat(epicenterRadiusEl.value) || 800;
  const epicenterRadiusMin = Number.parseFloat(epicenterRadiusEl.min) || 50;
  const epicenterRadiusMax = Number.parseFloat(epicenterRadiusEl.max) || 5000;
  let pendingEpicenterPick = false;
  const trafficConfig: TrafficConfig = createDefaultTrafficConfig();
  let trafficView: TrafficViewState = buildTrafficViewState(trafficConfig);
  let trafficBaseByRoadId: TrafficByRoadId | null = null;
  let trafficOverlayByRoadId: TrafficByRoadId = {};
  let trafficMeta: TrafficSimResult["meta"] | null = null;
  let trafficGraphCapMessage: string | null = null;
  let trafficEpicenters: TrafficSimResult["epicenters"] | null = null;
  let trafficEdgeTraffic: TrafficSimResult["edgeTraffic"] | null = null;
  let trafficViewerSamples: TrafficSimResult["viewerSamples"] | null = null;
  let trafficWorker: Worker | null = null;
  let trafficInFlight = false;
  let visibilityComputing = false;
  let trafficRunId = 0;
  let activeTrafficRunId = 0;
  let optimizationInFlight = false;
  let optimizationAbortController: AbortController | null = null;
  let optimizationPhase: "idle" | "preparing" | "traffic" | "heatmap" | "optimize" | "done" =
    "idle";
  let optimizationDoneTimer: number | null = null;
  let trafficSignature: string | null = null;
  let trafficRunListeners: Array<(outcome: { ok: boolean; message?: string }) => void> = [];
  let autoFetchController: AbortController | null = null;
  let geocodeController: AbortController | null = null;
  let lastPointer: { x: number; y: number } | null = null;
  let pendingInterrupt: () => void = () => {};
  let geoProjector: GeoProjector | null = null;
  let mapper: GeoMapper | null = null;
  let topographyGrid: ElevationGrid | null = null;
  let topographyCoverage = 0;
  let topographyComplete = false;
  let topographyLoading = false;
  let topographyRunId = 0;
  let topographyAbort: AbortController | null = null;
  let autoDataLoading = false;
  let autoDataError: string | null = null;
  let topographyError: string | null = null;
  let currentBounds: GeoBounds | null = null;
  let frameLocked = false;
  let showImageryBackground = false;
  let showMapWhileLocked = false;
  let threeViewEnabled = toggle3dViewEl.checked;
  let threeViewAvailable = false;
  showImageryBackground = toggleImageryBackgroundEl.checked;
  let autosave: LoadedProject | null = loadAutosave();
  let autosaveTimer: number | null = null;
  const drawingManager = createDrawingManager({
    canvas,
    image: placeholderImage,
    onShapesChanged: (shapes) => shapeChangeHandler(shapes),
    onPointerMove: (pixel) => updateStatusOverlay(pixel),
    onInteraction: () => {
      pendingInterrupt();
      syncCustomRoadsFromDrawing();
    },
    onShapeSelectionChanged: (shapeId) => {
      selectedShapeId = shapeId;
      renderCandidateList(drawingManager.getShapes());
    },
    onRoadSelectionChanged: (roadId: string | null) => setSelectedRoadId(roadId),
    onFeatureSelectionChanged: (selection) => {
      selectedFeature = selection;
      updateInspectPanel();
    },
    onFeaturePlaced: (request) => {
      handleFeaturePlaced(request);
    },
    onFeatureMoved: (request) => {
      handleFeatureMoved(request);
    },
    onDenseCoverCreated: (request) => {
      const next: DenseCover = {
        id: crypto.randomUUID?.() ?? `dense-${Date.now()}`,
        polygonLatLon: request.polygon.map((point) => ({ ...point })),
        density: request.density,
        mode: "dense_cover"
      };
      denseCover = [...denseCover, next];
      updateWorldModel();
      scheduleAutosave();
    },
    onDenseCoverDeleted: (id) => {
      denseCover = denseCover.filter((item) => item.id !== id);
      updateWorldModel();
      scheduleAutosave();
    }
  });
  drawingManager.setRoadDirectionOverlayEnabled(true);
  drawingManager.setThreeDViewEnabled(false);
  (Object.entries(layerVisibility) as Array<[WorldLayer, boolean]>).forEach(
    ([layer, visible]) => drawingManager.setWorldLayerVisibility(layer, visible)
  );
  drawingManager.setInspectMode(inspectMode);
  const threeView = createThreeView();
  if (threeViewContainerEl) {
    threeViewAvailable = threeView.init(threeViewContainerEl);
  }
  if (!threeViewAvailable) {
    threeViewEnabled = false;
    toggle3dViewEl.checked = false;
    toggle3dViewEl.disabled = true;
    if (threeViewFallbackEl) {
      threeViewFallbackEl.textContent =
        "3D view unavailable (WebGL init failed). Falling back to 2D.";
      threeViewFallbackEl.classList.remove("hidden");
    }
  }
  const setBaseImage = (image: HTMLCanvasElement, options?: { resetView?: boolean }) => {
    drawingManager.setBaseImage(image, options);
    baseImageSize = { width: image.width, height: image.height };
    syncStructureCenterToFrame();
    updateStructureRender();
  };
  const ensureGeoProjector = (bounds: GeoBounds, size: { width: number; height: number }) => {
    if (
      geoProjector &&
      boundsApproxEqual(geoProjector.bounds, bounds) &&
      geoProjector.size.width === size.width &&
      geoProjector.size.height === size.height
    ) {
      return;
    }
    geoProjector = createGeoProjector(bounds, size);
    drawingManager.setGeoProjector(geoProjector);
    threeView.setTerrain(topographyGrid, geoProjector);
    updateDebugHud();
    updateWorldModel();
  };
  const ensureBaseImageSize = (width: number, height: number) => {
    if (baseImageSize.width === width && baseImageSize.height === height) {
      return;
    }
    const blank = createBlankCanvas(width, height);
    setBaseImage(blank, { resetView: true });
  };
  const clearGeoProjector = () => {
    if (!geoProjector) {
      return;
    }
    geoProjector = null;
    topographyGrid = null;
    threeView.setTerrain(null, null);
    drawingManager.setGeoProjector(null);
    updateDebugHud();
    updateWorldModel();
  };
  const structurePreview = createStructurePreview(structurePreviewCanvasEl);
  const updateStructurePreview = () => {
    const footprint = resolveStructureFootprintPoints(structure);
    structurePreview.setStructure({
      footprint: footprint.map((point) => ({ ...point })),
      heightM: Math.max(1, structure.heightMeters),
      baseM: structureBaseElevationM
    });
  };
  const structureEditor = createStructureEditor({
    modal: structureEditorModalEl,
    canvas: structureEditorCanvasEl,
    rotationInput: structureEditorRotationEl,
    heightInput: structureEditorHeightEl,
    heightSlider: structureEditorHeightSliderEl,
    perimeterValue: structureEditorPerimeterValueEl,
    areaValue: structureEditorAreaValueEl,
    frontEdgeValue: structureEditorFrontEdgeValueEl,
    tabButtons: structureEditorTabButtons,
    tabPanels: structureEditorTabPanels,
    toolButtons: structureEditorToolButtonsEl,
    arcButtons: structureEditorArcButtonsEl,
    importFileInput: structureEditorImportFile,
    importNameValue: structureEditorImportName,
    importFormatValue: structureEditorImportFormat,
    importScaleInput: structureEditorImportScale,
    importRotationInput: structureEditorImportRotation,
    importOffsetXInput: structureEditorImportOffsetX,
    importOffsetYInput: structureEditorImportOffsetY,
    importOffsetZInput: structureEditorImportOffsetZ,
    importGenerateProxyButton: structureEditorGenerateProxy,
    importProxyStatus: structureEditorProxyStatus,
    closeButton: structureEditorCloseEl,
    cancelButton: structureEditorCancelEl,
    applyButton: structureEditorApplyEl,
    onApply: (next) => {
      structure.mode = next.mode;
      structure.footprint.points = next.footprintPoints.map((point) => ({ ...point }));
      structure.heightMeters = next.heightMeters;
      structure.centerPx = { ...next.centerPx };
      structure.rotationDeg = next.rotationDeg;
      structure.placeAtCenter = next.placeAtCenter;
      structure.facePriority = next.facePriority;
      structure.imported = next.imported
        ? {
            ...next.imported,
            offset: { ...next.imported.offset },
            footprintProxy: next.imported.footprintProxy
              ? {
                  points: next.imported.footprintProxy.points.map((point) => ({ ...point }))
                }
              : undefined
          }
        : undefined;
      facePriority = structure.facePriority ?? null;
      structure.legacyWidthFt = undefined;
      structure.legacyLengthFt = undefined;
      refreshStructureInputs(structure);
      updateStructurePreview();
      updateStructureRender();
      scheduleAutosave();
    }
  });
  const openStructureEditor = () => {
    const frameInfo = getStructureFrameInfo();
    syncStructureCenterToFrame(frameInfo);
    const editorState: StructureEditorState = {
      mode: structure.mode,
      centerPx: { ...structure.centerPx },
      footprintPoints: structure.footprint.points.map((point) => ({ ...point })),
      heightMeters: structure.heightMeters,
      rotationDeg: structure.rotationDeg,
      placeAtCenter: structure.placeAtCenter,
      facePriority: structure.facePriority ? { ...structure.facePriority } : undefined,
      imported: structure.imported
        ? {
            ...structure.imported,
            offset: { ...structure.imported.offset },
            footprintProxy: structure.imported.footprintProxy
              ? {
                  points: structure.imported.footprintProxy.points.map((point) => ({ ...point }))
                }
              : undefined
          }
        : undefined
    };
    structureEditor.open(editorState, frameInfo);
  };
  structurePreviewWidgetEl.addEventListener("click", openStructureEditor);
  structurePreviewWidgetEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openStructureEditor();
    }
  });
  const computeAverageElevationM = (grid: ElevationGrid): number => {
    let total = 0;
    let count = 0;
    for (const row of grid.values) {
      for (const value of row) {
        if (!Number.isFinite(value)) {
          continue;
        }
        total += value;
        count += 1;
      }
    }
    return count > 0 ? total / count : 0;
  };
  const updateStructureBaseElevation = (grid: ElevationGrid | null) => {
    const next = grid ? computeAverageElevationM(grid) : 0;
    if (!Number.isFinite(next)) {
      return;
    }
    if (Math.abs(next - structureBaseElevationM) < 0.01) {
      return;
    }
    structureBaseElevationM = next;
    updateStructurePreview();
  };
  const buildStructureRenderData = (
    frameInfo: StructureFrameInfo
  ): StructureRenderData | null => {
    const footprint = resolveStructureFootprintPoints(structure);
    if (footprint.length < 3) {
      return null;
    }
    const heightM = Math.max(1, structure.heightMeters);
    const pixelsPerMeterX = frameInfo.widthPx / frameInfo.widthM;
    const pixelsPerMeterY = frameInfo.heightPx / frameInfo.heightM;
    if (!Number.isFinite(pixelsPerMeterX) || !Number.isFinite(pixelsPerMeterY)) {
      return null;
    }
    const angle = (resolveStructureRotationDeg(structure) * Math.PI) / 180;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const center = structure.centerPx;
    const points = footprint.map((point) => {
      const scaledX = point.x * pixelsPerMeterX;
      const scaledY = point.y * pixelsPerMeterY;
      return {
        x: center.x + scaledX * cosA - scaledY * sinA,
        y: center.y + scaledX * sinA + scaledY * cosA
      };
    });
    return { points, heightM };
  };
  const updateStructureRender = (frameOverride?: StructureFrameInfo | null) => {
    const frameInfo = frameOverride ?? getStructureFrameInfo();
    if (!frameInfo) {
      drawingManager.setStructure(null);
      updateStructureFaceOptions(null);
      updateWorldModel();
      return;
    }
    syncStructureCenterToFrame(frameInfo);
    const render = buildStructureRenderData(frameInfo);
    drawingManager.setStructure(render);
    updateStructureFaceOptions(render?.points ?? null);
    updateWorldModel();
  };

  const faceLabelOrder = ["N", "E", "S", "W"];
  const formatFaceLabel = (normal: { x: number; y: number }) =>
    `${labelFaceDirection(normal)} face`;

  function updateStructureFaceOptions(points: { x: number; y: number }[] | null) {
    structureFacePriorityEl.innerHTML = "";
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "None";
    structureFacePriorityEl.appendChild(noneOption);

    if (!points || points.length < 3) {
      structureFacePriorityEl.disabled = true;
      facePriority = null;
      structure.facePriority = undefined;
      structureFacePriorityEl.value = "";
      return;
    }

    const faces = computeStructureFaces(points);
    faces.sort(
      (a, b) =>
        faceLabelOrder.indexOf(labelFaceDirection(a.normal)) -
        faceLabelOrder.indexOf(labelFaceDirection(b.normal))
    );

    for (const face of faces) {
      const option = document.createElement("option");
      option.value = face.id.toString();
      option.textContent = formatFaceLabel(face.normal);
      structureFacePriorityEl.appendChild(option);
    }
    structureFacePriorityEl.disabled = false;
    const primaryEdgeIndex = facePriority?.primaryEdgeIndex;
    if (primaryEdgeIndex !== undefined && faces.some((face) => face.id === primaryEdgeIndex)) {
      structureFacePriorityEl.value = primaryEdgeIndex.toString();
    } else {
      facePriority = null;
      structure.facePriority = undefined;
      structureFacePriorityEl.value = "";
    }
  }

  const formatScore = (value: number | null | undefined) =>
    Number.isFinite(value ?? NaN) ? (value as number).toFixed(3) : "--";
  const formatRotation = (value: number | null | undefined) =>
    Number.isFinite(value ?? NaN) ? `${Math.round(value as number)}°` : "--";

  function updateStructureAnalysisUI(result: StructureOptimizationResult | null) {
    if (!result) {
      structureBestScoreEl.textContent = "--";
      structureBestRotationEl.textContent = "--";
      structureFaceScoresEl.textContent = "";
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Run optimization to see face ranking.";
      structureFaceScoresEl.appendChild(hint);
      return;
    }
    structureBestScoreEl.textContent = formatScore(result.placement.totalScore);
    structureBestRotationEl.textContent = formatRotation(result.placement.rotationDeg);
    structureFaceScoresEl.textContent = "";
    const sorted = [...result.placement.faceScores].sort((a, b) => b.score - a.score);
    const prioritizedIds = new Set(
      resolveFacePriorityIndices(result.placement.faceScores.length, facePriority)
    );
    for (const entry of sorted) {
      const row = document.createElement("div");
      row.className = "structure-face-row";
      if (prioritizedIds.has(entry.face.id)) {
        row.classList.add("is-pinned");
      }
      const label = document.createElement("span");
      label.textContent = formatFaceLabel(entry.face.normal);
      const score = document.createElement("span");
      score.textContent = formatScore(entry.score);
      row.appendChild(label);
      row.appendChild(score);
      structureFaceScoresEl.appendChild(row);
    }
  }

  const clearStructureAnalysis = () => {
    structureAnalysis = null;
    structureOverlay = null;
    drawingManager.setStructureOverlay(null);
    updateStructureAnalysisUI(null);
  };

  const optimizationProgressRanges = {
    preparing: { start: 0.05, end: 0.15 },
    traffic: { start: 0.15, end: 0.45 },
    heatmap: { start: 0.45, end: 0.75 },
    optimize: { start: 0.75, end: 0.95 },
    done: { start: 0.95, end: 1 }
  };

  const setOptimizationProgress = (label: string, value: number) => {
    optimizationProgressLabelEl.textContent = label;
    optimizationProgressBarEl.value = Math.min(1, Math.max(0, value));
    optimizationProgressEl.classList.remove("hidden");
  };

  const setOptimizationPhase = (
    phase: "preparing" | "traffic" | "heatmap" | "optimize" | "done",
    label: string,
    ratio = 0
  ) => {
    optimizationPhase = phase;
    const range = optimizationProgressRanges[phase];
    const clampedRatio = Math.min(1, Math.max(0, ratio));
    const value = range.start + (range.end - range.start) * clampedRatio;
    setOptimizationProgress(label, value);
  };

  const finishOptimizationProgress = (message: string) => {
    if (optimizationDoneTimer) {
      window.clearTimeout(optimizationDoneTimer);
    }
    setOptimizationPhase("done", message, 1);
    btnCancelOptimizationEl.disabled = true;
    optimizationDoneTimer = window.setTimeout(() => {
      optimizationProgressEl.classList.add("hidden");
      optimizationDoneTimer = null;
    }, 1500);
  };

  const clearOptimizationProgress = () => {
    if (optimizationDoneTimer) {
      window.clearTimeout(optimizationDoneTimer);
      optimizationDoneTimer = null;
    }
    optimizationProgressEl.classList.add("hidden");
    optimizationProgressBarEl.value = 0;
    optimizationProgressLabelEl.textContent = "";
    optimizationPhase = "idle";
  };
  function getStructureFrameInfo(): StructureFrameInfo | null {
    const bounds = frameLocked ? currentBounds : frameOverlay.getBounds();
    if (!bounds) {
      return null;
    }
    const { frame } = buildMapFrame(mapView, bounds, settings);
    const latMid = (bounds.north + bounds.south) / 2;
    const lonMid = (bounds.east + bounds.west) / 2;
    const widthM = haversineMeters(latMid, bounds.west, latMid, bounds.east);
    const heightM = haversineMeters(bounds.north, lonMid, bounds.south, lonMid);
    if (!Number.isFinite(widthM) || !Number.isFinite(heightM)) {
      return null;
    }
    return {
      widthPx: frame.width,
      heightPx: frame.height,
      widthM,
      heightM
    };
  }

  function syncStructureCenterToFrame(frameOverride?: StructureFrameInfo | null) {
    const frameInfo = frameOverride ?? getStructureFrameInfo();
    if (!frameInfo) {
      return;
    }
    const center = { x: frameInfo.widthPx / 2, y: frameInfo.heightPx / 2 };
    if (structure.placeAtCenter) {
      structure.centerPx = center;
      return;
    }
    if (!Number.isFinite(structure.centerPx.x) || !Number.isFinite(structure.centerPx.y)) {
      structure.centerPx = center;
      return;
    }
    structure.centerPx = {
      x: clamp(structure.centerPx.x, 0, frameInfo.widthPx),
      y: clamp(structure.centerPx.y, 0, frameInfo.heightPx)
    };
  }
  const normalizeStructureNumber = (value: number, fallback: number) => {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(1, value);
  };
  const normalizeFootprintPoints = (
    points: { x: number; y: number }[] | undefined,
    fallback: { x: number; y: number }[]
  ) => {
    if (!points || points.length < 3) {
      return fallback.map((point) => ({ ...point }));
    }
    const valid = points.every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
    );
    if (!valid) {
      return fallback.map((point) => ({ ...point }));
    }
    return points.map((point) => ({ ...point }));
  };
  const normalizeStructureRotation = (value: number, fallback: number) => {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    let next = value % 360;
    if (next < 0) {
      next += 360;
    }
    return next;
  };
  const applyStructureState = (next?: StructureParams) => {
    const defaults = createDefaultStructure();
    const source = next ?? defaults;
    clearStructureAnalysis();
    structure.version = 2;
    structure.mode = source.mode === "imported" ? "imported" : "parametric";
    structure.heightMeters = normalizeStructureNumber(
      source.heightMeters,
      defaults.heightMeters
    );
    structure.footprint.points = normalizeFootprintPoints(
      source.footprint.points,
      defaults.footprint.points
    );
    structure.legacyWidthFt = Number.isFinite(source.legacyWidthFt)
      ? normalizeStructureNumber(source.legacyWidthFt as number, defaults.legacyWidthFt ?? 60)
      : undefined;
    structure.legacyLengthFt = Number.isFinite(source.legacyLengthFt)
      ? normalizeStructureNumber(source.legacyLengthFt as number, defaults.legacyLengthFt ?? 90)
      : undefined;
    structure.placeAtCenter =
      typeof source.placeAtCenter === "boolean"
        ? source.placeAtCenter
        : defaults.placeAtCenter;
    structure.centerPx = {
      x: Number.isFinite(source.centerPx?.x) ? source.centerPx.x : defaults.centerPx.x,
      y: Number.isFinite(source.centerPx?.y) ? source.centerPx.y : defaults.centerPx.y
    };
    structure.rotationDeg = normalizeStructureRotation(
      source.rotationDeg,
      defaults.rotationDeg
    );
    structure.facePriority = source.facePriority;
    structure.imported = source.imported
      ? {
          ...source.imported,
          offset: { ...source.imported.offset },
          footprintProxy: source.imported.footprintProxy
            ? {
                points: source.imported.footprintProxy.points.map((point) => ({ ...point }))
              }
            : undefined
        }
      : undefined;
    facePriority = structure.facePriority ?? null;
    syncStructureCenterToFrame();
    refreshStructureInputs(structure);
    updateStructurePreview();
    updateStructureRender();
  };
  const syncThreeViewState = () => {
    const computing = trafficInFlight || visibilityComputing;
    if (computing && threeViewAvailable && !threeViewEnabled) {
      threeViewEnabled = true;
      toggle3dViewEl.checked = true;
    }
    const shouldShow = frameLocked && threeViewAvailable && (threeViewEnabled || computing);
    const mode: ThreeViewMode = computing ? "computing" : shouldShow ? "interactive" : "idle";
    threeView.setMode(mode);
    workspaceEl.classList.toggle("show-three", shouldShow);
    btnReturn2dEl.classList.toggle("hidden", !shouldShow);
    btnReturn2dEl.disabled = !shouldShow || computing;
  };
  const updatePreviewSpin = () => {
    const previewSpin = trafficInFlight || topographyLoading || visibilityComputing;
    structurePreview.setSpinning(previewSpin);
    syncThreeViewState();
  };
  const update3dView = () => {
    threeViewEnabled = toggle3dViewEl.checked;
    if (!threeViewAvailable && threeViewEnabled) {
      threeViewEnabled = false;
      toggle3dViewEl.checked = false;
    }
    syncThreeViewState();
  };
  toggle3dViewEl.addEventListener("change", update3dView);
  btnReturn2dEl.addEventListener("click", () => {
    if (trafficInFlight || visibilityComputing) {
      return;
    }
    toggle3dViewEl.checked = false;
    threeViewEnabled = false;
    syncThreeViewState();
  });
  const setVisibilityComputing = (active: boolean) => {
    if (visibilityComputing === active) {
      return;
    }
    visibilityComputing = active;
    updatePreviewSpin();
    updateOptimizationControls();
  };
  const setTopographyLoading = (loading: boolean) => {
    if (topographyLoading === loading) {
      return;
    }
    topographyLoading = loading;
    updatePreviewSpin();
    updateDebugHud();
  };
  updateStructurePreview();
  updatePreviewSpin();

  function getLastErrorMessage() {
    if (autoDataError && topographyError) {
      return `Auto data: ${autoDataError} | Topography: ${topographyError}`;
    }
    if (autoDataError) {
      return `Auto data: ${autoDataError}`;
    }
    if (topographyError) {
      return `Topography: ${topographyError}`;
    }
    return null;
  }

  function updateDebugHud() {
    const autoDataLoaded =
      Boolean(autoData.fetchedAt) || autoData.roads.length > 0 || autoData.buildings.length > 0;
    const autoRoadCount = autoDataLoaded ? autoData.counts?.roads ?? autoData.roads.length : null;
    const buildingCount = autoDataLoaded
      ? autoData.counts?.buildings ?? autoData.buildings.length
      : null;
    drawingManager.setDebugHudData({
      workflowMode: getWorkflowState().mode,
      lockedBounds: frameLocked ? currentBounds : null,
      autoDataLoaded,
      autoDataLoading,
      autoRoadCount,
      buildingCount,
      topographyLoading,
      lastError: getLastErrorMessage()
    });
    if (debugStatsEl) {
      const shapeCount = drawingManager.getShapes().length;
      const roadLabel = autoRoadCount === null ? "n/a" : autoRoadCount.toString();
      const buildingLabel = buildingCount === null ? "n/a" : buildingCount.toString();
      const terrainLabel = mapper ? (topographyLoading ? "loading" : "ready") : "n/a";
      debugStatsEl.textContent =
        `Mode: ${getWorkflowState().mode}` +
        ` | Shapes: ${shapeCount}` +
        ` | Roads: ${roadLabel}` +
        ` | Buildings: ${buildingLabel}` +
        ` | Terrain: ${terrainLabel}`;
    }
  }

  function updateStatusOverlay(pixel: { x: number; y: number } | null) {
    const toolName = friendlyToolName(drawingManager.getTool());
    let text = `Tool: ${toolName}`;
    if (!mapper) {
      text += "\nTerrain: (load map frame to enable)";
      text += "\nPixel: (–, –)";
      lastPointer = null;
    } else if (pixel) {
      const clampedX = clamp(pixel.x, 0, mapper.geo.image.width_px - 1);
      const clampedY = clamp(pixel.y, 0, mapper.geo.image.height_px - 1);
      const { lat, lon } = mapper.pixelToLatLon(clampedX, clampedY);
      const elevation = mapper.latLonToElevation(lat, lon);
      lastPointer = { x: clampedX, y: clampedY };
      text += `\nPixel: (${clampedX.toFixed(0)}, ${clampedY.toFixed(0)})`;
      text += `\nLat/Lon: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      text += Number.isFinite(elevation)
        ? `\nTerrain: ${elevation.toFixed(1)} m`
        : "\nTerrain: loading...";
    } else {
      lastPointer = null;
      text += "\nPixel: (–, –)";
    }
    statusOverlayEl.textContent = text;
  }

  const formatShapeKind = (kind: Shape["kind"]) => {
    switch (kind) {
      case "rect":
        return "Rect";
      case "ellipse":
        return "Ellipse";
      default:
        return "Polygon";
    }
  };

  const formatCandidateNumber = (value: number, decimals = 0) => {
    if (!Number.isFinite(value)) {
      return "--";
    }
    const factor = 10 ** decimals;
    const rounded = Math.round(value * factor) / factor;
    return rounded.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  };

  const getMetersPerPixel = () => {
    const projector = geoProjector ?? mapper;
    if (!projector) {
      return null;
    }
    const bounds = projector.bounds;
    const size = projector.size;
    if (!bounds || !size || size.width <= 0 || size.height <= 0) {
      return null;
    }
    const latMid = (bounds.north + bounds.south) / 2;
    const lonMid = (bounds.east + bounds.west) / 2;
    const widthM = haversineMeters(latMid, bounds.west, latMid, bounds.east);
    const heightM = haversineMeters(bounds.north, lonMid, bounds.south, lonMid);
    if (!Number.isFinite(widthM) || !Number.isFinite(heightM) || widthM <= 0 || heightM <= 0) {
      return null;
    }
    return { x: widthM / size.width, y: heightM / size.height };
  };

  const computeShapeMetrics = (
    shape: Shape,
    metersPerPixel: { x: number; y: number } | null
  ): { areaFt2: number; perimeterFt: number } | null => {
    if (!metersPerPixel) {
      return null;
    }
    const mppX = metersPerPixel.x;
    const mppY = metersPerPixel.y;
    if (!Number.isFinite(mppX) || !Number.isFinite(mppY) || mppX <= 0 || mppY <= 0) {
      return null;
    }
    let areaM2 = 0;
    let perimeterM = 0;

    if (shape.kind === "rect") {
      const widthM = Math.abs(shape.width) * mppX;
      const heightM = Math.abs(shape.height) * mppY;
      areaM2 = widthM * heightM;
      perimeterM = 2 * (widthM + heightM);
    } else if (shape.kind === "ellipse") {
      const a = (Math.abs(shape.width) * mppX) / 2;
      const b = (Math.abs(shape.height) * mppY) / 2;
      areaM2 = Math.PI * a * b;
      const h = Math.pow(a - b, 2) / Math.pow(a + b || 1, 2);
      perimeterM = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    } else {
      if (shape.points.length < 3) {
        return null;
      }
      const points = shape.points.map((point) => ({
        x: point.x * mppX,
        y: point.y * mppY
      }));
      let areaSum = 0;
      let lengthSum = 0;
      for (let i = 0; i < points.length; i += 1) {
        const current = points[i];
        const next = points[(i + 1) % points.length];
        areaSum += current.x * next.y - next.x * current.y;
        const dx = next.x - current.x;
        const dy = next.y - current.y;
        lengthSum += Math.hypot(dx, dy);
      }
      areaM2 = Math.abs(areaSum) / 2;
      perimeterM = lengthSum;
    }

    if (!Number.isFinite(areaM2) || !Number.isFinite(perimeterM)) {
      return null;
    }
    return {
      areaFt2: areaM2 / (FEET_TO_METERS * FEET_TO_METERS),
      perimeterFt: perimeterM / FEET_TO_METERS
    };
  };

  const updateCandidateShape = (id: string, updater: (shape: Shape) => Shape | null) => {
    const nextShapes = drawingManager.getShapes().map((shape) => {
      if (shape.id !== id) {
        return shape;
      }
      return updater(shape) ?? shape;
    });
    drawingManager.setShapes(nextShapes);
  };

  const renderCandidateList = (shapes: Shape[]) => {
    if (!candidateItemsEl || !candidateCountEl) {
      return;
    }
    const candidates = shapes.filter((shape) => shape.type === "candidate");
    candidateCountEl.textContent = candidates.length.toString();
    candidateItemsEl.textContent = "";
    if (candidates.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "No candidate regions yet.";
      candidateItemsEl.appendChild(empty);
      return;
    }
    const metersPerPixel = getMetersPerPixel();
    candidates.forEach((shape) => {
      const row = document.createElement("div");
      row.className = "candidate-item";
      row.classList.toggle("is-selected", shape.id === selectedShapeId);
      row.classList.toggle("is-hidden", shape.visible === false);

      const header = document.createElement("div");
      header.className = "candidate-header";

      const visibleLabel = document.createElement("label");
      visibleLabel.className = "candidate-visible";
      const visibleToggle = document.createElement("input");
      visibleToggle.type = "checkbox";
      visibleToggle.checked = shape.visible !== false;
      visibleToggle.title = "Toggle visibility";
      visibleToggle.addEventListener("click", (event) => event.stopPropagation());
      visibleToggle.addEventListener("change", () => {
        updateCandidateShape(shape.id, (candidate) => ({
          ...candidate,
          visible: visibleToggle.checked
        }));
      });
      visibleLabel.appendChild(visibleToggle);

      const nameInput = document.createElement("input");
      nameInput.className = "candidate-name";
      nameInput.type = "text";
      nameInput.value = shape.name ?? "";
      nameInput.addEventListener("click", (event) => event.stopPropagation());
      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          nameInput.blur();
        }
      });
      const commitName = () => {
        const nextName = nameInput.value.trim();
        if (!nextName || nextName === shape.name) {
          nameInput.value = shape.name;
          return;
        }
        updateCandidateShape(shape.id, (candidate) => ({
          ...candidate,
          name: nextName
        }));
      };
      nameInput.addEventListener("change", commitName);
      nameInput.addEventListener("blur", commitName);

      const kind = document.createElement("span");
      kind.className = "candidate-kind";
      kind.textContent = formatShapeKind(shape.kind);

      header.append(visibleLabel, nameInput, kind);

      const footer = document.createElement("div");
      footer.className = "candidate-footer";

      const metrics = document.createElement("span");
      metrics.className = "candidate-metrics";
      const shapeMetrics = computeShapeMetrics(shape, metersPerPixel);
      const areaLabel = shapeMetrics
        ? `${formatCandidateNumber(shapeMetrics.areaFt2)} sq ft`
        : "-- sq ft";
      const perimeterLabel = shapeMetrics
        ? `${formatCandidateNumber(shapeMetrics.perimeterFt)} ft`
        : "-- ft";
      metrics.textContent = `Area: ${areaLabel} | Perimeter: ${perimeterLabel}`;

      const actions = document.createElement("div");
      actions.className = "candidate-actions";

      const focusButton = document.createElement("button");
      focusButton.type = "button";
      focusButton.className = "link-button";
      focusButton.textContent = "Focus";
      focusButton.addEventListener("click", (event) => {
        event.stopPropagation();
        drawingManager.focusShape(shape.id);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "link-button danger";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const nextShapes = drawingManager
          .getShapes()
          .filter((candidate) => candidate.id !== shape.id);
        drawingManager.setShapes(nextShapes);
      });

      actions.append(focusButton, deleteButton);
      footer.append(metrics, actions);

      row.append(header, footer);
      row.addEventListener("click", () => {
        drawingManager.setSelectedShapeId(shape.id);
      });
      candidateItemsEl.appendChild(row);
    });
  };

  const heightSourceLabels: Record<string, string> = {
    osm_height: "OSM height",
    osm_levels: "OSM levels",
    default: "Default",
    external_api: "External API"
  };

  const formatHeightValue = (value: number, decimals = 1) => {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return value.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  };

  const formatHeightLabel = (meters: number) => {
    const feet = meters / FEET_TO_METERS;
    return `${formatHeightValue(meters)} m (${formatHeightValue(feet)} ft)`;
  };

  const formatConfidenceLabel = (confidence: number) => {
    if (!Number.isFinite(confidence)) {
      return "--";
    }
    return `${Math.round(confidence * 100)}%`;
  };

  const featureLabels: Record<FeatureSelection["kind"], string> = {
    road: "Road",
    building: "Building",
    tree: "Tree",
    sign: "Sign",
    traffic_signal: "Traffic signal",
    candidate: "Candidate",
    structure: "Structure",
    dense_cover: "Dense cover"
  };

  function updateInspectPanel() {
    inspectGenericDetailsEl.classList.add("hidden");
    inspectBuildingDetailsEl.classList.add("hidden");
    inspectTreeDetailsEl.classList.add("hidden");
    inspectSignDetailsEl.classList.add("hidden");
    inspectHeightFeetEl.disabled = true;
    inspectResetHeightEl.disabled = true;
    inspectTreeTypeEl.disabled = true;
    inspectTreeRadiusEl.disabled = true;
    inspectTreeHeightMetersEl.disabled = true;
    inspectTreeHeightFeetEl.disabled = true;
    inspectTreeResetHeightEl.disabled = true;
    inspectSignKindEl.disabled = true;
    inspectSignWidthEl.disabled = true;
    inspectSignHeightEl.disabled = true;
    inspectSignClearanceEl.disabled = true;
    inspectSignYawEl.disabled = true;
    inspectSignResetHeightEl.disabled = true;
    const selection = selectedFeature;
    if (!selection) {
      inspectEmptyEl.textContent = inspectMode
        ? "Click a feature to inspect."
        : "Enable Inspect mode to select features.";
      inspectEmptyEl.classList.remove("hidden");
      return;
    }
    inspectEmptyEl.classList.add("hidden");
    if (selection.kind === "building") {
      const building = worldModel?.buildings.find((item) => item.id === selection.id);
      if (!building) {
        inspectFeatureLabelEl.textContent = `Building · ${selection.id}`;
        inspectGenericDetailsEl.classList.remove("hidden");
        return;
      }
      inspectHeightFeetEl.disabled = false;
      inspectBuildingDetailsEl.classList.remove("hidden");
      inspectBuildingIdEl.textContent = building.name
        ? `${building.name} (${building.id})`
        : building.id;
      inspectEffectiveHeightEl.textContent = formatHeightLabel(
        building.height.effectiveHeightMeters
      );
      inspectInferredHeightEl.textContent = formatHeightLabel(
        building.height.inferredHeightMeters
      );
      inspectHeightSourceEl.textContent =
        heightSourceLabels[building.height.heightSource] ?? building.height.heightSource;
      inspectHeightConfidenceEl.textContent = formatConfidenceLabel(building.height.confidence);
      inspectResetHeightEl.disabled = !building.height.userOverrideMeters;
      inspectSyncing = true;
      if (building.height.userOverrideMeters) {
        inspectHeightFeetEl.value = formatHeightValue(
          building.height.userOverrideMeters / FEET_TO_METERS
        );
      } else {
        inspectHeightFeetEl.value = "";
      }
      inspectSyncing = false;
      return;
    }

    if (selection.kind === "tree") {
      const treeMatch = resolveTreeById(selection.id);
      if (!treeMatch) {
        inspectFeatureLabelEl.textContent = `Tree · ${selection.id}`;
        inspectGenericDetailsEl.classList.remove("hidden");
        return;
      }
      const tree = treeMatch.tree;
      inspectTreeDetailsEl.classList.remove("hidden");
      inspectTreeTypeEl.disabled = false;
      inspectTreeRadiusEl.disabled = false;
      inspectTreeHeightMetersEl.disabled = false;
      inspectTreeHeightFeetEl.disabled = false;
      inspectTreeIdEl.textContent = tree.id;
      inspectTreeTypeEl.value = tree.type;
      inspectTreeRadiusEl.value = formatHeightValue(tree.baseRadiusMeters, 2);
      const derivedHeight = deriveTreeHeightMeters(tree.baseRadiusMeters);
      inspectTreeDerivedHeightEl.textContent = formatHeightLabel(derivedHeight);
      inspectTreeResetHeightEl.disabled = tree.heightSource === "derived";
      inspectSyncing = true;
      if (tree.heightSource === "user_override") {
        inspectTreeHeightMetersEl.value = formatHeightValue(tree.heightMeters);
        inspectTreeHeightFeetEl.value = formatHeightValue(tree.heightMeters / FEET_TO_METERS);
      } else {
        inspectTreeHeightMetersEl.value = "";
        inspectTreeHeightFeetEl.value = "";
      }
      inspectSyncing = false;
      return;
    }

    if (selection.kind === "sign") {
      const signMatch = resolveSignById(selection.id);
      if (!signMatch) {
        inspectFeatureLabelEl.textContent = `Sign · ${selection.id}`;
        inspectGenericDetailsEl.classList.remove("hidden");
        return;
      }
      const sign = signMatch.sign;
      inspectSignDetailsEl.classList.remove("hidden");
      inspectSignKindEl.disabled = false;
      inspectSignWidthEl.disabled = false;
      inspectSignHeightEl.disabled = false;
      inspectSignClearanceEl.disabled = false;
      inspectSignYawEl.disabled = false;
      inspectSignIdEl.textContent = sign.id;
      inspectSignKindEl.value = sign.kind;
      inspectSignResetHeightEl.disabled = sign.heightSource === "default";
      inspectSyncing = true;
      inspectSignWidthEl.value = formatHeightValue(sign.widthMeters, 2);
      inspectSignHeightEl.value = formatHeightValue(sign.heightMeters, 2);
      inspectSignClearanceEl.value = formatHeightValue(sign.bottomClearanceMeters, 2);
      inspectSignYawEl.value = formatHeightValue(sign.yawDegrees, 0);
      inspectSyncing = false;
      return;
    }

    inspectFeatureLabelEl.textContent = `${featureLabels[selection.kind]} · ${selection.id}`;
    inspectGenericDetailsEl.classList.remove("hidden");
  }

  function updateWorldModel() {
    const worldTrees = fetchOsmObstacles
      ? [...autoData.trees, ...trees, ...mlData.trees]
      : [...trees, ...mlData.trees];
    const worldSigns = fetchOsmObstacles
      ? [...autoData.signs, ...signs, ...mlData.signs]
      : [...signs, ...mlData.signs];
    const worldTrafficSignals = fetchOsmObstacles ? autoData.trafficSignals : [];
    worldModel = buildWorldModelFromProject({
      project: {
        bounds: currentBounds,
        shapes: drawingManager.getShapes(),
        denseCover,
        structure,
        autoRoads: autoData.roads,
        autoBuildings: autoData.buildings,
        trees: worldTrees,
        signs: worldSigns,
        trafficSignals: worldTrafficSignals,
        customRoads,
        autoData
      },
      geoProjector,
      roadMode,
      now: new Date()
    });
    drawingManager.setWorldModel(worldModel);
    threeView.setWorldModel(worldModel);
    drawingManager.setStructureOverlay(structureOverlay);
    updateInspectPanel();
  }

  function resolveTreeById(
    id: string
  ): { tree: Tree; source: "manual" | "auto" | "ml"; index: number } | null {
    const manualIndex = trees.findIndex((tree) => tree.id === id);
    if (manualIndex !== -1) {
      return { tree: trees[manualIndex], source: "manual", index: manualIndex };
    }
    const autoIndex = autoData.trees.findIndex((tree) => tree.id === id);
    if (autoIndex !== -1) {
      return { tree: autoData.trees[autoIndex], source: "auto", index: autoIndex };
    }
    const mlIndex = mlData.trees.findIndex((tree) => tree.id === id);
    if (mlIndex !== -1) {
      return { tree: mlData.trees[mlIndex], source: "ml", index: mlIndex };
    }
    return null;
  }

  function resolveSignById(
    id: string
  ): { sign: Sign; source: "manual" | "auto" | "ml"; index: number } | null {
    const manualIndex = signs.findIndex((sign) => sign.id === id);
    if (manualIndex !== -1) {
      return { sign: signs[manualIndex], source: "manual", index: manualIndex };
    }
    const autoIndex = autoData.signs.findIndex((sign) => sign.id === id);
    if (autoIndex !== -1) {
      return { sign: autoData.signs[autoIndex], source: "auto", index: autoIndex };
    }
    const mlIndex = mlData.signs.findIndex((sign) => sign.id === id);
    if (mlIndex !== -1) {
      return { sign: mlData.signs[mlIndex], source: "ml", index: mlIndex };
    }
    return null;
  }

  function updateTreeById(id: string, updater: (tree: Tree) => Tree) {
    const match = resolveTreeById(id);
    if (!match) {
      return;
    }
    if (match.source === "manual") {
      const nextTrees = trees.slice();
      nextTrees[match.index] = updater(match.tree);
      trees = nextTrees;
    } else if (match.source === "auto") {
      const nextTrees = autoData.trees.slice();
      nextTrees[match.index] = updater(match.tree);
      autoData = { ...autoData, trees: nextTrees };
    } else {
      const nextTrees = mlData.trees.slice();
      nextTrees[match.index] = updater(match.tree);
      mlData = { ...mlData, trees: nextTrees };
    }
    updateWorldModel();
    scheduleAutosave();
  }

  function updateSignById(id: string, updater: (sign: Sign) => Sign) {
    const match = resolveSignById(id);
    if (!match) {
      return;
    }
    if (match.source === "manual") {
      const nextSigns = signs.slice();
      nextSigns[match.index] = updater(match.sign);
      signs = nextSigns;
    } else if (match.source === "auto") {
      const nextSigns = autoData.signs.slice();
      nextSigns[match.index] = updater(match.sign);
      autoData = { ...autoData, signs: nextSigns };
    } else {
      const nextSigns = mlData.signs.slice();
      nextSigns[match.index] = updater(match.sign);
      mlData = { ...mlData, signs: nextSigns };
    }
    updateWorldModel();
    scheduleAutosave();
  }

  function handleFeaturePlaced(request: {
    kind: "tree" | "sign";
    location: { lat: number; lon: number };
    treeType?: TreeType;
    signKind?: SignKind;
    radiusMeters?: number;
    yawDegrees?: number;
  }) {
    if (request.kind === "tree") {
      const type = request.treeType ?? DEFAULT_TREE_TYPE;
      const radiusMeters =
        typeof request.radiusMeters === "number" ? request.radiusMeters : Number.NaN;
      const baseRadiusMeters = Number.isFinite(radiusMeters) && radiusMeters > 0
        ? radiusMeters
        : DEFAULT_TREE_RADIUS_METERS;
      const heightMeters = deriveTreeHeightMeters(baseRadiusMeters);
      const tree: Tree = {
        id: createFeatureId("tree"),
        location: request.location,
        type,
        baseRadiusMeters,
        heightMeters,
        heightSource: DEFAULT_TREE_HEIGHT_SOURCE
      };
      trees = [...trees, tree];
      updateWorldModel();
      updateLabelStatus();
      scheduleAutosave();
      return;
    }
    const kind = request.signKind ?? DEFAULT_SIGN_KIND;
    const defaults = DEFAULT_SIGN_DIMENSIONS[kind];
    const yawDegrees = Number.isFinite(request.yawDegrees)
      ? (request.yawDegrees as number)
      : DEFAULT_SIGN_YAW_DEGREES;
    const sign: Sign = {
      id: createFeatureId("sign"),
      location: request.location,
      kind,
      widthMeters: defaults.widthMeters,
      heightMeters: defaults.heightMeters,
      bottomClearanceMeters: defaults.bottomClearanceMeters,
      yawDegrees,
      heightSource: DEFAULT_SIGN_HEIGHT_SOURCE
    };
    signs = [...signs, sign];
    updateWorldModel();
    updateLabelStatus();
    scheduleAutosave();
  }

  function handleFeatureMoved(request: {
    kind: "tree" | "sign";
    id: string;
    location: { lat: number; lon: number };
  }) {
    if (request.kind === "tree") {
      updateTreeById(request.id, (tree) => ({ ...tree, location: request.location }));
      return;
    }
    updateSignById(request.id, (sign) => ({ ...sign, location: request.location }));
  }

  function applyBuildingOverride(buildingId: string, meters: number | null) {
    let updated = false;
    const nextBuildings = autoData.buildings.map((building) => {
      if (building.id !== buildingId) {
        return building;
      }
      updated = true;
      const next = { ...building };
      if (meters && Number.isFinite(meters) && meters > 0) {
        next.userOverrideMeters = meters;
      } else {
        delete next.userOverrideMeters;
      }
      const heightInfo = resolveBuildingHeightInfo(next);
      next.inferredHeightMeters = heightInfo.inferredHeightMeters;
      next.heightSource = heightInfo.heightSource;
      next.confidence = heightInfo.confidence;
      next.userOverrideMeters = heightInfo.userOverrideMeters;
      next.effectiveHeightMeters = heightInfo.effectiveHeightMeters;
      return next;
    });
    if (!updated) {
      return;
    }
    autoData = { ...autoData, buildings: nextBuildings };
    drawingManager.setBuildings(autoData.buildings);
    updateWorldModel();
    scheduleAutosave();
  }

  function shapeChangeHandler(shapes: Shape[]) {
    statusMessageEl.textContent = `Shapes: ${shapes.length}`;
    renderCandidateList(shapes);
    clearStructureAnalysis();
    updateWorldModel();
    updateDebugHud();
    scheduleAutosave();
    updateOptimizationControls();
    pendingInterrupt();
  }

  renderCandidateList(drawingManager.getShapes());
  updateWorldModel();

  const parseOverrideInput = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  };

  const parseNonNegativeInput = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  };

  const parseNumberInput = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return parsed;
  };

  inspectHeightFeetEl.addEventListener("input", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "building") {
      return;
    }
    const feet = parseOverrideInput(inspectHeightFeetEl.value);
    if (feet === null) {
      return;
    }
    const meters = feet * FEET_TO_METERS;
    applyBuildingOverride(selectedFeature.id, meters);
  });
  inspectHeightFeetEl.addEventListener("blur", () => updateInspectPanel());

  inspectResetHeightEl.addEventListener("click", () => {
    if (!selectedFeature || selectedFeature.kind !== "building") {
      return;
    }
    applyBuildingOverride(selectedFeature.id, null);
  });

  inspectTreeTypeEl.addEventListener("change", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "tree") {
      return;
    }
    const nextType = inspectTreeTypeEl.value as TreeType;
    updateTreeById(selectedFeature.id, (tree) => ({
      ...tree,
      type: nextType === "pine" || nextType === "deciduous" ? nextType : tree.type
    }));
  });

  inspectTreeRadiusEl.addEventListener("input", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "tree") {
      return;
    }
    const radius = parseOverrideInput(inspectTreeRadiusEl.value);
    if (radius === null) {
      return;
    }
    updateTreeById(selectedFeature.id, (tree) => {
      const next: Tree = { ...tree, baseRadiusMeters: radius };
      if (tree.heightSource === "derived") {
        next.heightMeters = deriveTreeHeightMeters(radius);
      }
      return next;
    });
  });
  inspectTreeRadiusEl.addEventListener("blur", () => updateInspectPanel());

  inspectTreeHeightMetersEl.addEventListener("input", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "tree") {
      return;
    }
    const meters = parseOverrideInput(inspectTreeHeightMetersEl.value);
    if (meters === null) {
      return;
    }
    inspectSyncing = true;
    inspectTreeHeightFeetEl.value = formatHeightValue(meters / FEET_TO_METERS);
    inspectSyncing = false;
    updateTreeById(selectedFeature.id, (tree) => ({
      ...tree,
      heightMeters: meters,
      heightSource: "user_override"
    }));
  });
  inspectTreeHeightMetersEl.addEventListener("blur", () => updateInspectPanel());

  inspectTreeHeightFeetEl.addEventListener("input", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "tree") {
      return;
    }
    const feet = parseOverrideInput(inspectTreeHeightFeetEl.value);
    if (feet === null) {
      return;
    }
    const meters = feet * FEET_TO_METERS;
    inspectSyncing = true;
    inspectTreeHeightMetersEl.value = formatHeightValue(meters);
    inspectSyncing = false;
    updateTreeById(selectedFeature.id, (tree) => ({
      ...tree,
      heightMeters: meters,
      heightSource: "user_override"
    }));
  });
  inspectTreeHeightFeetEl.addEventListener("blur", () => updateInspectPanel());

  inspectTreeResetHeightEl.addEventListener("click", () => {
    if (!selectedFeature || selectedFeature.kind !== "tree") {
      return;
    }
    updateTreeById(selectedFeature.id, (tree) => {
      const nextHeight = deriveTreeHeightMeters(tree.baseRadiusMeters);
      return {
        ...tree,
        heightMeters: nextHeight,
        heightSource: "derived"
      };
    });
  });

  inspectSignKindEl.addEventListener("change", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "sign") {
      return;
    }
    const nextKind = inspectSignKindEl.value as SignKind;
    updateSignById(selectedFeature.id, (sign) => ({
      ...sign,
      kind: nextKind === "billboard" || nextKind === "sign" ? nextKind : sign.kind
    }));
  });

  inspectSignWidthEl.addEventListener("input", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "sign") {
      return;
    }
    const width = parseOverrideInput(inspectSignWidthEl.value);
    if (width === null) {
      return;
    }
    updateSignById(selectedFeature.id, (sign) => ({ ...sign, widthMeters: width }));
  });
  inspectSignWidthEl.addEventListener("blur", () => updateInspectPanel());

  inspectSignHeightEl.addEventListener("input", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "sign") {
      return;
    }
    const height = parseOverrideInput(inspectSignHeightEl.value);
    if (height === null) {
      return;
    }
    updateSignById(selectedFeature.id, (sign) => ({
      ...sign,
      heightMeters: height,
      heightSource: "user_override"
    }));
  });
  inspectSignHeightEl.addEventListener("blur", () => updateInspectPanel());

  inspectSignClearanceEl.addEventListener("input", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "sign") {
      return;
    }
    const clearance = parseNonNegativeInput(inspectSignClearanceEl.value);
    if (clearance === null) {
      return;
    }
    updateSignById(selectedFeature.id, (sign) => ({
      ...sign,
      bottomClearanceMeters: clearance
    }));
  });
  inspectSignClearanceEl.addEventListener("blur", () => updateInspectPanel());

  inspectSignYawEl.addEventListener("input", () => {
    if (inspectSyncing) {
      return;
    }
    if (!selectedFeature || selectedFeature.kind !== "sign") {
      return;
    }
    const yaw = parseNumberInput(inspectSignYawEl.value);
    if (yaw === null) {
      return;
    }
    updateSignById(selectedFeature.id, (sign) => ({ ...sign, yawDegrees: yaw }));
  });
  inspectSignYawEl.addEventListener("blur", () => updateInspectPanel());

  inspectSignResetHeightEl.addEventListener("click", () => {
    if (!selectedFeature || selectedFeature.kind !== "sign") {
      return;
    }
    updateSignById(selectedFeature.id, (sign) => {
      const defaults = DEFAULT_SIGN_DIMENSIONS[sign.kind];
      return {
        ...sign,
        heightMeters: defaults.heightMeters,
        heightSource: "default"
      };
    });
  });

  const applyLayerToggle = (layer: WorldLayer, input: HTMLInputElement) => {
    layerVisibility[layer] = input.checked;
    drawingManager.setWorldLayerVisibility(layer, input.checked);
  };

  layerRoadsEl.addEventListener("change", () => applyLayerToggle("roads", layerRoadsEl));
  layerBuildingsEl.addEventListener("change", () =>
    applyLayerToggle("buildings", layerBuildingsEl)
  );
  layerTreesEl.addEventListener("change", () => applyLayerToggle("trees", layerTreesEl));
  layerSignsEl.addEventListener("change", () => applyLayerToggle("signs", layerSignsEl));
  layerCandidatesEl.addEventListener("change", () =>
    applyLayerToggle("candidates", layerCandidatesEl)
  );
  layerTrafficEl.addEventListener("change", () => applyLayerToggle("traffic", layerTrafficEl));

  toggleInspectModeEl.addEventListener("change", () => {
    inspectMode = toggleInspectModeEl.checked;
    drawingManager.setInspectMode(inspectMode);
    if (inspectMode) {
      drawingManager.setRoadToolMode("off");
      setTool("select");
      clearObstacleToolButtons();
    }
    updateInspectPanel();
  });

  toggleFetchOsmObstaclesEl.addEventListener("change", () => {
    fetchOsmObstacles = toggleFetchOsmObstaclesEl.checked;
    updateWorldModel();
    updateAutoDataStatus();
    scheduleAutosave();
  });

  function getActiveRoads(): Road[] {
    return roadMode === "custom" ? customRoads : autoData.roads;
  }

  function getRoadDataForDrawing() {
    if (roadMode === "custom") {
      return { autoRoads: [], customRoads };
    }
    return { autoRoads: autoData.roads, customRoads: [] };
  }

  function getSelectedRoad(): Road | null {
    if (!selectedRoadId) return null;
    return getActiveRoads().find((road) => road.id === selectedRoadId) ?? null;
  }

  function setSelectedRoadId(roadId: string | null) {
    if (roadId === selectedRoadId) {
      return;
    }
    selectedRoadId = roadId;
    updateRoadProperties();
  }

  function syncCustomRoadsFromDrawing() {
    if (!drawingManager.getCustomRoadsDirty()) {
      return;
    }
    customRoads = drawingManager.getCustomRoads().map((road) => ({
      ...road,
      source: "custom"
    }));
    drawingManager.clearCustomRoadsDirty();
    if (selectedRoadId && !customRoads.some((road) => road.id === selectedRoadId)) {
      selectedRoadId = null;
    }
    updateRoadProperties();
    scheduleAutosave();
    updateWorldModel();
  }

  function updateRoadControlsState() {
    btnAddRoadEl.disabled = roadMode !== "custom";
    btnAutoPopulateEl.disabled = !frameLocked || roadMode !== "auto";
    btnRefreshAutoEl.disabled = !frameLocked || roadMode !== "auto";
    const showCustomTools = roadMode === "custom";
    customRoadControlsEl?.classList.toggle("hidden", !showCustomTools);
    customRoadHintEl?.classList.toggle("hidden", !showCustomTools);
    const selectedRoad = getSelectedRoad();
    const canEdit = roadMode === "custom" && selectedRoad?.source === "custom";
    btnEditRoadEl.disabled = !canEdit;
    btnDeleteRoadEl.disabled = !canEdit;
  }

  function updateRoadProperties() {
    const selectedRoad = getSelectedRoad();
    if (!selectedRoad) {
      roadPropertiesEl.classList.add("hidden");
      roadNameEl.value = "";
      roadDirectionEl.value = "both";
      roadShowCenterlineEl.checked = false;
      roadCarsForwardEl.value = "";
      roadCarsBackwardEl.value = "";
      roadCarsForwardEl.disabled = true;
      roadCarsBackwardEl.disabled = true;
      updateRoadControlsState();
      return;
    }
    roadPropertiesEl.classList.remove("hidden");
    roadNameEl.value = selectedRoad.name ?? "";
    roadDirectionEl.value = resolveRoadDirection(selectedRoad);
    roadShowCenterlineEl.checked = Boolean(selectedRoad.showDirectionLine);
    const isCustom = selectedRoad.source === "custom";
    roadCarsForwardEl.disabled = !isCustom;
    roadCarsBackwardEl.disabled = !isCustom;
    roadCarsForwardEl.value = formatOptionalNumber(selectedRoad.customTraffic?.forward);
    roadCarsBackwardEl.value = formatOptionalNumber(selectedRoad.customTraffic?.backward);
    updateRoadControlsState();
  }

  function updateAutoDataStatus() {
    if (autoDataLoading) {
      autoDataStatusEl.textContent = fetchOsmObstacles
        ? "Loading roads/buildings/obstacles…"
        : "Loading roads/buildings…";
      updateDebugHud();
      return;
    }
    if (
      !autoData.fetchedAt &&
      autoData.roads.length === 0 &&
      autoData.buildings.length === 0 &&
      autoData.trees.length === 0 &&
      autoData.signs.length === 0 &&
      autoData.trafficSignals.length === 0
    ) {
      autoDataStatusEl.textContent = "No auto data yet.";
      updateDebugHud();
      return;
    }
    const roadCount = autoData.counts?.roads ?? autoData.roads.length;
    const buildingCount = autoData.counts?.buildings ?? autoData.buildings.length;
    const treeCount = autoData.counts?.trees ?? autoData.trees.length;
    const signCount = autoData.counts?.signs ?? autoData.signs.length;
    const signalCount = autoData.counts?.trafficSignals ?? autoData.trafficSignals.length;
    const fetchedLabel = autoData.fetchedAt ?? "Imported";
    const endpointLabel = autoData.endpoint ? ` · ${autoData.endpoint}` : "";
    const showObstacleCounts =
      fetchOsmObstacles || autoData.trees.length > 0 || autoData.signs.length > 0;
    const obstacleLabel = showObstacleCounts
      ? ` · Trees ${treeCount} · Signs ${signCount} · Signals ${signalCount}`
      : "";
    autoDataStatusEl.textContent =
      `Roads ${roadCount} · Buildings ${buildingCount}${obstacleLabel} · ${fetchedLabel}${endpointLabel}`;
    updateSimulationExtentStatus();
    updateDebugHud();
  }

  function updateSimulationExtentStatus() {
    const bounds = frameLocked ? currentBounds : frameOverlay.getBounds();
    if (!bounds) {
      simulationExtentStatusEl.textContent = "Simulation extent: --";
      return;
    }
    const simBounds = computeSimBounds(bounds);
    const size = boundsSizeMeters(simBounds);
    const widthMi = size.widthM / METERS_PER_MILE;
    const heightMi = size.heightM / METERS_PER_MILE;
    simulationExtentStatusEl.textContent =
      `Simulation extent: ${SIM_BUFFER_MILES} mi buffer · ${widthMi.toFixed(1)} × ${heightMi.toFixed(1)} mi`;
  }

  function updateEpicenterUI() {
    epicenterRadiusValueEl.textContent = `${Math.round(epicenterRadiusM)} m`;
    if (epicenter) {
      epicenter = { ...epicenter, radiusM: epicenterRadiusM };
      epicenterStatusEl.textContent = `${epicenter.lat.toFixed(5)}, ${epicenter.lon.toFixed(5)}`;
    } else if (trafficEpicenters && trafficEpicenters.length > 0) {
      const primary = trafficEpicenters[0];
      epicenterStatusEl.textContent = `Auto (${trafficEpicenters.length}) · ${primary.point.lat.toFixed(5)}, ${primary.point.lon.toFixed(5)}`;
    } else {
      epicenterStatusEl.textContent = "Auto epicenter pending";
    }
  }

  function applyEpicenterDefaults(bounds: GeoBounds) {
    if (epicenter) {
      return;
    }
    const lat = (bounds.north + bounds.south) / 2;
    const lon = (bounds.east + bounds.west) / 2;
    const widthM = haversineMeters(lat, bounds.west, lat, bounds.east);
    const target = Number.isFinite(widthM) && widthM > 0 ? widthM * 0.2 : epicenterRadiusM;
    const radius = clamp(Math.round(target), epicenterRadiusMin, epicenterRadiusMax);
    epicenterRadiusM = radius;
    epicenterRadiusEl.value = radius.toString();
    updateEpicenterUI();
  }

  function updateTrafficUI() {
    trafficPresetEl.value = trafficConfig.preset;
    const hour = clampTrafficHour(trafficConfig.hour);
    trafficConfig.hour = hour;
    trafficHourEl.value = hour.toString();
    trafficDetailEl.value = trafficConfig.detail.toString();
    trafficDetailValueEl.textContent = formatTrafficDetail(trafficConfig.detail);
    trafficFlowDensityEl.value = trafficConfig.flowDensity;
    trafficCentralShareEl.value = trafficConfig.centralShare.toFixed(2);
    trafficHourRowEl.classList.remove("hidden");
    trafficHourValueEl.classList.remove("hidden");
    trafficHourValueEl.textContent = `${formatHour(hour)}:00`;
    if (trafficConfig.preset === "am" || trafficConfig.preset === "pm") {
      const windowStart = clampTrafficHour(hour - RUSH_WINDOW_HALF_SPAN);
      const windowEnd = clampTrafficHour(hour + RUSH_WINDOW_HALF_SPAN);
      trafficWindowHintEl.textContent = `Rush hour window: ${formatHour(windowStart)}-${formatHour(
        windowEnd
      )}`;
      trafficWindowHintEl.classList.remove("hidden");
    } else {
      trafficWindowHintEl.textContent = "";
      trafficWindowHintEl.classList.add("hidden");
    }
    toggleTrafficOverlayEl.checked = trafficConfig.showOverlay;
    toggleDirectionArrowsEl.checked = trafficConfig.showDirectionArrows;
  }

  function setTrafficStatus(message: string | null) {
    if (message) {
      trafficStatusEl.textContent = message;
      trafficStatusEl.classList.remove("hidden");
    } else {
      trafficStatusEl.textContent = "";
      trafficStatusEl.classList.add("hidden");
    }
  }

  function showTrafficProgress(label: string) {
    trafficProgressLabelEl.textContent = label;
    trafficProgressBarEl.value = 0;
    btnCancelTrafficEl.disabled = false;
    trafficProgressEl.classList.remove("hidden");
  }

  function updateTrafficProgress(value: number) {
    trafficProgressBarEl.value = Math.min(1, Math.max(0, value));
  }

  function hideTrafficProgress() {
    btnCancelTrafficEl.disabled = true;
    trafficProgressEl.classList.add("hidden");
  }

  function applyTrafficVisibility() {
    drawingManager.setTrafficOverlayEnabled(trafficConfig.showOverlay);
  }

  function applyTrafficViewState() {
    trafficView = buildTrafficViewState(trafficConfig);
    drawingManager.setTrafficData(trafficOverlayByRoadId, trafficView);
  }

  function applyRoadMode() {
    autoData.roads.forEach((road) => {
      if (!road.source) {
        road.source = "osm";
      }
    });
    customRoads.forEach((road) => {
      if (!road.source) {
        road.source = "custom";
      }
    });
    drawingManager.setRoadData(getRoadDataForDrawing());
    drawingManager.setBuildings(autoData.buildings);
    if (roadMode !== "custom") {
      drawingManager.setRoadToolMode("off");
    }
    updateRoadProperties();
    updateRoadControlsState();
    updateWorldModel();
  }

  function applyTrafficData() {
    trafficOverlayByRoadId = buildTrafficOverlayData(trafficBaseByRoadId, customRoads);
    applyTrafficViewState();
    applyTrafficVisibility();
    drawingManager.setTrafficEpicenters(debugEnabled ? trafficEpicenters ?? [] : []);
    const flowData: TrafficFlowData = {
      edgeTraffic: trafficEdgeTraffic ?? null,
      flowDensity: trafficView.flowDensity
    };
    threeView.setTraffic(flowData);
  }

  function setEpicenterFromLatLon(lat: number, lon: number) {
    epicenter = { lat, lon, radiusM: epicenterRadiusM };
    pendingEpicenterPick = false;
    updateEpicenterUI();
    updateFrameStatus();
    statusMessageEl.textContent = "Epicenter set.";
    scheduleAutosave();
  }

  function setRoadMode(nextMode: RoadMode) {
    if (roadMode === nextMode) {
      return;
    }
    roadMode = nextMode;
    modeAutoEl.checked = roadMode === "auto";
    modeCustomEl.checked = roadMode === "custom";
    if (roadMode === "custom") {
      customRoads.forEach((road) => {
        if (!road.source) {
          road.source = "custom";
        }
      });
    }
    applyRoadMode();
    scheduleAutosave();
  }

  function updateSelectedRoad(update: (road: Road) => void) {
    const roadId = selectedRoadId;
    if (!roadId) return;
    const roads = getActiveRoads();
    const road = roads.find((item) => item.id === roadId);
    if (!road) return;
    update(road);
    if (roadMode === "custom") {
      customRoads = roads;
    } else {
      autoData = { ...autoData, roads };
    }
    drawingManager.setRoadData(getRoadDataForDrawing());
    updateRoadProperties();
    applyTrafficData();
    scheduleAutosave();
    updateWorldModel();
  }

  function setRoadToolMode(mode: "off" | "edit") {
    drawingManager.setRoadToolMode(mode);
  }

  async function fetchAutoData(reason: "manual" | "refresh" | "lock") {
    if (!frameLocked) {
      statusMessageEl.textContent = "Lock the map frame before auto-populating.";
      return;
    }
    const bounds = currentBounds ?? frameOverlay.getBounds();
    if (!bounds) {
      statusMessageEl.textContent = "Map bounds unavailable.";
      return;
    }
    if (autoFetchController) {
      autoFetchController.abort();
    }
    const controller = new AbortController();
    autoFetchController = controller;
    autoDataLoading = true;
    autoDataError = null;
    btnAutoPopulateEl.disabled = true;
    btnRefreshAutoEl.disabled = true;
    statusMessageEl.textContent =
      reason === "refresh"
        ? fetchOsmObstacles
          ? "Refreshing roads, buildings, and obstacles…"
          : "Refreshing roads and buildings…"
        : reason === "lock"
          ? fetchOsmObstacles
            ? "Loading roads/buildings/obstacles…"
            : "Loading roads/buildings…"
          : fetchOsmObstacles
            ? "Fetching roads, buildings, and obstacles…"
            : "Fetching roads and buildings…";
    updateAutoDataStatus();
    try {
      const simBounds = computeSimBounds(bounds);
      const [frameResult, simResult] = await Promise.all([
        fetchOsmRoadsAndBuildings(bounds, {
          signal: controller.signal,
          includeObstacles: fetchOsmObstacles,
          includeBuildings: true,
          includeTrafficSignals: true,
          roadClassFilter: "all"
        }),
        fetchOsmRoadsAndBuildings(simBounds, {
          signal: controller.signal,
          includeObstacles: false,
          includeBuildings: false,
          includeTrafficSignals: true,
          roadClassFilter: "major_connectors"
        })
      ]);
      const mergedRoads = mergeOsmRoads(frameResult.roads, simResult.roads);
      const mergedSignals = mergeOsmTrafficSignals(
        frameResult.trafficSignals,
        simResult.trafficSignals
      );
      const roads = mergedRoads.map((road) => mapOsmRoad(road));
      const buildings = frameResult.buildings.map((building) => mapOsmBuilding(building));
      const heightProviders = getDefaultBuildingHeightProviders();
      const buildingHeights = await resolveBuildingHeights(
        buildings,
        { bounds: simBounds, signal: controller.signal },
        heightProviders
      );
      const enrichedBuildings = applyBuildingHeightEstimates(buildings, buildingHeights);
      const trees = fetchOsmObstacles
        ? frameResult.trees.map((tree) => mapOsmTree(tree))
        : autoData.trees;
      const signs = fetchOsmObstacles
        ? frameResult.signs.map((sign) => mapOsmSign(sign))
        : autoData.signs;
      const trafficSignals = mergedSignals.map((signal) => mapOsmTrafficSignal(signal));
      autoData = {
        bounds: simBounds,
        roads,
        buildings: enrichedBuildings,
        trees,
        signs,
        trafficSignals,
        fetchedAt: formatTimestamp(new Date(frameResult.meta.fetchedAtIso)),
        endpoint: frameResult.meta.endpoint,
        counts: {
          roads: roads.length,
          buildings: buildings.length,
          trees: trees.length,
          signs: signs.length,
          trafficSignals: mergedSignals.length
        }
      };
      updateAutoDataStatus();
      applyRoadMode();
      trafficBaseByRoadId = null;
      trafficOverlayByRoadId = {};
      trafficMeta = null;
      trafficGraphCapMessage = null;
      trafficEpicenters = null;
      trafficEdgeTraffic = null;
      trafficViewerSamples = null;
      applyTrafficData();
      setTrafficStatus("Traffic cleared. Recompute for updated roads.");
      statusMessageEl.textContent = "Auto data loaded.";
      scheduleAutosave();
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      console.error(err);
      autoDataError = (err as Error).message;
      statusMessageEl.textContent = `Auto data load failed: ${autoDataError}`;
    } finally {
      autoFetchController = null;
      autoDataLoading = false;
      updateRoadControlsState();
      updateAutoDataStatus();
    }
  }

  const autoDataCoversBounds = (bounds: GeoBounds): boolean => {
    if (!autoData.bounds) {
      return false;
    }
    return boundsContain(autoData.bounds, computeSimBounds(bounds));
  };

  async function ensureAutoDataForLockedFrame() {
    if (!frameLocked) {
      return;
    }
    const bounds = currentBounds ?? frameOverlay.getBounds();
    if (!bounds) {
      return;
    }
    if (autoDataCoversBounds(bounds)) {
      return;
    }
    await fetchAutoData("lock");
  }

  function finishTrafficRun() {
    trafficInFlight = false;
    updatePreviewSpin();
    activeTrafficRunId = 0;
    btnComputeTrafficEl.disabled = false;
    hideTrafficProgress();
    drawingManager.setTrafficPreview({ active: false });
    updateOptimizationControls();
  }

  function cancelTrafficRun(options?: { message?: string | null; skipWorkflow?: boolean }) {
    if (trafficWorker && activeTrafficRunId) {
      trafficWorker.postMessage({ type: "cancel", runId: activeTrafficRunId });
    }
    finishTrafficRun();
    notifyTrafficRunListeners({
      ok: false,
      message: options?.message ?? "Traffic simulation canceled."
    });
    if (options?.message !== undefined) {
      setTrafficStatus(options.message);
    }
    if (!options?.skipWorkflow) {
      setWorkflowMode(frameLocked ? "frame_locked" : "explore");
      refreshWorkflowUI();
    }
  }

  function handleTrafficMessage(event: MessageEvent) {
    const data = event.data as Record<string, unknown> | null;
    if (!data) return;
    const runId = typeof data.runId === "number" ? data.runId : null;
    if (runId !== null && runId !== activeTrafficRunId) {
      return;
    }
    const type = data.type ?? data.kind;
    if (type === "progress") {
      const progress = data as unknown as TrafficSimProgress;
      const total = Number(progress.total ?? 0);
      const completed = Number(progress.completed ?? 0);
      const ratio = total > 0 ? completed / total : 0;
      updateTrafficProgress(Number.isFinite(ratio) ? ratio : 0);
      if (typeof progress.phase === "string" && progress.phase.trim()) {
        trafficProgressLabelEl.textContent = `Simulating ${formatTrafficPresetLabel(progress.phase)}…`;
      }
      if (optimizationInFlight && optimizationPhase === "traffic") {
        const range = optimizationProgressRanges.traffic;
        const scaled = range.start + (range.end - range.start) * (Number.isFinite(ratio) ? ratio : 0);
        setOptimizationProgress("Simulating traffic…", scaled);
      }
      return;
    }
    if (type === "error") {
      finishTrafficRun();
      setTrafficStatus(
        typeof data.message === "string" ? data.message : "Traffic simulation failed."
      );
      notifyTrafficRunListeners({
        ok: false,
        message: typeof data.message === "string" ? data.message : "Traffic simulation failed."
      });
      setWorkflowMode(frameLocked ? "frame_locked" : "explore");
      refreshWorkflowUI();
      return;
    }
    if (type === "result" || type === "complete" || type === "done") {
      finishTrafficRun();
      const payload = data as {
        trafficByRoadId?: TrafficSimResult["roadTraffic"];
        edgeTraffic?: TrafficSimResult["edgeTraffic"];
        viewerSamples?: TrafficSimResult["viewerSamples"];
        epicenters?: TrafficSimResult["epicenters"];
        meta?: TrafficSimResult["meta"];
      };
      if (payload.trafficByRoadId) {
        trafficEdgeTraffic = payload.edgeTraffic ?? null;
        trafficViewerSamples = payload.viewerSamples ?? null;
        trafficEpicenters = payload.epicenters ?? null;
        updateEpicenterUI();
        const dwellByRoadId = trafficEdgeTraffic
          ? buildRoadDwellFactors(trafficEdgeTraffic)
          : null;
        const baseTraffic = convertWorkerTraffic(payload.trafficByRoadId);
        trafficBaseByRoadId = dwellByRoadId
          ? applyDwellFactorsToTrafficByRoadId(baseTraffic, dwellByRoadId)
          : baseTraffic;
        trafficMeta = payload.meta ?? null;
        applyTrafficResultsToRoads(getActiveRoads(), payload.trafficByRoadId, dwellByRoadId ?? undefined);
        applyTrafficData();
        setTrafficStatus(formatTrafficMeta(payload.meta, trafficGraphCapMessage));
        trafficSignature = buildTrafficSignature();
        notifyTrafficRunListeners({ ok: true });
      } else {
        setTrafficStatus("Traffic computed.");
        notifyTrafficRunListeners({ ok: false, message: "Traffic payload missing results." });
      }
      setWorkflowMode("analysis_ready");
      refreshWorkflowUI();
      scheduleAutosave();
    }
  }

  function ensureTrafficWorker(): Worker | null {
    if (trafficWorker) {
      return trafficWorker;
    }
    try {
      trafficWorker = new Worker(new URL("./traffic/trafficWorker.ts", import.meta.url), {
        type: "module"
      });
      trafficWorker.addEventListener("message", handleTrafficMessage);
      trafficWorker.addEventListener("error", (event) => {
        console.error(event);
        finishTrafficRun();
        setTrafficStatus("Traffic worker error.");
        notifyTrafficRunListeners({ ok: false, message: "Traffic worker error." });
        setWorkflowMode(frameLocked ? "frame_locked" : "explore");
        refreshWorkflowUI();
      });
      return trafficWorker;
    } catch (err) {
      console.error(err);
      setTrafficStatus("Traffic worker unavailable.");
      return null;
    }
  }

  function requestTrafficCompute(options?: { restart?: boolean }) {
    if (trafficInFlight) {
      if (options?.restart) {
        cancelTrafficRun({ skipWorkflow: true });
      } else {
        return;
      }
    }
    const roads = getActiveRoads();
    if (!roads.length) {
      statusMessageEl.textContent = "Add or fetch roads before computing traffic.";
      return;
    }
    const frameBounds = currentBounds ?? frameOverlay.getBounds();
    if (!frameBounds) {
      statusMessageEl.textContent = "Map bounds unavailable for traffic.";
      return;
    }
    const simBounds = computeSimBounds(frameBounds);
    const trafficRoads = buildTrafficRoads(roads, mapper);
    if (!trafficRoads) {
      statusMessageEl.textContent = "Load topography before simulating custom roads.";
      return;
    }
    const cappedTraffic = capTrafficRoadsByEdgeCount(
      trafficRoads,
      frameBounds,
      TRAFFIC_MAX_GRAPH_EDGES
    );
    trafficGraphCapMessage = cappedTraffic.capped
      ? `graph capped (${cappedTraffic.keptEdges.toLocaleString()} of ${cappedTraffic.totalEdges.toLocaleString()} edges)`
      : null;
    const trafficRoadsFinal = cappedTraffic.roads;
    const trafficBuildings = buildTrafficBuildings(autoData.buildings, mapper);
    const trafficSignals = buildTrafficSignals(autoData.trafficSignals, mapper);
    const worker = ensureTrafficWorker();
    if (!worker) {
      return;
    }
    trafficInFlight = true;
    updatePreviewSpin();
    updateOptimizationControls();
    trafficRunId += 1;
    activeTrafficRunId = trafficRunId;
    btnComputeTrafficEl.disabled = true;
    setWorkflowMode("traffic_running");
    refreshWorkflowUI();
    showTrafficProgress("Simulating traffic…");
    setTrafficStatus("Simulating traffic…");
    if (!Number.isFinite(trafficConfig.seed)) {
      trafficConfig.seed = Math.floor(Math.random() * 1_000_000);
    } else {
      trafficConfig.seed = Math.floor(trafficConfig.seed);
    }
    const previewSeed = (trafficConfig.seed | 0) ^ (activeTrafficRunId * 0x9e3779b1);
    drawingManager.setTrafficPreview({ active: true, seed: previewSeed });
    const epicenterPoint = epicenter
      ? { lat: epicenter.lat, lon: epicenter.lon }
      : null;
    const request: TrafficSimRequest = {
      roads: trafficRoadsFinal,
      buildings: trafficBuildings ?? undefined,
      frameBounds,
      simBounds,
      trafficSignals,
      config: {
        epicenter: epicenterPoint,
        epicenterRadiusM: epicenterRadiusM,
        centralShare: trafficConfig.centralShare
      },
      presets: ["am", "pm", "neutral"],
      detailLevel: trafficConfig.detail,
      seed: trafficConfig.seed
    };
    worker.postMessage({ type: "run", payload: request, runId: activeTrafficRunId });
  }

  let pendingShapeRestore: { bounds: GeoBounds | null; shapes: Shape[] } | null = null;

  function buildProjectState(): RuntimeProjectState {
    const imported =
      structure.imported
        ? {
            ...structure.imported,
            offset: { ...structure.imported.offset },
            footprintProxy: structure.imported.footprintProxy
              ? {
                  points: structure.imported.footprintProxy.points.map((point) => ({ ...point }))
                }
              : undefined
          }
        : undefined;
    return {
      bounds: currentBounds,
      basemapMode,
      basemapId: basemapMode,
      settings: { ...settings },
      shapes: drawingManager.getShapes(),
      denseCover: denseCover.map((item) => ({
        ...item,
        polygonLatLon: item.polygonLatLon.map((point) => ({ ...point }))
      })),
      trees: trees.map((tree) => ({ ...tree })),
      signs: signs.map((sign) => ({ ...sign })),
      structure: {
        version: structure.version,
        mode: structure.mode,
        footprint: {
          points: structure.footprint.points.map((point) => ({ ...point }))
        },
        heightMeters: structure.heightMeters,
        placeAtCenter: structure.placeAtCenter,
        centerPx: { ...structure.centerPx },
        rotationDeg: structure.rotationDeg,
        facePriority: structure.facePriority ? { ...structure.facePriority } : undefined,
        legacyWidthFt: structure.legacyWidthFt,
        legacyLengthFt: structure.legacyLengthFt,
        imported
      },
      roadMode,
      autoData: {
        bounds: autoData.bounds,
        roads: autoData.roads,
        buildings: autoData.buildings,
        trees: autoData.trees,
        signs: autoData.signs,
        trafficSignals: autoData.trafficSignals,
        fetchedAt: autoData.fetchedAt,
        endpoint: autoData.endpoint
      },
      autoRoads: autoData.roads,
      autoBuildings: autoData.buildings,
      autoTrees: autoData.trees,
      autoSigns: autoData.signs,
      autoTrafficSignals: autoData.trafficSignals,
      customRoads: customRoads.slice(),
      epicenter: epicenter ? { ...epicenter } : null,
      traffic: {
        config: { ...trafficConfig },
        data: trafficBaseByRoadId
      },
      trafficConfig: { ...trafficConfig },
      trafficView: { ...trafficView }
    };
  }

  function buildProjectExtras(): ProjectExtras {
    const extras: ProjectExtras = {
      roadMode,
      autoData: {
        bounds: autoData.bounds,
        fetchedAt: autoData.fetchedAt,
        endpoint: autoData.endpoint,
        counts: autoData.counts ?? null
      },
      fetchOsmObstacles,
      epicenter: epicenter ? { ...epicenter } : null,
      roadDirections: buildRoadDirectionOverrides([...autoData.roads, ...customRoads]),
      trafficMeta,
      trafficEpicenters: trafficEpicenters ?? null
    };
    if (mlData.trees.length > 0 || mlData.signs.length > 0) {
      extras.mlData = {
        trees: mlData.trees.map((tree) => ({ ...tree })),
        signs: mlData.signs.map((sign) => ({ ...sign })),
        importedAt: mlData.importedAt,
        sourceLabel: mlData.sourceLabel ?? null
      };
    }
    if (extras.roadDirections && Object.keys(extras.roadDirections).length === 0) {
      delete extras.roadDirections;
    }
    return extras;
  }

  function buildProjectPayload(): Record<string, unknown> {
    const payload = serializeProject(buildProjectState());
    const extras = buildProjectExtras();
    return { ...payload, [EXTRA_KEY]: extras };
  }

  function applyTrafficConfig(config: TrafficConfigInput) {
    const hadDirectionSetting = typeof config.showDirectionArrows === "boolean";
    const hadHourSetting = typeof config.hour === "number";
    let presetChanged = false;
    if (typeof config.preset === "string") {
      trafficConfig.preset = normalizeTrafficPreset(config.preset);
      presetChanged = true;
    }
    if (typeof config.hour === "number") {
      trafficConfig.hour = clampTrafficHour(config.hour);
    }
    if (typeof config.detail === "number") {
      trafficConfig.detail = clampInt(config.detail, 1, 5);
    }
    if (typeof config.showOverlay === "boolean") {
      trafficConfig.showOverlay = config.showOverlay;
    }
    if (typeof config.showDirectionArrows === "boolean") {
      trafficConfig.showDirectionArrows = config.showDirectionArrows;
    }
    if (typeof config.flowDensity === "string") {
      trafficConfig.flowDensity = normalizeTrafficFlowDensity(config.flowDensity);
    }
    if (typeof config.seed === "number") {
      trafficConfig.seed = config.seed;
    }
    if (typeof config.centralShare === "number") {
      trafficConfig.centralShare = clamp(config.centralShare, 0, 1);
    }
    if (presetChanged && !hadHourSetting) {
      trafficConfig.hour = presetDefaultHour(trafficConfig.preset);
    }
    if (presetChanged && !hadDirectionSetting) {
      trafficConfig.showDirectionArrows = trafficConfig.preset === "am" || trafficConfig.preset === "pm";
    }
  }

  function queueShapeRestore(bounds: GeoBounds | null, shapes: Shape[]) {
    pendingShapeRestore = { bounds, shapes };
    if (!pendingShapeRestore.bounds) {
      drawingManager.setShapes(pendingShapeRestore.shapes);
      pendingShapeRestore = null;
      return;
    }
    if (
      pendingShapeRestore.bounds &&
      currentBounds &&
      boundsApproxEqual(pendingShapeRestore.bounds, currentBounds)
    ) {
      drawingManager.setShapes(pendingShapeRestore.shapes);
      pendingShapeRestore = null;
    }
  }

  function applyProjectState(project: RuntimeProjectState, extras?: ProjectExtras) {
    applySettingsFromImport(project.settings, settings);
    frameOverlay.setLimits(
      settings.frame.minSideFt * FEET_TO_METERS,
      settings.frame.maxSideFt * FEET_TO_METERS
    );
    refreshSettingInputs(settings);
    applyDisplaySettingsToCanvas(drawingManager, settings);
    applyStructureState(project.structure);
    applyBasemapMode(resolveBasemapMode(project, basemapMode), { warn: false });
    if (project.bounds) {
      mapView.setBounds(project.bounds);
    }
    const nextAutoRoads = resolveProjectAutoRoads(project);
    const nextAutoBuildings = resolveProjectAutoBuildings(project);
    const nextAutoTrees = resolveProjectAutoTrees(project);
    const nextAutoSigns = resolveProjectAutoSigns(project);
    const nextAutoSignals = resolveProjectAutoTrafficSignals(project);
    trees = project.trees ?? [];
    signs = project.signs ?? [];
    denseCover = project.denseCover ?? [];
    autoData = {
      bounds: extras?.autoData?.bounds ?? project.autoData?.bounds ?? project.bounds ?? null,
      roads: nextAutoRoads.map((road) => ({ ...road, source: road.source ?? "osm" })),
      buildings: nextAutoBuildings,
      trees: nextAutoTrees,
      signs: nextAutoSigns,
      trafficSignals: nextAutoSignals,
      fetchedAt: extras?.autoData?.fetchedAt ?? project.autoData?.fetchedAt ?? null,
      endpoint: extras?.autoData?.endpoint ?? project.autoData?.endpoint ?? null,
      counts: extras?.autoData?.counts ?? null
    };
    const nextMlTrees = Array.isArray(extras?.mlData?.trees) ? extras?.mlData?.trees ?? [] : [];
    const nextMlSigns = Array.isArray(extras?.mlData?.signs) ? extras?.mlData?.signs ?? [] : [];
    mlData = {
      trees: nextMlTrees,
      signs: nextMlSigns,
      importedAt: extras?.mlData?.importedAt ?? null,
      sourceLabel: extras?.mlData?.sourceLabel ?? null
    };
    customRoads = (project.customRoads ?? []).map((road) => ({
      ...road,
      source: road.source ?? "custom"
    }));
    fetchOsmObstacles = extras?.fetchOsmObstacles ?? fetchOsmObstacles;
    toggleFetchOsmObstaclesEl.checked = fetchOsmObstacles;
    applyRoadDirectionOverrides([...autoData.roads, ...customRoads], extras?.roadDirections);
    const restoredMode =
      normalizeRoadMode(extras?.roadMode) ?? normalizeRoadMode(project.roadMode);
    roadMode = restoredMode ?? inferRoadMode(autoData.roads, customRoads);
    modeAutoEl.checked = roadMode === "auto";
    modeCustomEl.checked = roadMode === "custom";
    epicenter = extras?.epicenter ?? project.epicenter ?? null;
    if (epicenter?.radiusM) {
      epicenterRadiusM = epicenter.radiusM;
      epicenterRadiusEl.value = epicenterRadiusM.toString();
    }
    trafficEpicenters = extras?.trafficEpicenters ?? null;
    trafficEdgeTraffic = null;
    trafficViewerSamples = null;
    applyTrafficConfig(project.traffic?.config ?? project.trafficConfig ?? {});
    trafficView = normalizeTrafficView(project.trafficView, trafficConfig);
    trafficConfig.hour = trafficView.hour;
    trafficConfig.showDirectionArrows = trafficView.showDirection;
    trafficConfig.flowDensity = trafficView.flowDensity;
    trafficBaseByRoadId = expandTrafficPresets(project.traffic?.data ?? null);
    trafficMeta = extras?.trafficMeta ?? null;
    updateEpicenterUI();
    updateAutoDataStatus();
    updateEpicenterUI();
    updateTrafficUI();
    applyRoadMode();
    applyTrafficData();
    queueShapeRestore(project.bounds ?? null, project.shapes ?? []);
    updateRoadProperties();
    updateLabelStatus();
  }

  let syncLabelButtons: (() => void) | null = null;
  const setTool = setupTools(drawingManager, () => {
    clearObstacleToolButtons();
    updateStatusOverlay(null);
    syncLabelButtons?.();
  });
  const setObstacleTool = (tool: ToolMode) => {
    inspectMode = false;
    toggleInspectModeEl.checked = false;
    drawingManager.setInspectMode(false);
    setTool(tool);
    obstacleToolButtons.forEach(({ button, tool: entryTool }) => {
      button.classList.toggle("active", entryTool === tool);
    });
    updateInspectPanel();
  };
  obstacleToolButtons.forEach(({ button, tool }) => {
    button.addEventListener("click", () => {
      setObstacleTool(tool);
    });
  });
  const labelToolButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#labelToolButtons button[data-tool]")
  );
  let labelingEnabled = toggleLabelingModeEl.checked;
  let activeLabelTool: ToolMode = "labelTreeDeciduous";
  const isLabelTool = (tool: ToolMode) =>
    tool === "labelTreeDeciduous" ||
    tool === "labelTreePine" ||
    tool === "labelSign" ||
    tool === "labelBillboard";
  const syncLabelToolButtons = () => {
    const activeTool = drawingManager.getTool();
    labelToolButtons.forEach((button) => {
      const tool = button.dataset.tool as ToolMode;
      button.classList.toggle("active", labelingEnabled && activeTool === tool);
      button.disabled = !labelingEnabled;
    });
  };
  syncLabelButtons = syncLabelToolButtons;
  const setLabelTool = (tool: ToolMode) => {
    if (!labelingEnabled) {
      return;
    }
    activeLabelTool = tool;
    inspectMode = false;
    toggleInspectModeEl.checked = false;
    drawingManager.setInspectMode(false);
    setRoadToolMode("off");
    setTool(tool);
    syncLabelToolButtons();
  };
  labelToolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setLabelTool(button.dataset.tool as ToolMode);
    });
  });
  const setLabelingMode = (enabled: boolean) => {
    labelingEnabled = enabled;
    toggleLabelingModeEl.checked = enabled;
    if (enabled) {
      setLabelTool(activeLabelTool);
      return;
    }
    syncLabelToolButtons();
    if (isLabelTool(drawingManager.getTool())) {
      setTool("select");
    }
  };
  toggleLabelingModeEl.addEventListener("change", () => {
    setLabelingMode(toggleLabelingModeEl.checked);
  });
  setLabelingMode(labelingEnabled);
  if (btnAddCandidate) {
    btnAddCandidate.addEventListener("click", () => {
      setTool("drawCandidatePolygon");
    });
  }
  const updateLabelStatus = () => {
    const labelCount = trees.length + signs.length;
    const predictionCount = mlData.trees.length + mlData.signs.length;
    const parts = [`Labels: ${labelCount}`, `Predictions: ${predictionCount}`];
    if (mlData.sourceLabel) {
      parts.push(`Source: ${mlData.sourceLabel}`);
    }
    labelStatusEl.textContent = parts.join(" · ");
  };
  const exportLabels = () => {
    if (!currentBounds) {
      statusMessageEl.textContent = "Lock a frame before exporting labels.";
      return;
    }
    const projector = geoProjector ?? mapper;
    const tileId = getTileSourceIdForBasemap(basemapMode, autoStreetSupported);
    const tileSource = getTileSource(tileId);
    const { dataset, warnings } = buildLabelDataset({
      bounds: currentBounds,
      frameSize: projector?.size ?? baseImageSize,
      zoom: mapView.getZoom(),
      imagery: {
        basemapId: tileId,
        label: tileSource.label,
        url: tileSource.url,
        attribution: tileSource.attribution
      },
      trees,
      signs,
      projector
    });
    if (warnings.length) {
      console.warn("Label export warnings:", warnings);
    }
    const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "visopti-labels.json";
    a.click();
    URL.revokeObjectURL(url);
    statusMessageEl.textContent = "Labels exported.";
  };
  const applyPredictions = (
    nextTrees: Tree[],
    nextSigns: Sign[],
    sourceLabel?: string | null
  ) => {
    mlData = {
      trees: nextTrees,
      signs: nextSigns,
      importedAt: nextTrees.length || nextSigns.length ? new Date().toISOString() : null,
      sourceLabel: sourceLabel ?? null
    };
    updateWorldModel();
    updateLabelStatus();
    scheduleAutosave();
  };
  const updateMlDetectButton = () => {
    if (!btnDetectMlFrame) {
      return;
    }
    btnDetectMlFrame.disabled = mlDetecting || !frameLocked;
  };
  const detectMlInFrame = async () => {
    if (mlDetecting) {
      return;
    }
    if (!frameLocked || !currentBounds) {
      statusMessageEl.textContent = "Lock a frame before running ML detection.";
      return;
    }
    mlDetecting = true;
    updateMlDetectButton();
    statusMessageEl.textContent = "Running ML detection…";
    try {
      const { manifest } = await loadTreeSignsModel();
      const tileId = getTileSourceIdForBasemap(basemapMode, autoStreetSupported);
      const tileSource = getTileSource(tileId);
      const zoom = Math.min(tileSource.maxZoom, Math.max(0, Math.round(mapView.getZoom())));
      const patchSizePx = Math.max(64, Math.round(manifest.input?.width ?? 640));
      const topLeft = projectLatLonForMl(currentBounds.north, currentBounds.west, zoom);
      const bottomRight = projectLatLonForMl(currentBounds.south, currentBounds.east, zoom);
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
        const centerLatLon = unprojectLatLonForMl(center.x, center.y, zoom);
        const canvas = await renderPatchImage({
          centerLatLon,
          zoom,
          sizePx: patchSizePx,
          tileSource
        });
        const patchPredictions = await detectOnPatch(canvas);
        patchPredictions.forEach((prediction) => {
          if (prediction.class !== "tree_pine" && prediction.class !== "tree_deciduous") {
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
        if (ML_PATCH_THROTTLE_MS > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, ML_PATCH_THROTTLE_MS));
        }
      }
      const merged = applyMlNms(detections, ML_NMS_IOU);
      const frameSize = geoProjector?.size ?? baseImageSize;
      const objects: LabelDataset["objects"] = merged.map((prediction) => {
        const center = unprojectLatLonForMl(prediction.worldCx, prediction.worldCy, zoom);
        const metersPerPixel = metersPerPixelAtLatForMl(center.lat, zoom);
        const radiusPx = 0.5 * Math.max(prediction.worldW, prediction.worldH);
        const crownRadiusMeters = Math.max(0.1, radiusPx * metersPerPixel);
        return {
          kind: "tree",
          location: { lat: center.lat, lon: center.lon },
          type: prediction.class === "tree_pine" ? "pine" : "deciduous",
          crownRadiusMeters,
          confidence: prediction.confidence
        };
      });
      if (objects.length === 0) {
        statusMessageEl.textContent = "No ML trees found in the current frame.";
        return;
      }
      const dataset: LabelDataset = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        frame: {
          bounds: currentBounds,
          size: frameSize,
          zoom
        },
        imagery: {
          basemapId: tileId,
          label: tileSource.label,
          url: tileSource.url,
          attribution: tileSource.attribution
        },
        objects
      };
      const { trees: nextTrees, signs: nextSigns } = buildPredictionFeatures(dataset, {
        createId: createFeatureId
      });
      applyPredictions(nextTrees, nextSigns, "ML detect (beta)");
      statusMessageEl.textContent = `ML detections queued (${nextTrees.length} trees).`;
    } catch (err) {
      statusMessageEl.textContent = `ML detection failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`;
    } finally {
      mlDetecting = false;
      updateMlDetectButton();
    }
  };
  btnExportLabelsEl.addEventListener("click", exportLabels);
  btnClearPredictionsEl.addEventListener("click", () => {
    applyPredictions([], [], null);
    statusMessageEl.textContent = "Predictions cleared.";
  });
  btnDetectMlFrame?.addEventListener("click", () => {
    void detectMlInFrame();
  });
  importPredictionsFileEl.addEventListener("change", async () => {
    if (!importPredictionsFileEl.files || importPredictionsFileEl.files.length === 0) {
      return;
    }
    const file = importPredictionsFileEl.files[0];
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const { dataset, warnings } = parseLabelDataset(parsed);
      const { trees: nextTrees, signs: nextSigns, warnings: buildWarnings } =
        buildPredictionFeatures(dataset, { createId: createFeatureId });
      if (warnings.length || buildWarnings.length) {
        console.warn("Prediction import warnings:", [...warnings, ...buildWarnings]);
      }
      if (currentBounds && !boundsApproxEqual(currentBounds, dataset.frame.bounds)) {
        console.warn("Prediction frame bounds differ from the current frame.");
      }
      applyPredictions(nextTrees, nextSigns, file.name);
      statusMessageEl.textContent =
        `Predictions imported (${nextTrees.length} trees, ${nextSigns.length} signs).`;
    } catch (err) {
      statusMessageEl.textContent = `Prediction import failed: ${(err as Error).message}`;
    } finally {
      importPredictionsFileEl.value = "";
    }
  });
  importMlTreesFileEl?.addEventListener("change", async () => {
    if (!importMlTreesFileEl.files || importMlTreesFileEl.files.length === 0) {
      return;
    }
    const file = importMlTreesFileEl.files[0];
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const records = Array.isArray(parsed) ? parsed : [];
      const importedTrees: Tree[] = [];
      const importedSigns: Sign[] = [];
      records.forEach((record) => {
        if (!record || typeof record !== "object") {
          return;
        }
        const entry = record as {
          lat?: unknown;
          lon?: unknown;
          type?: unknown;
          crownRadiusMeters?: unknown;
          derivedHeightMeters?: unknown;
          yawDeg?: unknown;
          kind?: unknown;
        };
        const lat = typeof entry.lat === "number" ? entry.lat : null;
        const lon = typeof entry.lon === "number" ? entry.lon : null;
        const radius = typeof entry.crownRadiusMeters === "number" ? entry.crownRadiusMeters : null;
        const height =
          typeof entry.derivedHeightMeters === "number" ? entry.derivedHeightMeters : null;
        const typeRaw = typeof entry.type === "string" ? entry.type : "";
        const kindRaw = typeof entry.kind === "string" ? entry.kind : "";
        if (
          lat === null ||
          lon === null ||
          radius === null ||
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          !Number.isFinite(radius)
        ) {
          const signKind =
            typeRaw === "billboard" || kindRaw === "billboard"
              ? "billboard"
              : typeRaw === "sign" || typeRaw === "stop_sign" || kindRaw === "sign"
                ? "sign"
                : null;
          if (
            lat === null ||
            lon === null ||
            !Number.isFinite(lat) ||
            !Number.isFinite(lon) ||
            !signKind
          ) {
            return;
          }
          const defaults = DEFAULT_SIGN_DIMENSIONS[signKind];
          importedSigns.push({
            id: createFeatureId("ml-sign"),
            location: { lat, lon },
            kind: signKind,
            widthMeters: defaults.widthMeters,
            heightMeters: defaults.heightMeters,
            bottomClearanceMeters: defaults.bottomClearanceMeters,
            yawDegrees: typeof entry.yawDeg === "number" ? entry.yawDeg : 0,
            heightSource: "ml"
          });
          return;
        }
        const type =
          typeRaw === "tree_pine" || typeRaw === "pine"
            ? "pine"
            : typeRaw === "tree_deciduous" || typeRaw === "deciduous"
              ? "deciduous"
              : null;
        if (!type) {
          return;
        }
        importedTrees.push({
          id: createFeatureId("ml-tree"),
          location: { lat, lon },
          type,
          baseRadiusMeters: Math.max(0, radius),
          heightMeters: Number.isFinite(height)
            ? Math.max(0, height as number)
            : deriveTreeHeightMeters(radius),
          heightSource: "ml"
        });
      });
      if (importedTrees.length === 0 && importedSigns.length === 0) {
        statusMessageEl.textContent = "No ML trees or signs found in import.";
        return;
      }
      trees = [...trees, ...importedTrees];
      signs = [...signs, ...importedSigns];
      updateWorldModel();
      updateLabelStatus();
      scheduleAutosave();
      statusMessageEl.textContent = `Imported ${importedTrees.length} ML trees and ${importedSigns.length} ML signs into obstacles.`;
    } catch (err) {
      statusMessageEl.textContent = `ML import failed: ${(err as Error).message}`;
    } finally {
      importMlTreesFileEl.value = "";
    }
  });
  updateLabelStatus();
  setupSettings(settings, drawingManager, {
    interruptComputations: () => pendingInterrupt(),
    onSettingsChanged: () => scheduleAutosave()
  });
  refreshStructureInputs(structure);
  setupStructureControls(
    structure,
    {
      height: structureHeightEl,
      width: structureWidthEl,
      length: structureLengthEl,
      centered: structureCenteredEl
    },
    {
      onStructureChanged: () => {
        clearStructureAnalysis();
        updateStructurePreview();
        updateStructureRender();
        updateOptimizationControls();
        scheduleAutosave();
      },
      onCenteredChange: (centered) => {
        if (centered) {
          syncStructureCenterToFrame();
        }
      }
    }
  );

  modeAutoEl.addEventListener("change", () => {
    if (modeAutoEl.checked) {
      setRoadMode("auto");
    }
  });
  modeCustomEl.addEventListener("change", () => {
    if (modeCustomEl.checked) {
      setRoadMode("custom");
    }
  });

  btnAutoPopulateEl.addEventListener("click", () => {
    void fetchAutoData("manual");
  });
  btnRefreshAutoEl.addEventListener("click", () => {
    void fetchAutoData("refresh");
  });

  epicenterRadiusEl.addEventListener("input", () => {
    epicenterRadiusM = Number.parseFloat(epicenterRadiusEl.value) || epicenterRadiusM;
    updateEpicenterUI();
    scheduleAutosave();
  });
  btnPickEpicenterEl.addEventListener("click", () => {
    pendingEpicenterPick = !pendingEpicenterPick;
    statusMessageEl.textContent = pendingEpicenterPick
      ? "Click the map to set the epicenter."
      : "Epicenter pick canceled.";
    updateFrameStatus();
  });

  mapContainer.addEventListener("click", (event) => {
    if (!pendingEpicenterPick) return;
    const rect = mapContainer.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      return;
    }
    const bounds = mapView.getBounds();
    const point = screenPointToLatLon(bounds, x / rect.width, y / rect.height);
    setEpicenterFromLatLon(point.lat, point.lon);
  });

  canvas.addEventListener("click", (event) => {
    if (!pendingEpicenterPick) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    if (mapper) {
      const clampedX = clamp(x, 0, mapper.geo.image.width_px - 1);
      const clampedY = clamp(y, 0, mapper.geo.image.height_px - 1);
      const { lat, lon } = mapper.pixelToLatLon(clampedX, clampedY);
      setEpicenterFromLatLon(lat, lon);
      return;
    }
    const bounds = currentBounds ?? frameOverlay.getBounds();
    if (!bounds) {
      return;
    }
    const point = screenPointToLatLon(bounds, x / canvas.width, y / canvas.height);
    setEpicenterFromLatLon(point.lat, point.lon);
  });

  trafficPresetEl.addEventListener("change", () => {
    const preset = trafficPresetEl.value as TrafficPreset;
    trafficConfig.preset = preset;
    trafficConfig.hour = presetDefaultHour(preset);
    trafficConfig.showDirectionArrows = preset === "am" || preset === "pm";
    updateTrafficUI();
    applyTrafficViewState();
    scheduleAutosave();
  });
  trafficHourEl.addEventListener("input", () => {
    trafficConfig.hour = clampTrafficHour(Number.parseInt(trafficHourEl.value, 10));
    updateTrafficUI();
    applyTrafficViewState();
    scheduleAutosave();
  });
  trafficDetailEl.addEventListener("input", () => {
    trafficConfig.detail = clampInt(Number.parseInt(trafficDetailEl.value, 10), 1, 5);
    updateTrafficUI();
    scheduleAutosave();
  });
  toggleTrafficOverlayEl.addEventListener("change", () => {
    trafficConfig.showOverlay = toggleTrafficOverlayEl.checked;
    applyTrafficVisibility();
    scheduleAutosave();
  });
  toggleDirectionArrowsEl.addEventListener("change", () => {
    trafficConfig.showDirectionArrows = toggleDirectionArrowsEl.checked;
    applyTrafficViewState();
    scheduleAutosave();
  });
  trafficFlowDensityEl.addEventListener("change", () => {
    trafficConfig.flowDensity = normalizeTrafficFlowDensity(trafficFlowDensityEl.value);
    updateTrafficUI();
    applyTrafficViewState();
    scheduleAutosave();
  });
  trafficCentralShareEl.addEventListener("input", () => {
    const nextValue = Number.parseFloat(trafficCentralShareEl.value);
    if (Number.isFinite(nextValue)) {
      trafficConfig.centralShare = clamp(nextValue, 0, 1);
      updateTrafficUI();
      scheduleAutosave();
    }
  });
  btnComputeTrafficEl.addEventListener("click", () => {
    requestTrafficCompute();
  });
  btnRecomputeTrafficEl.addEventListener("click", () => {
    requestTrafficCompute({ restart: true });
  });
  btnCancelTrafficEl.addEventListener("click", () => {
    if (trafficInFlight) {
      cancelTrafficRun({ message: "Traffic simulation canceled." });
    }
  });

  btnAddRoadEl.addEventListener("click", () => {
    if (roadMode !== "custom") {
      setRoadMode("custom");
    }
    setRoadToolMode("edit");
  });
  btnEditRoadEl.addEventListener("click", () => {
    if (roadMode !== "custom") {
      setRoadMode("custom");
    }
    setRoadToolMode("edit");
  });
  btnDeleteRoadEl.addEventListener("click", () => {
    const selectedRoad = getSelectedRoad();
    if (!selectedRoad) return;
    if (roadMode !== "custom") {
      return;
    }
    customRoads = customRoads.filter((road) => road.id !== selectedRoad.id);
    drawingManager.setRoadData(getRoadDataForDrawing());
    setSelectedRoadId(null);
    scheduleAutosave();
  });

  roadNameEl.addEventListener("input", () => {
    updateSelectedRoad((road) => {
      road.name = roadNameEl.value.trim() || undefined;
    });
  });
  roadDirectionEl.addEventListener("change", () => {
    updateSelectedRoad((road) => {
      setRoadDirectionValue(road, roadDirectionEl.value as RoadDirection);
    });
  });
  roadShowCenterlineEl.addEventListener("change", () => {
    updateSelectedRoad((road) => {
      road.showDirectionLine = roadShowCenterlineEl.checked;
    });
  });
  const updateCustomTraffic = () => {
    updateSelectedRoad((road) => {
      road.customTraffic = road.customTraffic ?? {};
      road.customTraffic.forward = parseOptionalNumber(roadCarsForwardEl.value);
      road.customTraffic.backward = parseOptionalNumber(roadCarsBackwardEl.value);
    });
    applyTrafficData();
  };
  roadCarsForwardEl.addEventListener("input", updateCustomTraffic);
  roadCarsBackwardEl.addEventListener("input", updateCustomTraffic);

  updateAutoDataStatus();
  updateEpicenterUI();
  updateTrafficUI();
  updateRoadProperties();
  applyRoadMode();
  applyTrafficData();

  if (autosave) {
    applyProjectState(autosave.state, autosave.extras);
  }

  const getVisibilitySources = () => ({
    buildings: autoData.buildings,
    trees: fetchOsmObstacles
      ? [...autoData.trees, ...trees, ...mlData.trees]
      : [...trees, ...mlData.trees],
    signs: fetchOsmObstacles
      ? [...autoData.signs, ...signs, ...mlData.signs]
      : [...signs, ...mlData.signs],
    trafficViewerSamples
  });

  function updateOptimizationControls() {
    const hasCandidates = drawingManager
      .getShapes()
      .some((shape) => shape.type === "candidate" && shape.visible !== false);
    const hasStructure = isValidFootprint(resolveStructureFootprintPoints(structure));
    const topoReady = Boolean(mapper) && topographyCoverage >= TOPO_MIN_COVERAGE_ENABLE;
    const canRun =
      frameLocked &&
      topoReady &&
      hasCandidates &&
      hasStructure &&
      !optimizationInFlight &&
      !trafficInFlight &&
      !visibilityComputing;
    btnRunOptimizationEl.disabled = !canRun;
    btnCancelOptimizationEl.disabled = !optimizationInFlight;
  }

  function notifyTrafficRunListeners(outcome: { ok: boolean; message?: string }) {
    const listeners = trafficRunListeners.slice();
    trafficRunListeners = [];
    listeners.forEach((listener) => listener(outcome));
  }

  function buildTrafficSignature(): string | null {
    const bounds = currentBounds ?? frameOverlay.getBounds();
    if (!bounds) {
      return null;
    }
    const roads = getActiveRoads();
    const roadSignature = roads.map((road) => `${road.id}:${road.points.length}`).join("|");
    const epicenterKey = epicenter
      ? `${epicenter.lat.toFixed(5)},${epicenter.lon.toFixed(5)},${epicenterRadiusM.toFixed(1)}`
      : "none";
    return JSON.stringify({
      bounds: [
        bounds.north.toFixed(5),
        bounds.south.toFixed(5),
        bounds.east.toFixed(5),
        bounds.west.toFixed(5)
      ],
      roadMode,
      roadSignature,
      detail: trafficConfig.detail,
      seed: trafficConfig.seed,
      centralShare: trafficConfig.centralShare,
      epicenter: epicenterKey
    });
  }

  function isTrafficStale(): boolean {
    const nextSignature = buildTrafficSignature();
    if (!nextSignature) {
      return true;
    }
    if (!trafficBaseByRoadId || !trafficViewerSamples) {
      return true;
    }
    return trafficSignature !== nextSignature;
  }

  function waitForTrafficCompletion(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Optimization canceled.", "AbortError"));
        return;
      }
      const listener = (outcome: { ok: boolean; message?: string }) => {
        cleanup();
        if (outcome.ok) {
          resolve();
          return;
        }
        reject(new Error(outcome.message ?? "Traffic simulation failed."));
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Optimization canceled.", "AbortError"));
      };
      const cleanup = () => {
        trafficRunListeners = trafficRunListeners.filter((item) => item !== listener);
        signal.removeEventListener("abort", onAbort);
      };
      trafficRunListeners = [...trafficRunListeners, listener];
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  setupProjectActions(drawingManager, settings, statusMessageEl, {
    buildProjectState,
    buildProjectPayload,
    applyProjectState,
    scheduleAutosave
  });
  structureFacePriorityEl.addEventListener("change", () => {
    const raw = structureFacePriorityEl.value.trim();
    if (!raw) {
      facePriority = null;
      structure.facePriority = undefined;
    } else {
      const parsed = Number.parseInt(raw, 10);
      const arcDeg: FacePriorityArc["arcDeg"] = facePriority?.arcDeg ?? 180;
      facePriority = Number.isFinite(parsed)
        ? { primaryEdgeIndex: parsed, arcDeg }
        : null;
      structure.facePriority = facePriority ?? undefined;
    }
    if (structureAnalysis) {
      updateStructureAnalysisUI(structureAnalysis);
    }
  });
  updateStructureAnalysisUI(null);
  const abortOptimizationFlow = (message?: string) => {
    if (!optimizationAbortController) {
      return;
    }
    optimizationAbortController.abort();
    if (trafficInFlight) {
      cancelTrafficRun({ message: message ?? "Optimization canceled.", skipWorkflow: true });
    }
    if (trafficWorker) {
      trafficWorker.terminate();
      trafficWorker = null;
    }
  };

  async function runOptimizationFlow({ signal }: { signal: AbortSignal }) {
    optimizationInFlight = true;
    btnCancelOptimizationEl.disabled = false;
    updateOptimizationControls();
    clearOptimizationProgress();
    const throwIfAborted = () => {
      if (signal.aborted) {
        throw new DOMException("Optimization canceled.", "AbortError");
      }
    };
    try {
      if (!frameLocked) {
        statusMessageEl.textContent = "Lock the frame before running optimization.";
        return;
      }
      const mapperSnapshot = mapper;
      if (!mapperSnapshot) {
        statusMessageEl.textContent = "Load topography before running optimization.";
        return;
      }
      if (topographyCoverage < TOPO_MIN_COVERAGE_ENABLE) {
        statusMessageEl.textContent = `Terrain still loading (${Math.round(
          topographyCoverage * 100
        )}%). Wait for more coverage.`;
        return;
      }
      const frameInfo = getStructureFrameInfo();
      if (!frameInfo) {
        statusMessageEl.textContent = "Set a frame before running optimization.";
        return;
      }
      const shapes = drawingManager.getShapes();
      const candidateShapes = shapes.filter(
        (shape) => shape.type === "candidate" && shape.visible !== false
      );
      if (candidateShapes.length === 0) {
        statusMessageEl.textContent = "Add at least one candidate region before running optimization.";
        return;
      }
      if (!isValidFootprint(resolveStructureFootprintPoints(structure))) {
        statusMessageEl.textContent = "Structure footprint is invalid.";
        return;
      }

      setOptimizationPhase("preparing", "Preparing…", 1);
      statusMessageEl.textContent = "Preparing optimization…";
      throwIfAborted();

      if (trafficInFlight && !isTrafficStale()) {
        setOptimizationPhase("traffic", "Simulating traffic…", 0);
        await waitForTrafficCompletion(signal);
      } else if (isTrafficStale()) {
        setOptimizationPhase("traffic", "Simulating traffic…", 0);
        requestTrafficCompute({ restart: true });
        if (!trafficInFlight) {
          throw new Error("Traffic simulation could not start.");
        }
        await waitForTrafficCompletion(signal);
      }
      throwIfAborted();

      updateWorldModel();
      const visibilitySources = getVisibilitySources();
      const obstaclesSnapshot = shapes.filter(
        (shape) => shape.type === "obstacle" && shape.visible !== false
      );
      const combinedGrid = buildCombinedHeightGrid(mapperSnapshot, {
        buildings: visibilitySources.buildings,
        trees: visibilitySources.trees,
        signs: visibilitySources.signs,
        obstacles: obstaclesSnapshot
      });
      const combinedGridNoTrees =
        denseCover.length > 0
          ? buildCombinedHeightGrid(mapperSnapshot, {
              buildings: visibilitySources.buildings,
              signs: visibilitySources.signs,
              obstacles: obstaclesSnapshot
            })
          : null;
      const trafficViewers = buildTrafficViewerSamples(
        visibilitySources.trafficViewerSamples,
        mapperSnapshot
      );

      setVisibilityComputing(true);
      setOptimizationPhase("heatmap", "Computing visibility / heatmap…", 0);
      statusMessageEl.textContent = "Computing visibility heatmap…";
      const passSteps = buildPassSteps(Math.max(1, settings.sampleStepPx), mapperSnapshot.geo.image);
      for (let i = 0; i < passSteps.length; i += 1) {
        throwIfAborted();
        const step = passSteps[i];
        const tempSettings = withSampleResolution(settings, step);
        const viewers = sampleViewerPoints(shapes, tempSettings, mapperSnapshot).concat(
          trafficViewers
        );
        const candidates = sampleCandidatePoints(shapes, tempSettings, mapperSnapshot);
        if (viewers.length === 0 || candidates.length === 0) {
          statusMessageEl.textContent =
            viewers.length === 0
              ? "Need viewer zones or traffic samples to compute heatmap."
              : "Need candidate zones to compute heatmap.";
          drawingManager.clearHeatmap();
          clearOptimizationProgress();
          return;
        }
        const heatmap = computeVisibilityHeatmap(
          viewers,
          candidates,
          combinedGrid,
          tempSettings,
          mapperSnapshot,
          {
            denseCover,
            forestK: settings.forestK,
            combinedGridNoTrees
          },
          signal
        );
        throwIfAborted();
        drawingManager.setHeatmap(heatmap, Math.max(1, tempSettings.sampleStepPx));
        setOptimizationPhase(
          "heatmap",
          "Computing visibility / heatmap…",
          (i + 1) / passSteps.length
        );
        await delayFrame();
      }
      statusMessageEl.textContent = "Heatmap computed.";
      throwIfAborted();

      setOptimizationPhase("optimize", "Optimizing placement/orientation…", 0);
      statusMessageEl.textContent = "Optimizing structure placement…";
      const viewers = sampleViewerPoints(shapes, settings, mapperSnapshot).concat(trafficViewers);
      if (viewers.length === 0) {
        statusMessageEl.textContent =
          "Need viewer zones or traffic samples to optimize structure placement.";
        clearOptimizationProgress();
        return;
      }
      const candidateRegions =
        worldModel?.candidates
          .filter((candidate) => candidate.visible !== false)
          .map((candidate) => ({
            id: candidate.id,
            points: candidate.render ?? []
          }))
          .filter((candidate) => candidate.points.length >= 3) ?? [];
      if (candidateRegions.length === 0) {
        statusMessageEl.textContent = "Need candidate regions to optimize structure placement.";
        clearOptimizationProgress();
        return;
      }

      const heightM = Math.max(1, structure.heightMeters);
      const pixelsPerMeterX = frameInfo.widthPx / frameInfo.widthM;
      const pixelsPerMeterY = frameInfo.heightPx / frameInfo.heightM;
      if (!Number.isFinite(pixelsPerMeterX) || !Number.isFinite(pixelsPerMeterY)) {
        statusMessageEl.textContent = "Frame metrics are unavailable for optimization.";
        clearOptimizationProgress();
        return;
      }
      const activeFootprint = resolveStructureFootprintPoints(structure);
      const footprintTemplate = buildPolygonFootprintTemplate(
        activeFootprint.map((point) => ({
          x: point.x * pixelsPerMeterX,
          y: point.y * pixelsPerMeterY
        }))
      );
      const squareToRoad = structureSquareToRoadEl.checked;
      const roadsForSnap = squareToRoad
        ? worldModel?.roads
            .filter((road) => road.render && road.render.length >= 2)
            .map((road) => ({
              points: road.render as Array<{ x: number; y: number }>,
              class: road.class
            }))
        : undefined;

      const result = optimizeStructurePlacement({
        footprintTemplate,
        heightM,
        candidates: candidateRegions,
        viewers,
        combinedGrid,
        mapper: mapperSnapshot,
        settings,
        roads: roadsForSnap,
        facePriority,
        squareToRoad,
        rotationStepDeg: 10,
        rotationRefineStepDeg: 2,
        placementSamples: 30,
        refineTopK: 3,
        signal
      });
      throwIfAborted();
      if (!result) {
        statusMessageEl.textContent = "No valid placement found in candidate regions.";
        clearStructureAnalysis();
        clearOptimizationProgress();
        return;
      }
      structureAnalysis = result;
      structureOverlay = {
        faceScores: result.placement.faceScores.map((entry) => entry.score),
        highlight: true
      };
      structure.placeAtCenter = false;
      structureCenteredEl.checked = false;
      structure.centerPx = { ...result.placement.center };
      const rotationFallback =
        structure.mode === "imported" && structure.imported
          ? structure.imported.rotationDeg
          : structure.rotationDeg;
      const nextRotation = normalizeStructureRotation(
        result.placement.rotationDeg,
        rotationFallback
      );
      if (structure.mode === "imported" && structure.imported) {
        structure.imported.rotationDeg = nextRotation;
      } else {
        structure.rotationDeg = nextRotation;
      }
      updateStructurePreview();
      updateStructureRender();
      updateStructureAnalysisUI(result);
      scheduleAutosave();
      statusMessageEl.textContent = `Best placement score ${formatScore(
        result.placement.totalScore
      )}.`;
      finishOptimizationProgress("Done");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        statusMessageEl.textContent = "Optimization canceled.";
        finishOptimizationProgress("Canceled");
      } else {
        console.error(err);
        statusMessageEl.textContent = `Optimization error: ${(err as Error).message}`;
        finishOptimizationProgress("Error");
      }
    } finally {
      setVisibilityComputing(false);
      optimizationInFlight = false;
      optimizationAbortController = null;
      btnCancelOptimizationEl.disabled = true;
      updateOptimizationControls();
    }
  }

  btnRunOptimizationEl.addEventListener("click", () => {
    if (optimizationInFlight) {
      return;
    }
    const controller = new AbortController();
    optimizationAbortController = controller;
    void runOptimizationFlow({ signal: controller.signal });
  });

  btnCancelOptimizationEl.addEventListener("click", () => {
    abortOptimizationFlow("Optimization canceled.");
  });
  if (debugEnabled) {
    setupDebugProbe(canvas, () => mapper, () => lastPointer);
  }
  pendingInterrupt = () => {
    abortOptimizationFlow("Optimization canceled.");
  };
  drawingManager.setContours(null);
  drawingManager.setContourOpacity(settings.opacity.contours);
  drawingManager.setShowContours(settings.overlays.showContours);
  updateOptimizationControls();

  updateStatusOverlay(null);

  const updateWorkflowSteps = (mode: WorkflowState["mode"]) => {
    if (workflowStepMap.size === 0) {
      return;
    }
    workflowStepMap.forEach((step) => {
      step.classList.remove("is-active", "is-complete");
    });
    const markActive = (key: string) => workflowStepMap.get(key)?.classList.add("is-active");
    const markComplete = (key: string) => workflowStepMap.get(key)?.classList.add("is-complete");
    if (mode === "explore") {
      markActive("location");
      return;
    }
    if (mode === "frame_draft") {
      markComplete("location");
      markActive("frame");
      return;
    }
    if (mode === "analysis_ready") {
      markComplete("location");
      markComplete("frame");
      markComplete("lock");
      markComplete("traffic");
      markActive("structure");
      markActive("candidates");
      markActive("optimize");
      return;
    }
    markComplete("location");
    markComplete("frame");
    markComplete("lock");
    markActive("traffic");
  };

  const renderWorkflowUI = (state: WorkflowState) => {
    const searchEnabled = state.mode === "explore" || state.mode === "frame_draft";
    const geocodeBusy = Boolean(geocodeController);
    addressInputEl.disabled = !searchEnabled || geocodeBusy;
    addressGoEl.disabled = !searchEnabled || geocodeBusy;
    btnUseMapCenterEl.disabled = !searchEnabled;

    const hasDraft = Boolean(frameOverlay.getBounds());
    const allowFrameActions = state.mode === "explore" || state.mode === "frame_draft";
    btnSetFrameEl.disabled = !allowFrameActions;
    btnResetFrameEl.disabled = !hasDraft || frameLocked || state.mode === "traffic_running";
    btnLockFrame.disabled = !hasDraft || state.mode !== "frame_draft";
    btnUnlockFrameEl.disabled = !frameLocked || state.mode === "traffic_running";

    const canComputeTraffic =
      frameLocked &&
      !trafficInFlight &&
      (state.mode === "frame_locked" || state.mode === "analysis_ready");
    btnComputeTrafficEl.disabled = !canComputeTraffic;
    const canRecomputeTraffic =
      frameLocked &&
      (state.mode === "frame_locked" ||
        state.mode === "analysis_ready" ||
        state.mode === "traffic_running");
    btnRecomputeTrafficEl.disabled = !canRecomputeTraffic;
    controlsEl.classList.toggle("locked-mode", frameLocked);
    if (!frameLocked && inspectMode) {
      inspectMode = false;
      toggleInspectModeEl.checked = false;
      drawingManager.setInspectMode(false);
      updateInspectPanel();
    }
    updateWorkflowSteps(state.mode);
    updateOptimizationControls();
    updateDebugHud();
  };

  const refreshWorkflowUI = () => {
    renderWorkflowUI(getWorkflowState());
  };

  subscribeWorkflow(renderWorkflowUI);

  const setWorkspaceState = (locked: boolean) => {
    workspaceEl.classList.toggle("is-locked", locked);
    workspaceEl.classList.toggle("is-unlocked", !locked);
    showMapWhileLocked = locked && (pendingEpicenterPick || showImageryBackground);
    workspaceEl.classList.toggle("show-map", showMapWhileLocked);
  };

  const formatNumber = (value: number) => Math.round(value).toLocaleString("en-US");

  function updateFrameReadout() {
    const bounds = frameLocked ? currentBounds : frameOverlay.getBounds();
    if (!bounds) {
      frameWidthValueEl.textContent = "--";
      frameHeightValueEl.textContent = "--";
      frameAreaValueEl.textContent = "--";
      frameStatusEl.textContent = "No draft frame yet.";
      return;
    }
    const latMid = (bounds.north + bounds.south) / 2;
    const lonMid = (bounds.east + bounds.west) / 2;
    const widthM = haversineMeters(latMid, bounds.west, latMid, bounds.east);
    const heightM = haversineMeters(bounds.north, lonMid, bounds.south, lonMid);
    const widthFt = widthM / FEET_TO_METERS;
    const heightFt = heightM / FEET_TO_METERS;
    if (
      !Number.isFinite(widthFt) ||
      !Number.isFinite(heightFt) ||
      widthFt <= 0 ||
      heightFt <= 0
    ) {
      frameWidthValueEl.textContent = "--";
      frameHeightValueEl.textContent = "--";
      frameAreaValueEl.textContent = "--";
    } else {
      frameWidthValueEl.textContent = `${formatNumber(widthFt)} ft (${formatNumber(widthM)} m)`;
      frameHeightValueEl.textContent = `${formatNumber(heightFt)} ft (${formatNumber(heightM)} m)`;
      frameAreaValueEl.textContent = `${formatNumber(widthFt * heightFt)} sq ft`;
    }
    frameStatusEl.textContent = frameLocked ? "Frame locked." : "Draft frame ready.";
  }

  const updateFrameStatus = () => {
    const draftBounds = frameOverlay.getBounds();
    if (frameLocked && currentBounds) {
      if (!draftBounds || !boundsApproxEqual(draftBounds, currentBounds)) {
        frameOverlay.setBounds({ ...currentBounds }, { silent: true });
      }
    }
    setWorkspaceState(frameLocked);
    mapView.setLocked(frameLocked);
    drawingManager.setMapStylePreset(frameLocked ? "locked" : "satellite");
    if (frameLocked && currentBounds) {
      mapStatusEl.textContent = `Frame locked: N ${currentBounds.north.toFixed(4)} · S ${currentBounds.south.toFixed(4)} · W ${currentBounds.west.toFixed(4)} · E ${currentBounds.east.toFixed(4)}`;
    } else if (draftBounds) {
      mapStatusEl.textContent = "Draft frame ready: lock to continue.";
    } else {
      mapStatusEl.textContent = "Frame unlocked: pan/zoom to set a new reference.";
    }
    const bounds = frameLocked ? currentBounds : draftBounds;
    syncStructureCenterToFrame();
    frameOverlay.setVisible(Boolean(bounds));
    frameOverlay.setEditable(!frameLocked && Boolean(draftBounds));
    updateFrameReadout();
    updateSimulationExtentStatus();
    refreshWorkflowUI();
    updateDebugHud();
    syncThreeViewState();
    updateMlDetectButton();
  };

  const unlockFrameForSearch = () => {
    if (!frameLocked) {
      return;
    }
    if (trafficInFlight) {
      cancelTrafficRun({ message: "Traffic simulation canceled.", skipWorkflow: true });
    }
    frameLocked = false;
    clearGeoProjector();
    frameOverlay.setBounds(null);
    setWorkflowMode("explore");
    updateFrameStatus();
    updateRoadControlsState();
  };

  const setDraftFrame = (bounds: GeoBounds) => {
    if (trafficInFlight) {
      cancelTrafficRun({ message: "Traffic simulation canceled.", skipWorkflow: true });
    }
    frameOverlay.setBounds(bounds);
    setWorkflowMode("frame_draft");
    updateFrameStatus();
  };

  const clearDraftFrame = () => {
    if (trafficInFlight) {
      cancelTrafficRun({ message: "Traffic simulation canceled.", skipWorkflow: true });
    }
    frameOverlay.setBounds(null);
    setWorkflowMode("explore");
    updateFrameStatus();
  };

  const resolveGeocodeBounds = (result: {
    boundingbox?: string[];
    lat?: string;
    lon?: string;
  }): GeoBounds | null => {
    if (Array.isArray(result.boundingbox) && result.boundingbox.length === 4) {
      const [southRaw, northRaw, westRaw, eastRaw] = result.boundingbox;
      const south = Number.parseFloat(southRaw);
      const north = Number.parseFloat(northRaw);
      const west = Number.parseFloat(westRaw);
      const east = Number.parseFloat(eastRaw);
      if ([south, north, west, east].every((value) => Number.isFinite(value))) {
        return {
          north: Math.max(north, south),
          south: Math.min(north, south),
          east: Math.max(east, west),
          west: Math.min(east, west)
        };
      }
    }
    const lat = Number.parseFloat(result.lat ?? "");
    const lon = Number.parseFloat(result.lon ?? "");
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const delta = 0.02;
      return {
        north: clamp(lat + delta, -85, 85),
        south: clamp(lat - delta, -85, 85),
        east: lon + delta,
        west: lon - delta
      };
    }
    return null;
  };

  const runAddressSearch = async (query: string) => {
    if (geocodeController) {
      geocodeController.abort();
    }
    const controller = new AbortController();
    geocodeController = controller;
    statusMessageEl.textContent = "Searching address…";
    refreshWorkflowUI();
    try {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", "1");
      url.searchParams.set("q", query);
      const response = await fetch(url.toString(), { signal: controller.signal });
      if (!response.ok) {
        throw new Error("Address lookup failed.");
      }
      const results = (await response.json()) as Array<{
        display_name?: string;
        boundingbox?: string[];
        lat?: string;
        lon?: string;
      }>;
      if (!results.length) {
        statusMessageEl.textContent = "No address matches found.";
        return;
      }
      const bounds = resolveGeocodeBounds(results[0]);
      if (!bounds) {
        statusMessageEl.textContent = "Address lookup returned no bounds.";
        return;
      }
      unlockFrameForSearch();
      mapView.setBounds(bounds);
      statusMessageEl.textContent = "Address found. Adjust the map and lock the frame.";
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      console.error(err);
      statusMessageEl.textContent = `Address search failed: ${(err as Error).message}`;
    } finally {
      if (geocodeController === controller) {
        geocodeController = null;
      }
      refreshWorkflowUI();
    }
  };

  btnUseMapCenterEl.addEventListener("click", () => {
    const bounds = mapView.getBounds();
    const lat = (bounds.north + bounds.south) / 2;
    const lon = (bounds.east + bounds.west) / 2;
    addressInputEl.value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    statusMessageEl.textContent = "Using current map center. Adjust the map and set a frame.";
  });

  addressFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = addressInputEl.value.trim();
    if (!query) {
      statusMessageEl.textContent = "Enter an address to search.";
      return;
    }
    void runAddressSearch(query);
  });

  btnSetFrameEl.addEventListener("click", () => {
    const viewBounds = mapView.getBounds();
    const insetPct = 0.1;
    const inset = insetBounds(viewBounds, insetPct);
    const maxSideM = settings.frame.maxSideFt * FEET_TO_METERS;
    const { bounds, clamped } = clampBoundsToMaxSquare(inset, boundsCenter(viewBounds), maxSideM);
    setDraftFrame(bounds);
    if (clamped) {
      mapView.setBounds(bounds, { animate: true, duration: 0.75 });
    }
    statusMessageEl.textContent = "Draft frame set. Lock the frame to continue.";
  });

  btnResetFrameEl.addEventListener("click", () => {
    clearDraftFrame();
    statusMessageEl.textContent = "Draft frame cleared.";
  });

  btnUnlockFrameEl.addEventListener("click", () => {
    if (!frameLocked) {
      return;
    }
    if (trafficInFlight) {
      cancelTrafficRun({ message: "Traffic simulation canceled.", skipWorkflow: true });
    }
    frameLocked = false;
    clearGeoProjector();
    const draft = currentBounds ? { ...currentBounds } : null;
    frameOverlay.setBounds(draft);
    setWorkflowMode(draft ? "frame_draft" : "explore");
    statusMessageEl.textContent = "Frame unlocked. Adjust the map and set a new frame.";
    updateFrameStatus();
    updateRoadControlsState();
  });

  const setWarning = (message: string | null) => {
    if (!warningBannerEl) return;
    if (message) {
      warningBannerEl.textContent = message;
      warningBannerEl.classList.remove("hidden");
    } else {
      warningBannerEl.textContent = "";
      warningBannerEl.classList.add("hidden");
    }
  };

  const refreshTopography = async () => {
    if (!frameLocked) {
      statusMessageEl.textContent = "Lock the map frame before loading topography.";
      return;
    }
    const bounds = currentBounds ?? frameOverlay.getBounds();
    if (!bounds) {
      statusMessageEl.textContent = "Set a frame before loading topography.";
      return;
    }
    topographyRunId += 1;
    const runId = topographyRunId;
    if (topographyAbort) {
      topographyAbort.abort();
    }
    const topoController = new AbortController();
    topographyAbort = topoController;
    topographyCoverage = 0;
    topographyComplete = false;
    setTopographyLoading(true);
    topographyError = null;
    updateStructureBaseElevation(null);
    topographyGrid = null;
    updateOptimizationControls();
    const { frame, gridRows, gridCols } = buildMapFrame(mapView, bounds, settings);
    ensureGeoProjector(bounds, { width: frame.width, height: frame.height });
    ensureBaseImageSize(frame.width, frame.height);
    statusMessageEl.textContent = "Fetching map tiles and terrain…";
    statusOverlayEl.textContent = "Loading map tiles…";
    setWarning(null);
    const tileId = getTileSourceIdForBasemap(basemapMode, autoStreetSupported);
    const tileSource = getTileSource(tileId);
    let mapImage: HTMLCanvasElement;
    try {
      mapImage = await renderMapFrameImage(frame, tileSource, { basemapMode: tileId });
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Map tiles failed to load.";
      topographyError = message;
      statusMessageEl.textContent = `Topography load failed: ${message}`;
      setWarning("Unable to load map tiles. Check your network and try again.");
      updateStatusOverlay(null);
      updateFrameStatus();
      if (runId === topographyRunId) {
        setTopographyLoading(false);
      }
      return;
    }

    const geo = createGeoReference(bounds, { width: frame.width, height: frame.height });
    const frameChanged = !currentBounds || !boundsApproxEqual(currentBounds, bounds);
    currentBounds = bounds;
    applyEpicenterDefaults(bounds);
    setBaseImage(mapImage, { resetView: true });
    if (frameChanged) {
      drawingManager.clearShapes();
      drawingManager.clearHeatmap();
      drawingManager.setShading(null, Math.max(2, Math.floor(settings.sampleStepPx)));
    }
    mapper = null;
    drawingManager.setGeoMapper(null);
    drawingManager.setContours(null);

    statusOverlayEl.textContent = "Loading elevation data…";
    let elevationGrid: ElevationGrid | null = null;
    let partialGrid: ElevationGrid | null = null;
    let elevationError: string | null = null;
    let mapperReady = false;
    let lastProgress: TopographyProgress | null = null;
    const updateContoursThrottled = createThrottle(() => {
      if (!mapper) {
        return;
      }
      drawingManager.setContours(generateContourSegments(mapper, 1));
    }, TOPO_PROGRESS_THROTTLE_MS);
    const updateProgressUi = createThrottle(() => {
      if (!lastProgress) {
        return;
      }
      const approxLabel =
        lastProgress.coverage < TOPO_APPROX_COVERAGE ? " (approx)" : "";
      const rateLabel =
        lastProgress.rateLimitedCount > 0
          ? ` · slowing to ${lastProgress.currentQps.toFixed(1)} qps`
          : "";
      statusMessageEl.textContent = `Terrain: ${lastProgress.completedPoints}/${lastProgress.totalPoints} sampled${approxLabel}${rateLabel}`;
    }, TOPO_PROGRESS_THROTTLE_MS);
    const handleProgress = (progress: TopographyProgress) => {
      if (runId !== topographyRunId) {
        return;
      }
      lastProgress = progress;
      partialGrid = progress.grid;
      topographyCoverage = progress.coverage;
      topographyComplete = progress.completedPoints >= progress.totalPoints;
      updateStructureBaseElevation(progress.grid);
      if (!mapperReady) {
        mapper = new GeoMapper(geo, progress.grid);
        drawingManager.setGeoMapper(mapper);
        mapperReady = true;
        applyRoadMode();
        applyTrafficData();
        updateEpicenterUI();
      }
      updateOptimizationControls();
      updateProgressUi();
      updateContoursThrottled();
    };
    try {
      elevationGrid = await fetchElevationGrid(bounds, {
        rows: gridRows,
        cols: gridCols,
        onProgress: handleProgress,
        signal: topoController.signal
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      console.error(err);
      elevationError = err instanceof Error ? err.message : "Elevation data unavailable.";
    }

    if (runId !== topographyRunId) {
      return;
    }
    setTopographyLoading(false);

    const finalGrid = elevationGrid ?? partialGrid;
    const progressSnapshot = lastProgress as TopographyProgress | null;
    if (progressSnapshot) {
      topographyCoverage = progressSnapshot.coverage;
      topographyComplete = progressSnapshot.completedPoints >= progressSnapshot.totalPoints;
    }

    if (finalGrid) {
      topographyError = elevationError;
      updateStructureBaseElevation(finalGrid);
      const resolvedGrid = finalGrid as ElevationGrid;
      const mapperSnapshot = mapper as GeoMapper | null;
      if (!mapperReady || mapperSnapshot?.grid !== resolvedGrid) {
        mapper = new GeoMapper(geo, resolvedGrid);
        drawingManager.setGeoMapper(mapper);
        mapperReady = true;
      }
      if (mapperSnapshot) {
        drawingManager.setContours(generateContourSegments(mapperSnapshot, 1));
      }
      updateOptimizationControls();
      applyRoadMode();
      applyTrafficData();
      topographyGrid = resolvedGrid;
      threeView.setTerrain(resolvedGrid, geoProjector);
      updateEpicenterUI();
      if (elevationError) {
        setWarning(`Topography loading incomplete. ${elevationError}`);
        statusMessageEl.textContent = `Topography loaded (partial). ${elevationError}`;
      } else {
        setWarning(null);
        statusMessageEl.textContent = "Topography loaded.";
      }
      if (
        pendingShapeRestore &&
        pendingShapeRestore.bounds &&
        boundsApproxEqual(pendingShapeRestore.bounds, bounds) &&
        drawingManager.getShapes().length === 0
      ) {
        drawingManager.setShapes(pendingShapeRestore.shapes);
        pendingShapeRestore = null;
        statusMessageEl.textContent = elevationError
          ? "Topography loaded (partial, project restored)."
          : "Topography loaded (project restored).";
      }
    } else {
      mapper = null;
      drawingManager.setGeoMapper(null);
      drawingManager.setContours(null);
      updateStructureBaseElevation(null);
      topographyGrid = null;
      threeView.setTerrain(null, null);
      updateOptimizationControls();
      applyRoadMode();
      applyTrafficData();
      updateEpicenterUI();
      const warning = elevationError ?? "Elevation data unavailable.";
      topographyError = warning;
      statusMessageEl.textContent = `Map loaded. ${warning}`;
      setWarning(warning);
      if (
        pendingShapeRestore &&
        pendingShapeRestore.bounds &&
        boundsApproxEqual(pendingShapeRestore.bounds, bounds) &&
        drawingManager.getShapes().length === 0
      ) {
        drawingManager.setShapes(pendingShapeRestore.shapes);
        pendingShapeRestore = null;
      }
    }
    updateDebugHud();
    scheduleAutosave();
    updateStatusOverlay(null);
    updateFrameStatus();
  };

  btnLockFrame.addEventListener("click", async () => {
    const draftBounds = frameOverlay.getBounds();
    if (!draftBounds) {
      statusMessageEl.textContent = "Set a frame before locking.";
      return;
    }
    frameLocked = true;
    currentBounds = draftBounds;
    const { frame } = buildMapFrame(mapView, draftBounds, settings);
    ensureGeoProjector(draftBounds, { width: frame.width, height: frame.height });
    ensureBaseImageSize(frame.width, frame.height);
    setWorkflowMode("frame_locked");
    updateFrameStatus();
    updateRoadControlsState();
    const topoPromise = refreshTopography();
    const autoPromise = ensureAutoDataForLockedFrame();
    await Promise.allSettled([autoPromise, topoPromise]);
  });

  btnLoadTopography.addEventListener("click", async () => {
    await refreshTopography();
  });

  if (btnReturnFrameEl) {
    btnReturnFrameEl.addEventListener("click", () => {
      if (!currentBounds) {
        statusMessageEl.textContent = "No locked frame available.";
        return;
      }
      mapView.setBounds(currentBounds);
      statusMessageEl.textContent = "Returned to locked frame.";
      updateFrameStatus();
    });
  }

  updateFrameStatus();

  function scheduleAutosave() {
    if (autosaveTimer) {
      window.clearTimeout(autosaveTimer);
    }
    autosaveTimer = window.setTimeout(() => {
      autosave = { state: buildProjectState(), extras: buildProjectExtras() };
      saveAutosave(buildProjectPayload());
    }, 300);
  }
}

function setupTools(
  drawingManager: ReturnType<typeof createDrawingManager>,
  onToolChange: () => void
) {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#toolButtons button[data-tool]")
  );
  const setTool = (tool: ToolMode) => {
    drawingManager.setTool(tool);
    buttons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tool === tool));
    onToolChange();
  };
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      setTool(btn.dataset.tool as ToolMode);
    });
  });
  return setTool;
}

function setupSettings(
  settings: AppSettings,
  drawingManager: ReturnType<typeof createDrawingManager>,
  hooks?: { interruptComputations?: () => void; onSettingsChanged?: () => void }
) {
  const siteHeight = document.getElementById("siteHeight") as HTMLInputElement | null;
  const viewerHeight = document.getElementById("viewerHeight") as HTMLInputElement | null;
  const viewDistance = document.getElementById("viewDistance") as HTMLInputElement | null;
  const topoSpacing = document.getElementById("topoSpacing") as HTMLInputElement | null;
  const sampleStep = document.getElementById("sampleStep") as HTMLInputElement | null;
  const forestK = document.getElementById("forestK") as HTMLInputElement | null;
  const denseCoverDensity = document.getElementById(
    "denseCoverDensity"
  ) as HTMLSelectElement | null;
  const toggleViewers = document.getElementById("toggleViewers") as HTMLInputElement | null;
  const toggleCandidates = document.getElementById("toggleCandidates") as HTMLInputElement | null;
  const toggleObstacles = document.getElementById("toggleObstacles") as HTMLInputElement | null;
  const toggleContours = document.getElementById("toggleContours") as HTMLInputElement | null;

  if (
    !siteHeight ||
    !viewerHeight ||
    !viewDistance ||
    !topoSpacing ||
    !sampleStep ||
    !toggleViewers ||
    !toggleCandidates ||
    !toggleObstacles ||
    !toggleContours ||
    !forestK ||
    !denseCoverDensity
  ) {
    throw new Error("Settings inputs missing from DOM");
  }

  const ensureNumber = (input: HTMLInputElement, fallback: number) => {
    const value = Number.parseFloat(input.value);
    return Number.isFinite(value) ? value : fallback;
  };

  const updateSettings = () => {
    settings.siteHeightFt = ensureNumber(siteHeight, settings.siteHeightFt);
    settings.viewerHeightFt = ensureNumber(viewerHeight, settings.viewerHeightFt);
    settings.viewDistanceFt = Math.max(0, ensureNumber(viewDistance, settings.viewDistanceFt));
    settings.topoSpacingFt = Math.max(5, ensureNumber(topoSpacing, settings.topoSpacingFt));
    settings.sampleStepPx = Math.max(1, ensureNumber(sampleStep, settings.sampleStepPx));
    settings.forestK = Math.max(0, ensureNumber(forestK, settings.forestK));
    const densityValue = Number.parseFloat(denseCoverDensity.value);
    settings.denseCoverDensity = clamp(
      Number.isFinite(densityValue) ? densityValue : settings.denseCoverDensity,
      0,
      1
    );
    drawingManager.setDenseCoverDensity(settings.denseCoverDensity);
    hooks?.interruptComputations?.();
    hooks?.onSettingsChanged?.();
  };

  [siteHeight, viewerHeight, viewDistance, topoSpacing, sampleStep, forestK].forEach((input) => {
    input.addEventListener("input", updateSettings);
  });
  denseCoverDensity.addEventListener("change", updateSettings);

  const updateOverlayState = () => {
    settings.overlays.showViewers = toggleViewers.checked;
    settings.overlays.showCandidates = toggleCandidates.checked;
    settings.overlays.showObstacles = toggleObstacles.checked;
    settings.overlays.showContours = toggleContours.checked;
    drawingManager.setZoneVisibility("viewer", settings.overlays.showViewers);
    drawingManager.setZoneVisibility("candidate", settings.overlays.showCandidates);
    drawingManager.setZoneVisibility("obstacle", settings.overlays.showObstacles);
    drawingManager.setShowContours(settings.overlays.showContours);
    hooks?.interruptComputations?.();
  };

  toggleViewers.addEventListener("change", updateOverlayState);
  toggleCandidates.addEventListener("change", updateOverlayState);
  toggleObstacles.addEventListener("change", updateOverlayState);
  toggleContours.addEventListener("change", updateOverlayState);

  updateSettings();
  updateOverlayState();
  applyDisplaySettingsToCanvas(drawingManager, settings);
}

function setupStructureControls(
  structure: StructureParams,
  inputs: {
    height: HTMLInputElement;
    width: HTMLInputElement;
    length: HTMLInputElement;
    centered: HTMLInputElement;
  },
  hooks?: { onStructureChanged?: () => void; onCenteredChange?: (centered: boolean) => void }
) {
  const ensurePositive = (input: HTMLInputElement, fallback: number) => {
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(1, value);
  };

  const updateStructure = () => {
    const wasCentered = structure.placeAtCenter;
    if (structure.mode !== "imported") {
      const heightFt = ensurePositive(
        inputs.height,
        Math.max(1, structure.heightMeters * METERS_TO_FEET)
      );
      const legacy = getStructureLegacyDimensions(structure);
      const widthFt = ensurePositive(inputs.width, legacy.widthFt);
      const lengthFt = ensurePositive(inputs.length, legacy.lengthFt);
      structure.heightMeters = heightFt * FEET_TO_METERS;
      applyStructureLegacyDimensions(structure, widthFt, lengthFt);
    }
    structure.placeAtCenter = inputs.centered.checked;
    if (structure.placeAtCenter !== wasCentered) {
      hooks?.onCenteredChange?.(structure.placeAtCenter);
    }
    hooks?.onStructureChanged?.();
  };

  [inputs.height, inputs.width, inputs.length].forEach((input) => {
    input.addEventListener("input", updateStructure);
  });
  inputs.centered.addEventListener("change", updateStructure);

  updateStructure();
}

function setupProjectActions(
  drawingManager: ReturnType<typeof createDrawingManager>,
  settings: AppSettings,
  statusMessage: HTMLElement,
  hooks?: {
    buildProjectState?: () => RuntimeProjectState;
    buildProjectPayload?: () => Record<string, unknown>;
    applyProjectState?: (project: RuntimeProjectState, extras?: ProjectExtras) => void;
    scheduleAutosave?: () => void;
  }
) {
  const btnExport = document.getElementById("btnExportProject") as HTMLButtonElement | null;
  const importInput = document.getElementById("importFile") as HTMLInputElement | null;
  const btnExportShapes = document.getElementById("btnExportShapes") as HTMLButtonElement | null;
  const importShapesInput = document.getElementById("importShapesFile") as HTMLInputElement | null;

  if (!btnExport || !importInput || !btnExportShapes || !importShapesInput) {
    throw new Error("Project actions missing from DOM");
  }

  btnExport.addEventListener("click", () => {
    const projectState = hooks?.buildProjectState
      ? hooks.buildProjectState()
      : {
          shapes: drawingManager.getShapes(),
          settings: { ...settings }
        };
    const payload = hooks?.buildProjectPayload
      ? hooks.buildProjectPayload()
      : hooks?.buildProjectState
        ? serializeProject(projectState as RuntimeProjectState)
        : projectState;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "visopti-project.json";
    a.click();
    URL.revokeObjectURL(url);
    statusMessage.textContent = "Project exported.";
  });

  importInput.addEventListener("change", async () => {
    if (!importInput.files || importInput.files.length === 0) {
      return;
    }
    const file = importInput.files[0];
    const text = await file.text();
    try {
      const parsed = JSON.parse(text);
      const extras = readProjectExtras(parsed);
      let applied = false;
      try {
        const { state, warnings } = deserializeProject(parsed);
        if (warnings.length) {
          console.warn("Project import warnings:", warnings);
        }
        if (state && hooks?.applyProjectState) {
          hooks.applyProjectState(state as RuntimeProjectState, extras ?? undefined);
          applied = true;
        }
      } catch {
        applied = false;
      }
      if (!applied) {
        if (Array.isArray(parsed.shapes)) {
          drawingManager.setShapes(parsed.shapes as Shape[]);
          drawingManager.clearHeatmap();
        }
        if (parsed.settings) {
          applySettingsFromImport(parsed.settings as Partial<AppSettings>, settings);
          refreshSettingInputs(settings);
          applyDisplaySettingsToCanvas(drawingManager, settings);
        }
      }
      statusMessage.textContent = applied ? "Project imported." : "Project imported (legacy).";
      hooks?.scheduleAutosave?.();
    } catch (err) {
      statusMessage.textContent = `Import failed: ${(err as Error).message}`;
    } finally {
      importInput.value = "";
    }
  });

  btnExportShapes.addEventListener("click", () => {
    const data = drawingManager.getShapes();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "visopti-shapes.json";
    a.click();
    URL.revokeObjectURL(url);
    statusMessage.textContent = "Shapes exported.";
  });

  importShapesInput.addEventListener("change", async () => {
    if (!importShapesInput.files || importShapesInput.files.length === 0) {
      return;
    }
    try {
      const text = await importShapesInput.files[0].text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        drawingManager.setShapes(parsed as Shape[]);
        drawingManager.clearHeatmap();
        statusMessage.textContent = "Shapes imported.";
        hooks?.scheduleAutosave?.();
      } else {
        statusMessage.textContent = "Invalid shapes JSON.";
      }
    } catch (err) {
      statusMessage.textContent = `Shapes import failed: ${(err as Error).message}`;
    } finally {
      importShapesInput.value = "";
    }
  });
}

function setupDebugProbe(
  canvas: HTMLCanvasElement,
  getMapper: () => GeoMapper | null,
  getPointer: () => { x: number; y: number } | null
) {
  const METERS_TO_FEET = 3.280839895013123;
  canvas.addEventListener("click", () => {
    const mapper = getMapper();
    if (!mapper) {
      return;
    }
    const pointer = getPointer();
    if (!pointer) {
      return;
    }
    const clampedX = clamp(pointer.x, 0, mapper.geo.image.width_px - 1);
    const clampedY = clamp(pointer.y, 0, mapper.geo.image.height_px - 1);
    const { lat, lon } = mapper.pixelToLatLon(clampedX, clampedY);
    const elevationM = mapper.latLonToElevation(lat, lon);
    const elevationFt = elevationM * METERS_TO_FEET;
    console.log(
      `[probe] pixel (${clampedX.toFixed(1)}, ${clampedY.toFixed(1)}) → lat ${lat.toFixed(
        6
      )}, lon ${lon.toFixed(6)}, elevation ${elevationM.toFixed(2)} m (${elevationFt.toFixed(1)} ft)`
    );
  });
}

function applySettingsFromImport(source: Partial<AppSettings>, target: AppSettings) {
  if (typeof source.siteHeightFt === "number") target.siteHeightFt = source.siteHeightFt;
  if (typeof source.viewerHeightFt === "number") target.viewerHeightFt = source.viewerHeightFt;
  if (typeof source.viewDistanceFt === "number") target.viewDistanceFt = source.viewDistanceFt;
  if (typeof source.topoSpacingFt === "number") target.topoSpacingFt = source.topoSpacingFt;
  if (typeof source.sampleStepPx === "number") target.sampleStepPx = Math.max(1, source.sampleStepPx);
  if (typeof source.forestK === "number") target.forestK = Math.max(0, source.forestK);
  if (typeof source.denseCoverDensity === "number") {
    target.denseCoverDensity = clamp(source.denseCoverDensity, 0, 1);
  }
  if (source.frame) {
    if (typeof source.frame.maxSideFt === "number") {
      target.frame.maxSideFt = source.frame.maxSideFt;
    }
    if (typeof source.frame.minSideFt === "number") {
      target.frame.minSideFt = source.frame.minSideFt;
    }
  }
  if (source.overlays) {
    target.overlays.showViewers = source.overlays.showViewers ?? target.overlays.showViewers;
    target.overlays.showCandidates = source.overlays.showCandidates ?? target.overlays.showCandidates;
    target.overlays.showObstacles = source.overlays.showObstacles ?? target.overlays.showObstacles;
    target.overlays.showContours = source.overlays.showContours ?? target.overlays.showContours;
  }
  if (source.opacity) {
    target.opacity.viewer = source.opacity.viewer ?? target.opacity.viewer;
    target.opacity.candidate = source.opacity.candidate ?? target.opacity.candidate;
    target.opacity.obstacle = source.opacity.obstacle ?? target.opacity.obstacle;
    target.opacity.heatmap = source.opacity.heatmap ?? target.opacity.heatmap;
    target.opacity.shading = source.opacity.shading ?? target.opacity.shading;
    target.opacity.contours = source.opacity.contours ?? target.opacity.contours;
  }
}

function refreshSettingInputs(settings: AppSettings) {
  const map: Record<string, string> = {
    siteHeight: settings.siteHeightFt.toString(),
    viewerHeight: settings.viewerHeightFt.toString(),
    viewDistance: settings.viewDistanceFt.toString(),
    topoSpacing: settings.topoSpacingFt.toString(),
    sampleStep: settings.sampleStepPx.toString(),
    forestK: settings.forestK.toString(),
    denseCoverDensity: settings.denseCoverDensity.toString()
  };
  Object.entries(map).forEach(([id, value]) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) {
      input.value = value;
    }
  });
  const overlayMap: Record<string, boolean> = {
    toggleViewers: settings.overlays.showViewers,
    toggleCandidates: settings.overlays.showCandidates,
    toggleObstacles: settings.overlays.showObstacles,
    toggleContours: settings.overlays.showContours
  };
  Object.entries(overlayMap).forEach(([id, value]) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) {
      input.checked = value;
    }
  });
}

function refreshStructureInputs(structure: StructureParams) {
  const legacy = getStructureLegacyDimensions(structure);
  const map: Record<string, string> = {
    structureHeight: (structure.heightMeters * METERS_TO_FEET).toString(),
    structureWidth: legacy.widthFt.toString(),
    structureLength: legacy.lengthFt.toString()
  };
  Object.entries(map).forEach(([id, value]) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) {
      input.value = value;
      input.disabled = structure.mode === "imported";
    }
  });
  const centered = document.getElementById("structureCentered") as HTMLInputElement | null;
  if (centered) {
    centered.checked = structure.placeAtCenter;
  }
}

function friendlyToolName(tool: ToolMode): string {
  const lookup: Record<ToolMode, string> = {
    select: "Select",
    erase: "Erase",
    drawViewerPolygon: "Viewer Polygon",
    drawCandidatePolygon: "Candidate Polygon",
    drawObstaclePolygon: "Obstacle Polygon",
    drawObstacleEllipse: "Obstacle Ellipse",
    drawDenseCoverPolygon: "Dense Cover Polygon",
    placeTreePine: "Place Pine Tree",
    placeTreeDeciduous: "Place Deciduous Tree",
    placeSign: "Place Sign/Billboard",
    labelTreePine: "Label Pine Tree",
    labelTreeDeciduous: "Label Deciduous Tree",
    labelSign: "Label Sign",
    labelBillboard: "Label Billboard"
  };
  return lookup[tool];
}

function buildMapFrame(mapView: MapViewInstance, bounds: GeoBounds, settings: AppSettings) {
  const size = mapView.getSize();
  const dpr = window.devicePixelRatio || 1;
  let width = Math.max(400, Math.round(size.width * dpr));
  let height = Math.max(300, Math.round(size.height * dpr));
  const maxDimension = 1600;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  const targetSpacingM = Math.max(1, settings.topoSpacingFt) * 0.3048;
  const latMid = (bounds.north + bounds.south) / 2;
  const lonMid = (bounds.east + bounds.west) / 2;
  const widthM = haversineMeters(latMid, bounds.west, latMid, bounds.east);
  const heightM = haversineMeters(bounds.north, lonMid, bounds.south, lonMid);
  const gridCols = clampInt(Math.round(widthM / targetSpacingM) + 1, 20, 80);
  const gridRows = clampInt(Math.round(heightM / targetSpacingM) + 1, 20, 80);
  return {
    frame: {
      bounds,
      zoom: mapView.getZoom(),
      width,
      height
    },
    gridRows,
    gridCols
  };
}

function createPlaceholderCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }
  ctx.fillStyle = "#1b1f26";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#2f3742";
  ctx.fillRect(0, 0, width, 48);
  ctx.fillStyle = "#9aa3af";
  ctx.font = "20px 'Segoe UI', sans-serif";
  ctx.fillText("Map frame not loaded yet", 20, 32);
  ctx.fillStyle = "#6b7280";
  ctx.font = "14px 'Segoe UI', sans-serif";
  ctx.fillText("Use the map to pick a frame, then lock and load topography.", 20, 70);
  return canvas;
}

function createBlankCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

function createDefaultSettings(): AppSettings {
  return {
    siteHeightFt: 6,
    viewerHeightFt: 6,
    viewDistanceFt: 2000,
    topoSpacingFt: 25,
    sampleStepPx: 5,
    forestK: 0.04,
    denseCoverDensity: 0.6,
    frame: {
      maxSideFt: 2640,
      minSideFt: 300
    },
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
}

function isValidFootprint(points: { x: number; y: number }[] | undefined): boolean {
  if (!points || points.length < 3) {
    return false;
  }
  return points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function buildRectFootprintPoints(widthFt: number, lengthFt: number): { x: number; y: number }[] {
  const widthM = Math.max(1, widthFt) * FEET_TO_METERS;
  const lengthM = Math.max(1, lengthFt) * FEET_TO_METERS;
  const halfWidth = Math.max(0.1, widthM / 2);
  const halfLength = Math.max(0.1, lengthM / 2);
  return [
    { x: -halfWidth, y: -halfLength },
    { x: halfWidth, y: -halfLength },
    { x: halfWidth, y: halfLength },
    { x: -halfWidth, y: halfLength }
  ];
}

function getFootprintBounds(points: { x: number; y: number }[]): { widthM: number; lengthM: number } {
  if (!points || points.length === 0) {
    return { widthM: 0, lengthM: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  points.forEach((point) => {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  });
  return { widthM: Math.max(0, maxX - minX), lengthM: Math.max(0, maxY - minY) };
}

function getStructureLegacyDimensions(structure: StructureParams): {
  widthFt: number;
  lengthFt: number;
} {
  const widthFt = Number.isFinite(structure.legacyWidthFt)
    ? Math.max(1, structure.legacyWidthFt as number)
    : undefined;
  const lengthFt = Number.isFinite(structure.legacyLengthFt)
    ? Math.max(1, structure.legacyLengthFt as number)
    : undefined;
  if (widthFt && lengthFt) {
    return { widthFt, lengthFt };
  }
  if (!isValidFootprint(structure.footprint.points)) {
    return { widthFt: 60, lengthFt: 90 };
  }
  const bounds = getFootprintBounds(structure.footprint.points);
  return {
    widthFt: Math.max(1, bounds.widthM * METERS_TO_FEET),
    lengthFt: Math.max(1, bounds.lengthM * METERS_TO_FEET)
  };
}

function applyStructureLegacyDimensions(
  structure: StructureParams,
  widthFt: number,
  lengthFt: number
) {
  const normalizedWidth = Math.max(1, widthFt);
  const normalizedLength = Math.max(1, lengthFt);
  structure.legacyWidthFt = normalizedWidth;
  structure.legacyLengthFt = normalizedLength;
  structure.footprint.points = buildRectFootprintPoints(normalizedWidth, normalizedLength);
}

function createDefaultStructure(): StructureParams {
  const legacyWidthFt = 60;
  const legacyLengthFt = 90;
  return {
    version: 2,
    mode: "parametric",
    footprint: {
      points: buildRectFootprintPoints(legacyWidthFt, legacyLengthFt)
    },
    heightMeters: 30 * FEET_TO_METERS,
    placeAtCenter: true,
    centerPx: { x: 0, y: 0 },
    rotationDeg: 0,
    legacyWidthFt,
    legacyLengthFt
  };
}

function createDefaultTrafficConfig(): TrafficConfig {
  return {
    preset: "neutral",
    hour: presetDefaultHour("neutral"),
    detail: 3,
    showOverlay: true,
    showDirectionArrows: false,
    flowDensity: "medium",
    seed: Math.floor(Math.random() * 1_000_000),
    centralShare: 0.6
  };
}

function createDefaultTrafficView(config?: TrafficConfig): TrafficViewState {
  const preset = normalizeTrafficPreset(config?.preset ?? "neutral");
  return {
    preset,
    hour: clampTrafficHour(config?.hour ?? presetDefaultHour(preset)),
    showDirection: config?.showDirectionArrows ?? false,
    flowDensity: normalizeTrafficFlowDensity(config?.flowDensity ?? "medium")
  };
}

const PRESET_DEFAULT_HOURS: Record<TrafficPresetKey, number> = {
  am: 8,
  pm: 17,
  neutral: 12
};

function presetDefaultHour(preset: string): number {
  const normalized = normalizeTrafficPreset(preset);
  return clampTrafficHour(PRESET_DEFAULT_HOURS[normalized] ?? PRESET_DEFAULT_HOURS.neutral);
}

function clampTrafficHour(value: number): number {
  return clampInt(value, TRAFFIC_HOUR_MIN, TRAFFIC_HOUR_MAX);
}

function isTrafficPresetKey(value: string): value is TrafficPresetKey {
  return value === "am" || value === "pm" || value === "neutral";
}

function isTrafficPreset(value: string): value is TrafficPreset {
  return value === "am" || value === "pm" || value === "neutral";
}

function normalizeTrafficPreset(value: string): TrafficPreset {
  if (value === "am" || value === "pm" || value === "neutral") {
    return value;
  }
  return "neutral";
}

function normalizeTrafficFlowDensity(value: string): TrafficFlowDensity {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function buildTrafficViewState(config: TrafficConfig): TrafficViewState {
  return {
    preset: normalizeTrafficPreset(config.preset),
    hour: clampTrafficHour(config.hour),
    showDirection: config.showDirectionArrows,
    flowDensity: normalizeTrafficFlowDensity(config.flowDensity)
  };
}

function normalizeTrafficView(
  view: TrafficViewState | undefined,
  config: TrafficConfig
): TrafficViewState {
  const fallback = buildTrafficViewState(config);
  if (!view) {
    return fallback;
  }
  return {
    preset: isTrafficPreset(view.preset) ? view.preset : fallback.preset,
    hour: Number.isFinite(view.hour) ? clampTrafficHour(view.hour) : fallback.hour,
    showDirection: typeof view.showDirection === "boolean" ? view.showDirection : fallback.showDirection,
    flowDensity:
      typeof view.flowDensity === "string"
        ? normalizeTrafficFlowDensity(view.flowDensity)
        : fallback.flowDensity
  };
}

function buildTrafficByPreset(byHour: TrafficByHour): TrafficByPreset {
  return {
    am: { ...byHour },
    pm: { ...byHour },
    neutral: { ...byHour }
  };
}

function expandTrafficPresets(data: TrafficByRoadId | null): TrafficByRoadId | null {
  if (!data) {
    return null;
  }
  const expanded: TrafficByRoadId = {};
  Object.entries(data).forEach(([roadId, byPreset]) => {
    const presetKeys = Object.keys(byPreset);
    if (!presetKeys.length) {
      return;
    }
    const baseKey = presetKeys.find((key) => isTrafficPresetKey(key)) ?? presetKeys[0];
    const baseByHour = byPreset[baseKey] ?? {};
    expanded[roadId] = {
      am: byPreset.am ?? baseByHour,
      pm: byPreset.pm ?? baseByHour,
      neutral: byPreset.neutral ?? baseByHour
    };
  });
  return expanded;
}

function buildTrafficByHourFromScores(
  forwardScore: number | null | undefined,
  backwardScore: number | null | undefined
): TrafficByHour {
  const forward =
    typeof forwardScore === "number" && Number.isFinite(forwardScore)
      ? clampTrafficScore(forwardScore)
      : null;
  const backward =
    typeof backwardScore === "number" && Number.isFinite(backwardScore)
      ? clampTrafficScore(backwardScore)
      : null;
  if (forward === null && backward === null) {
    return {};
  }
  const total = Math.max(forward ?? 0, backward ?? 0);
  const byHour: TrafficByHour = {};
  for (let hour = 0; hour < 24; hour += 1) {
    const entry: TrafficDirectionalScores = {};
    if (forward !== null) {
      entry.forward = forward;
    }
    if (backward !== null) {
      entry.reverse = backward;
    }
    entry.total = total;
    byHour[hour] = entry;
  }
  return byHour;
}

function buildTrafficByHourFromArrays(forward: number[], backward: number[]): TrafficByHour {
  const byHour: TrafficByHour = {};
  for (let hour = 0; hour < 24; hour += 1) {
    const fRaw = forward[hour];
    const bRaw = backward[hour];
    const hasForward = typeof fRaw === "number" && Number.isFinite(fRaw);
    const hasBackward = typeof bRaw === "number" && Number.isFinite(bRaw);
    if (!hasForward && !hasBackward) {
      continue;
    }
    const entry: TrafficDirectionalScores = {};
    const forwardValue = hasForward ? clampTrafficScore(fRaw) : undefined;
    const backwardValue = hasBackward ? clampTrafficScore(bRaw) : undefined;
    if (forwardValue !== undefined) {
      entry.forward = forwardValue;
    }
    if (backwardValue !== undefined) {
      entry.reverse = backwardValue;
    }
    entry.total = Math.max(forwardValue ?? 0, backwardValue ?? 0);
    byHour[hour] = entry;
  }
  return byHour;
}

function convertWorkerTraffic(traffic: TrafficSimResult["roadTraffic"]): TrafficByRoadId {
  const result: TrafficByRoadId = {};
  Object.entries(traffic).forEach(([roadId, score]) => {
    const byHour = buildTrafficByHourFromArrays(
      score.hourlyScore.forward ?? [],
      score.hourlyScore.backward ?? []
    );
    if (Object.keys(byHour).length === 0) {
      return;
    }
    result[roadId] = buildTrafficByPreset(byHour);
  });
  return result;
}

function buildRoadDwellFactors(
  edgeTraffic: NonNullable<TrafficSimResult["edgeTraffic"]>
): Record<string, number> {
  const totals = new Map<string, { weighted: number; length: number }>();
  for (const edge of edgeTraffic) {
    const length = Number.isFinite(edge.lengthM) ? Math.max(0, edge.lengthM) : 0;
    if (length <= 0) {
      continue;
    }
    const dwell = Number.isFinite(edge.dwellFactor) ? Math.max(1, edge.dwellFactor) : 1;
    const record = totals.get(edge.roadId) ?? { weighted: 0, length: 0 };
    record.weighted += dwell * length;
    record.length += length;
    totals.set(edge.roadId, record);
  }
  const factors: Record<string, number> = {};
  totals.forEach((record, roadId) => {
    if (record.length > 0) {
      factors[roadId] = record.weighted / record.length;
    }
  });
  return factors;
}

function applyDwellFactorsToTrafficByRoadId(
  traffic: TrafficByRoadId,
  dwellByRoadId: Record<string, number>
): TrafficByRoadId {
  const result: TrafficByRoadId = {};
  Object.entries(traffic).forEach(([roadId, byPreset]) => {
    const dwell = dwellByRoadId[roadId];
    if (!Number.isFinite(dwell) || (dwell as number) <= 1) {
      result[roadId] = byPreset;
      return;
    }
    const factor = dwell as number;
    const scaledPreset: TrafficByPreset = {};
    Object.entries(byPreset).forEach(([preset, byHour]) => {
      const scaledHour: TrafficByHour = {};
      Object.entries(byHour).forEach(([hourKey, scores]) => {
        const scaledScores: TrafficDirectionalScores = {};
        const forward = scaleTrafficScore(scores.forward, factor);
        const reverse = scaleTrafficScore(scores.reverse, factor);
        if (forward !== undefined) {
          scaledScores.forward = forward;
        }
        if (reverse !== undefined) {
          scaledScores.reverse = reverse;
        }
        const totalBase =
          typeof scores.total === "number" && Number.isFinite(scores.total)
            ? scaleTrafficScore(scores.total, factor)
            : undefined;
        const inferredTotal = Math.max(forward ?? 0, reverse ?? 0);
        scaledScores.total = totalBase ?? inferredTotal;
        scaledHour[Number(hourKey)] = scaledScores;
      });
      scaledPreset[preset] = scaledHour;
    });
    result[roadId] = scaledPreset;
  });
  return result;
}

function scaleTrafficScore(value: number | undefined, factor: number): number | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(factor)) {
    return undefined;
  }
  return clampTrafficScore((value as number) * factor);
}

function buildTrafficOverlayData(
  trafficBaseByRoadId: TrafficByRoadId | null,
  customRoads: Road[]
): TrafficByRoadId {
  const overlay: TrafficByRoadId = trafficBaseByRoadId ? { ...trafficBaseByRoadId } : {};
  const values: number[] = [];
  for (const road of customRoads) {
    const custom = road.customTraffic;
    if (!custom) {
      continue;
    }
    if (Number.isFinite(custom.forward)) {
      values.push(custom.forward as number);
    }
    if (Number.isFinite(custom.backward)) {
      values.push(custom.backward as number);
    }
  }
  const maxCars = values.length
    ? Math.max(DEFAULT_CUSTOM_TRAFFIC_CAPACITY, ...values)
    : DEFAULT_CUSTOM_TRAFFIC_CAPACITY;
  for (const road of customRoads) {
    const custom = road.customTraffic;
    if (!custom) {
      continue;
    }
    const forwardScore = normalizeTrafficScore(custom.forward, maxCars);
    const backwardScore = normalizeTrafficScore(custom.backward, maxCars);
    if (forwardScore === null && backwardScore === null) {
      continue;
    }
    const byHour = buildTrafficByHourFromScores(forwardScore, backwardScore);
    overlay[road.id] = buildTrafficByPreset(byHour);
  }
  return overlay;
}

function applyTrafficResultsToRoads(
  roads: Road[],
  trafficByRoadId: TrafficSimResult["roadTraffic"],
  dwellByRoadId?: Record<string, number>
): void {
  for (const road of roads) {
    const traffic = trafficByRoadId[road.id];
    if (!traffic) {
      continue;
    }
    const dwell =
      dwellByRoadId && Number.isFinite(dwellByRoadId[road.id]) ? (dwellByRoadId[road.id] as number) : 1;
    const forward = traffic.hourlyScore.forward ?? [];
    const backward = traffic.hourlyScore.backward ?? [];
    const hourlyDirectionalScores: RoadHourlyDirectionalScore[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const forwardValue = Number.isFinite(forward[hour]) ? (forward[hour] as number) : 0;
      const backwardValue = Number.isFinite(backward[hour]) ? (backward[hour] as number) : 0;
      hourlyDirectionalScores.push({
        hour,
        forward: clampTrafficScore(forwardValue * dwell),
        backward: clampTrafficScore(backwardValue * dwell)
      });
    }
    const nextTraffic: RoadTraffic = {
      ...(road.traffic ?? {}),
      hourlyDirectionalScores
    };
    road.traffic = nextTraffic;
  }
}

function formatTrafficMeta(
  meta?: TrafficSimResult["meta"] | null,
  capMessage?: string | null
): string {
  if (!meta) {
    return "Traffic computed.";
  }
  const duration = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : "–";
  const base = `Traffic computed · trips ${meta.trips} · k ${meta.kRoutes} · ${duration}`;
  return capMessage ? `${base} · ${capMessage}` : base;
}

function formatTrafficDetail(detail: number): string {
  const lookup: Record<number, string> = {
    1: "Detail 1 · Low",
    2: "Detail 2 · Light",
    3: "Detail 3 · Balanced",
    4: "Detail 4 · High",
    5: "Detail 5 · Max"
  };
  return lookup[detail] ?? `Detail ${detail}`;
}

function formatTrafficPresetLabel(preset: string): string {
  if (preset === "am") {
    return "Morning Rush";
  }
  if (preset === "pm") {
    return "Afternoon Rush";
  }
  if (preset === "neutral") {
    return "Standard";
  }
  return preset;
}

function formatHour(hour: number): string {
  const clamped = clampInt(hour, 0, 23);
  return clamped.toString().padStart(2, "0");
}

function formatTimestamp(date: Date): string {
  return date.toLocaleString();
}

function formatOptionalNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "";
  }
  return value.toString();
}

function parseOptionalNumber(raw: string): number | null {
  if (!raw.trim()) {
    return null;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeTrafficScore(value: number | null | undefined, maxCars: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  if (maxCars <= 0) {
    return 0;
  }
  return clampTrafficScore((value / maxCars) * 100);
}

function clampTrafficScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function mapPointToLatLon(
  point: MapPoint,
  mapper: GeoMapper | null
): { lat: number; lon: number } | null {
  if ("lat" in point && "lon" in point) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      return null;
    }
    return { lat: point.lat, lon: point.lon };
  }
  if (!mapper || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }
  const { lat, lon } = mapper.pixelToLatLon(point.x, point.y);
  return { lat, lon };
}

const TRAFFIC_ROAD_PRIORITY: Record<string, number> = {
  motorway: 9,
  trunk: 8,
  primary: 7,
  secondary: 6,
  tertiary: 5,
  residential: 4,
  unclassified: 4,
  living_street: 3,
  service: 3,
  motorway_link: 6,
  trunk_link: 6,
  primary_link: 6,
  secondary_link: 5,
  tertiary_link: 4,
  track: 2,
  path: 2,
  cycleway: 2,
  footway: 1,
  pedestrian: 1,
  construction: 1,
  other: 1
};

function pointInGeoBounds(point: { lat: number; lon: number }, bounds: GeoBounds): boolean {
  return (
    point.lat >= bounds.south &&
    point.lat <= bounds.north &&
    point.lon >= bounds.west &&
    point.lon <= bounds.east
  );
}

function estimateTrafficEdgeCount(roads: TrafficSimRequest["roads"]): number {
  let count = 0;
  for (const road of roads) {
    if (!road.points || road.points.length < 2) {
      continue;
    }
    const segments = road.points.length - 1;
    const oneway =
      road.oneway === true || road.oneway === 1 || road.oneway === -1;
    count += segments * (oneway ? 1 : 2);
  }
  return count;
}

function capTrafficRoadsByEdgeCount(
  roads: TrafficSimRequest["roads"],
  frameBounds: GeoBounds,
  maxEdges: number
): {
  roads: TrafficSimRequest["roads"];
  capped: boolean;
  keptEdges: number;
  totalEdges: number;
} {
  const totalEdges = estimateTrafficEdgeCount(roads);
  if (totalEdges <= maxEdges) {
    return { roads, capped: false, keptEdges: totalEdges, totalEdges };
  }

  const ranked = roads.map((road) => {
    const classKey = road.class ?? "other";
    const priority = TRAFFIC_ROAD_PRIORITY[classKey] ?? 4;
    const inFrame = road.points.some((point) => pointInGeoBounds(point, frameBounds));
    const edgeCount = estimateTrafficEdgeCount([road]);
    return { road, priority, inFrame, edgeCount };
  });

  ranked.sort((a, b) => {
    if (a.inFrame !== b.inFrame) {
      return a.inFrame ? -1 : 1;
    }
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return a.road.id.localeCompare(b.road.id);
  });

  const selected: TrafficSimRequest["roads"] = [];
  let keptEdges = 0;
  for (const entry of ranked) {
    if (keptEdges + entry.edgeCount > maxEdges) {
      continue;
    }
    selected.push(entry.road);
    keptEdges += entry.edgeCount;
  }

  return { roads: selected, capped: true, keptEdges, totalEdges };
}

function buildTrafficRoads(
  roads: Road[],
  mapper: GeoMapper | null
): TrafficSimRequest["roads"] | null {
  const trafficRoads: TrafficSimRequest["roads"] = [];
  for (const road of roads) {
    const points: Array<{ lat: number; lon: number }> = [];
    for (const point of road.points) {
      const mapped = mapPointToLatLon(point, mapper);
      if (!mapped) {
        return null;
      }
      points.push(mapped);
    }
    if (points.length < 2) {
      continue;
    }
    const oneway = (road as Road & { oneway?: boolean | -1 }).oneway;
    trafficRoads.push({
      id: road.id,
      points,
      oneway,
      class: road.class,
      lanes: road.lanes,
      lanesForward: road.lanesForward,
      lanesBackward: road.lanesBackward,
      lanesInferred: road.lanesInferred,
      turnLanes: road.turnLanes,
      turnLanesForward: road.turnLanesForward,
      turnLanesBackward: road.turnLanesBackward
    });
  }
  return trafficRoads;
}

function buildTrafficBuildings(
  buildings: Building[],
  mapper: GeoMapper | null
): TrafficSimRequest["buildings"] | null {
  if (!buildings.length) {
    return null;
  }
  const trafficBuildings: NonNullable<TrafficSimRequest["buildings"]> = [];
  for (const building of buildings) {
    const outline: Array<{ lat: number; lon: number }> = [];
    let valid = true;
    for (const point of building.footprint) {
      const mapped = mapPointToLatLon(point, mapper);
      if (!mapped) {
        valid = false;
        break;
      }
      outline.push(mapped);
    }
    if (!valid || outline.length < 3) {
      continue;
    }
    trafficBuildings.push({ id: building.id, outline });
  }
  return trafficBuildings.length ? trafficBuildings : null;
}

function buildTrafficSignals(
  signals: TrafficSignal[],
  mapper: GeoMapper | null
): TrafficSimRequest["trafficSignals"] | undefined {
  if (!signals.length) {
    return undefined;
  }
  const trafficSignals: NonNullable<TrafficSimRequest["trafficSignals"]> = [];
  for (const signal of signals) {
    const mapped = mapPointToLatLon(signal.location, mapper);
    if (!mapped) {
      continue;
    }
    trafficSignals.push({ id: signal.id, location: mapped });
  }
  return trafficSignals.length ? trafficSignals : undefined;
}

function mergeOsmRoads(primary: OsmRoad[], secondary: OsmRoad[]): OsmRoad[] {
  const merged = new Map<string, OsmRoad>();
  for (const road of primary) {
    merged.set(road.id, road);
  }
  for (const road of secondary) {
    if (!merged.has(road.id)) {
      merged.set(road.id, road);
    }
  }
  return Array.from(merged.values());
}

function mergeOsmTrafficSignals(
  primary: OsmTrafficSignal[],
  secondary: OsmTrafficSignal[]
): OsmTrafficSignal[] {
  const merged = new Map<string, OsmTrafficSignal>();
  for (const signal of primary) {
    merged.set(signal.id, signal);
  }
  for (const signal of secondary) {
    if (!merged.has(signal.id)) {
      merged.set(signal.id, signal);
    }
  }
  return Array.from(merged.values());
}

function mapOsmRoadDirection(direction: OsmRoadDirection): RoadDirection {
  if (direction === "forward" || direction === "backward" || direction === "both") {
    return direction;
  }
  return "both";
}

function mapOsmRoad(road: OsmRoad): Road {
  const mapped: Road = {
    id: road.id,
    points: road.points,
    class: road.class,
    lanes: road.lanes,
    lanesForward: road.lanesForward,
    lanesBackward: road.lanesBackward,
    lanesInferred: road.lanesInferred,
    turnLanes: road.turnLanes,
    turnLanesForward: road.turnLanesForward,
    turnLanesBackward: road.turnLanesBackward,
    name: road.name,
    source: "osm",
    showDirectionLine: road.showDirectionLine ?? false
  };
  setRoadDirectionValue(mapped, mapOsmRoadDirection(road.oneway));
  return mapped;
}

function mapOsmBuilding(building: OsmBuilding): Building {
  return {
    id: building.id,
    footprint: building.footprint,
    height: building.heightM,
    tags: building.tags
  };
}

function mapOsmTree(tree: OsmTree): Tree {
  const baseRadiusMeters = Number.isFinite(tree.baseRadiusMeters)
    ? Math.max(0.1, tree.baseRadiusMeters)
    : DEFAULT_TREE_RADIUS_METERS;
  const derivedHeight = deriveTreeHeightMeters(baseRadiusMeters);
  const osmHeight =
    Number.isFinite(tree.heightMeters) && (tree.heightMeters as number) > 0
      ? (tree.heightMeters as number)
      : null;
  const heightMeters = osmHeight ?? derivedHeight;
  const heightSource: TreeHeightSource = osmHeight ? "osm" : "derived";
  const type = tree.type === "pine" || tree.type === "deciduous" ? tree.type : DEFAULT_TREE_TYPE;
  return {
    id: tree.id,
    location: tree.location,
    type,
    baseRadiusMeters,
    heightMeters,
    heightSource
  };
}

function mapOsmSign(sign: OsmSign): Sign {
  const kind = sign.kind === "billboard" || sign.kind === "sign" ? sign.kind : DEFAULT_SIGN_KIND;
  const defaults = DEFAULT_SIGN_DIMENSIONS[kind];
  const heightMeters =
    Number.isFinite(sign.heightMeters) && (sign.heightMeters as number) > 0
      ? (sign.heightMeters as number)
      : defaults.heightMeters;
  const heightSource: SignHeightSource =
    Number.isFinite(sign.heightMeters) && (sign.heightMeters as number) > 0
      ? "osm"
      : "default";
  return {
    id: sign.id,
    location: sign.location,
    kind,
    widthMeters:
      Number.isFinite(sign.widthMeters) && (sign.widthMeters as number) > 0
        ? (sign.widthMeters as number)
        : defaults.widthMeters,
    heightMeters,
    bottomClearanceMeters:
      Number.isFinite(sign.bottomClearanceMeters) && (sign.bottomClearanceMeters as number) >= 0
        ? (sign.bottomClearanceMeters as number)
        : defaults.bottomClearanceMeters,
    yawDegrees:
      Number.isFinite(sign.yawDegrees) ? (sign.yawDegrees as number) : DEFAULT_SIGN_YAW_DEGREES,
    heightSource
  };
}

function mapOsmTrafficSignal(signal: OsmTrafficSignal): TrafficSignal {
  return {
    id: signal.id,
    location: signal.location
  };
}

function resolveRoadDirection(road: Road): RoadDirection {
  const oneway = (road as Road & { oneway?: boolean | -1 }).oneway;
  if (oneway === -1) {
    return "backward";
  }
  if (oneway === true) {
    return "forward";
  }
  if (oneway === false) {
    return "both";
  }
  const rawOneway = (road as unknown as Record<string, unknown>).oneway;
  const normalizedOneway = normalizeRoadDirection(rawOneway);
  if (normalizedOneway) {
    return normalizedOneway;
  }
  const legacy =
    (road as unknown as Record<string, unknown>).oneWay ??
    (road as unknown as Record<string, unknown>).direction;
  const normalized = normalizeRoadDirection(legacy);
  return normalized ?? "both";
}

function setRoadDirectionValue(road: Road, direction: RoadDirection) {
  const target = road as Road & { oneway?: boolean | -1 };
  if (direction === "forward") {
    target.oneway = true;
    return;
  }
  if (direction === "backward") {
    target.oneway = -1;
    return;
  }
  delete target.oneway;
}

function normalizeRoadDirection(value: unknown): RoadDirection | null {
  if (value === "both" || value === "forward" || value === "backward") {
    return value;
  }
  if (value === true || value === "yes" || value === 1 || value === "1") {
    return "forward";
  }
  if (value === "reverse" || value === "-1" || value === -1) {
    return "backward";
  }
  if (value === false || value === "no" || value === 0 || value === "0") {
    return "both";
  }
  return null;
}

function buildRoadDirectionOverrides(roads: Road[]): Record<string, RoadDirection> {
  const overrides: Record<string, RoadDirection> = {};
  roads.forEach((road) => {
    const direction = resolveRoadDirection(road);
    if (direction === "backward") {
      overrides[road.id] = direction;
    }
  });
  return overrides;
}

function applyRoadDirectionOverrides(
  roads: Road[],
  overrides?: Record<string, RoadDirection>
) {
  if (!overrides) {
    return;
  }
  roads.forEach((road) => {
    const direction = overrides[road.id];
    if (direction) {
      setRoadDirectionValue(road, direction);
    }
  });
}

function resolveBasemapMode(
  project: RuntimeProjectState,
  fallback: BasemapMode
): BasemapMode {
  if (project.basemapId) {
    return project.basemapId;
  }
  const mode = project.basemapMode;
  if (mode === "auto-street") {
    return "autoStreet";
  }
  if (mode === "street" || mode === "satellite" || mode === "autoStreet") {
    return mode;
  }
  return fallback;
}

function resolveProjectAutoRoads(project: RuntimeProjectState): Road[] {
  if (Array.isArray(project.autoRoads)) {
    return project.autoRoads;
  }
  if (project.autoData && Array.isArray(project.autoData.roads)) {
    return project.autoData.roads;
  }
  return [];
}

function resolveProjectAutoBuildings(project: RuntimeProjectState): Building[] {
  if (Array.isArray(project.autoBuildings)) {
    return project.autoBuildings;
  }
  if (project.autoData && Array.isArray(project.autoData.buildings)) {
    return project.autoData.buildings;
  }
  return [];
}

function resolveProjectAutoTrees(project: RuntimeProjectState): Tree[] {
  if (Array.isArray(project.autoTrees)) {
    return project.autoTrees;
  }
  if (project.autoData && Array.isArray(project.autoData.trees)) {
    return project.autoData.trees;
  }
  return [];
}

function resolveProjectAutoSigns(project: RuntimeProjectState): Sign[] {
  if (Array.isArray(project.autoSigns)) {
    return project.autoSigns;
  }
  if (project.autoData && Array.isArray(project.autoData.signs)) {
    return project.autoData.signs;
  }
  return [];
}

function resolveProjectAutoTrafficSignals(project: RuntimeProjectState): TrafficSignal[] {
  if (Array.isArray(project.autoTrafficSignals)) {
    return project.autoTrafficSignals;
  }
  if (project.autoData && Array.isArray(project.autoData.trafficSignals)) {
    return project.autoData.trafficSignals;
  }
  return [];
}

function inferRoadMode(autoRoads: Road[], customRoads: Road[]): RoadMode {
  if (customRoads.length > 0 && autoRoads.length === 0) {
    return "custom";
  }
  return "auto";
}

function normalizeRoadMode(value: unknown): RoadMode | null {
  if (value === "auto" || value === "custom") {
    return value;
  }
  return null;
}

function readProjectExtras(payload: unknown): ProjectExtras | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const extras = (payload as Record<string, unknown>)[EXTRA_KEY];
  if (!extras || typeof extras !== "object") {
    return null;
  }
  return extras as ProjectExtras;
}

function getTileSourceIdForBasemap(
  mode: BasemapMode,
  autoStreetSupported: boolean
): TileSourceId {
  if (mode === "autoStreet" && !autoStreetSupported) {
    return "street";
  }
  return mode as TileSourceId;
}

function expandBounds(bounds: GeoBounds, scale: number): GeoBounds {
  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;
  const latMid = (bounds.north + bounds.south) / 2;
  const lonMid = (bounds.east + bounds.west) / 2;
  const halfLat = (latSpan / 2) * scale;
  const halfLon = (lonSpan / 2) * scale;
  return {
    north: clamp(latMid + halfLat, -85, 85),
    south: clamp(latMid - halfLat, -85, 85),
    east: lonMid + halfLon,
    west: lonMid - halfLon
  };
}

function computeSimBounds(bounds: GeoBounds): GeoBounds {
  return expandBoundsByMeters(bounds, SIM_BUFFER_METERS);
}

function createFeatureId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}:${Date.now().toString(36)}:${random}`;
}

function projectLatLonForMl(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const scale = 256 * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function unprojectLatLonForMl(x: number, y: number, zoom: number): { lat: number; lon: number } {
  const scale = 256 * Math.pow(2, zoom);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

function metersPerPixelAtLatForMl(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  const circumference = 2 * Math.PI * 6378137;
  return (Math.cos(latRad) * circumference) / (256 * Math.pow(2, zoom));
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

function capBoundsByMeters(bounds: GeoBounds, maxWidthM: number, maxHeightM: number): GeoBounds {
  const latMid = (bounds.north + bounds.south) / 2;
  const lonMid = (bounds.east + bounds.west) / 2;
  const widthM = haversineMeters(latMid, bounds.west, latMid, bounds.east);
  const heightM = haversineMeters(bounds.north, lonMid, bounds.south, lonMid);
  const widthScale = maxWidthM / Math.max(1, widthM);
  const heightScale = maxHeightM / Math.max(1, heightM);
  const scale = Math.min(1, widthScale, heightScale);
  if (scale >= 1) {
    return bounds;
  }
  return expandBounds(bounds, scale);
}

function screenPointToLatLon(
  bounds: GeoBounds,
  xNorm: number,
  yNorm: number
): { lat: number; lon: number } {
  const west = bounds.west;
  const east = bounds.east;
  const north = bounds.north;
  const south = bounds.south;
  const lon = west + (east - west) * clamp(xNorm, 0, 1);
  const yNorth = mercatorY(north);
  const ySouth = mercatorY(south);
  const y = yNorth + (ySouth - yNorth) * clamp(yNorm, 0, 1);
  const lat = mercatorLat(y);
  return { lat, lon };
}

function mercatorY(lat: number): number {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
}

function mercatorLat(y: number): number {
  return (
    (180 / Math.PI) * (2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2)
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371000 * c;
}

function delayFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function createThrottle<T extends (...args: any[]) => void>(fn: T, delayMs: number): T {
  let lastCall = 0;
  let timeout: number | null = null;
  let pendingArgs: Parameters<T> | null = null;

  const invoke = () => {
    timeout = null;
    lastCall = Date.now();
    if (pendingArgs) {
      fn(...pendingArgs);
      pendingArgs = null;
    }
  };

  return ((...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = delayMs - (now - lastCall);
    pendingArgs = args;
    if (remaining <= 0) {
      if (timeout !== null) {
        window.clearTimeout(timeout);
        timeout = null;
      }
      lastCall = now;
      fn(...args);
      pendingArgs = null;
      return;
    }
    if (timeout === null) {
      timeout = window.setTimeout(invoke, remaining);
    }
  }) as T;
}

function boundsApproxEqual(a: GeoBounds, b: GeoBounds): boolean {
  const epsilon = 0.0001;
  return (
    Math.abs(a.north - b.north) < epsilon &&
    Math.abs(a.south - b.south) < epsilon &&
    Math.abs(a.east - b.east) < epsilon &&
    Math.abs(a.west - b.west) < epsilon
  );
}

function boundsContain(outer: GeoBounds, inner: GeoBounds): boolean {
  return (
    outer.north >= inner.north &&
    outer.south <= inner.south &&
    outer.east >= inner.east &&
    outer.west <= inner.west
  );
}

function loadAutosave(): LoadedProject | null {
  const raw = window.localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const extras = readProjectExtras(parsed) ?? undefined;
    try {
      const { state, warnings } = deserializeProject(parsed);
      if (warnings.length) {
        console.warn("Autosave warnings:", warnings);
      }
      if (state) {
        return { state: state as RuntimeProjectState, extras };
      }
    } catch {
      // fall through to legacy shape.
    }
    if (parsed && parsed.settings && parsed.shapes) {
      const legacyMode = parsed.basemapMode ?? parsed.basemapId ?? "street";
      const basemap =
        legacyMode === "auto-street" ? "autoStreet" : (legacyMode as BasemapMode);
      const fallbackConfig = createDefaultTrafficConfig();
      const fallbackState: RuntimeProjectState = {
        bounds: parsed.bounds ?? null,
        basemapMode: basemap,
        basemapId: basemap,
        settings: parsed.settings as AppSettings,
        shapes: parsed.shapes as Shape[],
        denseCover: Array.isArray(parsed.denseCover) ? (parsed.denseCover as DenseCover[]) : [],
        roadMode: "auto",
        autoData: {
          bounds: null,
          roads: [],
          buildings: [],
          fetchedAt: null,
          endpoint: null
        },
        autoRoads: [],
        autoBuildings: [],
        customRoads: [],
        epicenter: null,
        traffic: {
          config: fallbackConfig,
          data: null
        },
        trafficConfig: fallbackConfig,
        trafficView: buildTrafficViewState(fallbackConfig)
      };
      return {
        state: fallbackState,
        extras
      };
    }
    return null;
  } catch {
    return null;
  }
}

function saveAutosave(payload: Record<string, unknown>): void {
  window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
}

void init().catch((err) => {
  console.error(err);
  const statusMessage = document.getElementById("statusMessage");
  if (statusMessage) {
    statusMessage.textContent = `Fatal error: ${err.message}`;
  }
});

function applyDisplaySettingsToCanvas(
  drawingManager: ReturnType<typeof createDrawingManager>,
  settings: AppSettings
) {
  drawingManager.setZoneVisibility("viewer", settings.overlays.showViewers);
  drawingManager.setZoneVisibility("candidate", settings.overlays.showCandidates);
  drawingManager.setZoneVisibility("obstacle", settings.overlays.showObstacles);
  drawingManager.setShowContours(settings.overlays.showContours);
  drawingManager.setZoneOpacity("viewer", settings.opacity.viewer);
  drawingManager.setZoneOpacity("candidate", settings.opacity.candidate);
  drawingManager.setZoneOpacity("obstacle", settings.opacity.obstacle);
  drawingManager.setHeatmapOpacity(settings.opacity.heatmap);
  drawingManager.setShadingOpacity(settings.opacity.shading);
  drawingManager.setContourOpacity(settings.opacity.contours);
  drawingManager.setDenseCoverDensity(settings.denseCoverDensity);
}

function buildPassSteps(
  finalStep: number,
  image: { width_px: number; height_px: number }
): number[] {
  const target = Math.max(1, Math.floor(finalStep));
  const maxDimension = Math.max(image.width_px, image.height_px);
  const steps: number[] = [];
  let current = maxDimension;
  if (current < target) {
    current = target;
  }
  while (current > target) {
    steps.push(current);
    current = Math.max(Math.floor(current / 2), target);
    if (steps.length > 32) {
      break;
    }
  }
  if (!steps.length || steps[steps.length - 1] !== target) {
    steps.push(target);
  }
  return steps;
}

function withSampleResolution(base: AppSettings, step: number): AppSettings {
  return {
    ...base,
    sampleStepPx: Math.max(1, Math.floor(step))
  };
}
