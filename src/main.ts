import { createDrawingManager, ToolMode } from "./drawing";
import {
  AppSettings,
  Building,
  GeoBounds,
  MapPoint,
  ProjectState,
  Road,
  RoadHourlyDirectionalScore,
  RoadTraffic,
  Shape,
  TrafficByHour,
  TrafficByPreset,
  TrafficByRoadId,
  TrafficConfig,
  TrafficDirectionalScores,
  TrafficViewState
} from "./types";
import { createGeoReference, GeoMapper } from "./geo";
import {
  computeVisibilityHeatmap,
  computeShadingOverlay,
  sampleCandidatePoints,
  sampleMapGridPoints,
  sampleViewerPoints
} from "./visibility";
import { generateContourSegments } from "./contours";
import { getTileSource, TileSourceId, TILE_SOURCES, renderMapFrameImage } from "./mapTiles";
import { createMapView } from "./mapView";
import { fetchElevationGrid } from "./topography";
import { fetchOsmRoadsAndBuildings } from "./osm/overpass";
import { deserializeProject, RuntimeProjectState, serializeProject } from "./project";
import type {
  Building as OsmBuilding,
  Road as OsmRoad,
  RoadDirection as OsmRoadDirection
} from "./osm/types";
import type {
  TrafficSimProgress,
  TrafficSimRequest,
  TrafficSimResult
} from "./traffic/types";

type MapViewInstance = ReturnType<typeof createMapView>;
type BasemapMode = TileSourceId;
type RoadMode = "auto" | "custom";
type RoadDirection = "both" | "forward" | "backward";
type TrafficPreset = "am" | "pm" | "neutral" | "hourly";
type TrafficPresetKey = "am" | "pm" | "neutral";
type LegacyTrafficByRoadId = Record<string, { forward: number; backward: number }>;

interface TrafficConfig {
  preset: TrafficPreset;
  hour: number;
  detail: number;
  showOverlay: boolean;
  showDirectionArrows: boolean;
  seed: number;
}

interface AutoDataState {
  bounds: GeoBounds | null;
  roads: Road[];
  buildings: Building[];
  fetchedAt: string | null;
  endpoint: string | null;
  counts?: { roads: number; buildings: number } | null;
}

type TrafficConfigInput = Partial<{
  preset: string;
  hour: number;
  detail: number;
  showOverlay: boolean;
  showDirectionArrows: boolean;
  seed: number;
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
    counts?: { roads: number; buildings: number } | null;
  };
  epicenter?: EpicenterState | null;
  roadDirections?: Record<string, RoadDirection>;
  trafficMeta?: TrafficSimResult["meta"] | null;
}

type LoadedProject = { state: RuntimeProjectState; extras?: ProjectExtras };

const AUTOSAVE_KEY = "visopti-autosave-v1";
const DEFAULT_CUSTOM_TRAFFIC_CAPACITY = 1200;
const EXTRA_KEY = "__visopti";

async function init() {
  const canvas = document.getElementById("mainCanvas") as HTMLCanvasElement | null;
  const statusOverlay = document.getElementById("statusOverlay");
  const statusMessage = document.getElementById("statusMessage");
  const addressForm = document.getElementById("addressForm") as HTMLFormElement | null;
  const addressInput = document.getElementById("addressInput") as HTMLInputElement | null;
  const addressGo = document.getElementById("addressGo") as HTMLButtonElement | null;
  const warningBanner = document.getElementById("warningBanner");
  const mapContainer = document.getElementById("mapView") as HTMLDivElement | null;
  const mapStatus = document.getElementById("mapStatus");
  const btnLockFrame = document.getElementById("btnLockFrame") as HTMLButtonElement | null;
  const btnLoadTopography = document.getElementById("btnLoadTopography") as HTMLButtonElement | null;
  const basemapStyle = document.getElementById("basemapStyle") as HTMLSelectElement | null;
  const basemapWarning = document.getElementById("basemapWarning");
  const modeAuto = document.getElementById("modeAuto") as HTMLInputElement | null;
  const modeCustom = document.getElementById("modeCustom") as HTMLInputElement | null;
  const btnAutoPopulate = document.getElementById("btnAutoPopulate") as HTMLButtonElement | null;
  const btnRefreshAuto = document.getElementById("btnRefreshAuto") as HTMLButtonElement | null;
  const autoDataStatus = document.getElementById("autoDataStatus");
  const btnPickEpicenter = document.getElementById("btnPickEpicenter") as HTMLButtonElement | null;
  const epicenterRadius = document.getElementById("epicenterRadius") as HTMLInputElement | null;
  const epicenterRadiusValue = document.getElementById("epicenterRadiusValue");
  const epicenterStatus = document.getElementById("epicenterStatus");
  const trafficPreset = document.getElementById("trafficPreset") as HTMLSelectElement | null;
  const trafficHourRow = document.getElementById("trafficHourRow");
  const trafficHour = document.getElementById("trafficHour") as HTMLInputElement | null;
  const trafficHourValue = document.getElementById("trafficHourValue");
  const trafficDetail = document.getElementById("trafficDetail") as HTMLInputElement | null;
  const trafficDetailValue = document.getElementById("trafficDetailValue");
  const btnComputeTraffic = document.getElementById("btnComputeTraffic") as HTMLButtonElement | null;
  const toggleTrafficOverlay = document.getElementById("toggleTrafficOverlay") as HTMLInputElement | null;
  const toggleDirectionArrows = document.getElementById("toggleDirectionArrows") as HTMLInputElement | null;
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
  if (!canvas || !statusOverlay || !statusMessage) {
    throw new Error("Missing core DOM elements");
  }
  if (!addressForm || !addressInput || !addressGo) {
    throw new Error("Address controls missing from DOM");
  }
  if (!mapContainer || !mapStatus || !btnLockFrame || !btnLoadTopography || !basemapStyle) {
    throw new Error("Map controls missing from DOM");
  }
  if (
    !modeAuto ||
    !modeCustom ||
    !btnAutoPopulate ||
    !btnRefreshAuto ||
    !autoDataStatus ||
    !btnPickEpicenter ||
    !epicenterRadius ||
    !epicenterRadiusValue ||
    !epicenterStatus ||
    !trafficPreset ||
    !trafficHourRow ||
    !trafficHour ||
    !trafficHourValue ||
    !trafficDetail ||
    !trafficDetailValue ||
    !btnComputeTraffic ||
    !toggleTrafficOverlay ||
    !toggleDirectionArrows ||
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

  const statusOverlayEl = statusOverlay;
  const statusMessageEl = statusMessage;
  const addressFormEl = addressForm;
  const addressInputEl = addressInput;
  const addressGoEl = addressGo;
  const warningBannerEl = warningBanner;
  const mapStatusEl = mapStatus;
  const basemapStyleEl = basemapStyle;
  const basemapWarningEl = basemapWarning;
  const modeAutoEl = modeAuto;
  const modeCustomEl = modeCustom;
  const btnAutoPopulateEl = btnAutoPopulate;
  const btnRefreshAutoEl = btnRefreshAuto;
  const autoDataStatusEl = autoDataStatus;
  const btnPickEpicenterEl = btnPickEpicenter;
  const epicenterRadiusEl = epicenterRadius;
  const epicenterRadiusValueEl = epicenterRadiusValue;
  const epicenterStatusEl = epicenterStatus;
  const trafficPresetEl = trafficPreset;
  const trafficHourRowEl = trafficHourRow;
  const trafficHourEl = trafficHour;
  const trafficHourValueEl = trafficHourValue;
  const trafficDetailEl = trafficDetail;
  const trafficDetailValueEl = trafficDetailValue;
  const btnComputeTrafficEl = btnComputeTraffic;
  const toggleTrafficOverlayEl = toggleTrafficOverlay;
  const toggleDirectionArrowsEl = toggleDirectionArrows;
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

  const placeholderImage = createPlaceholderCanvas(1200, 800);

  const settings = createDefaultSettings();
  let roadMode: RoadMode = "auto";
  let autoData: AutoDataState = {
    bounds: null,
    roads: [],
    buildings: [],
    fetchedAt: null,
    endpoint: null,
    counts: null
  };
  let customRoads: Road[] = [];
  let selectedRoadId: string | null = null;
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
  let trafficWorker: Worker | null = null;
  let trafficInFlight = false;
  let trafficRunId = 0;
  let activeTrafficRunId = 0;
  let autoFetchController: AbortController | null = null;
  let geocodeController: AbortController | null = null;
  let lastPointer: { x: number; y: number } | null = null;
  let pendingInterrupt: () => void = () => {};
  let mapper: GeoMapper | null = null;
  let currentBounds: GeoBounds | null = null;
  let frameLocked = false;
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
    onRoadSelectionChanged: (roadId: string | null) => setSelectedRoadId(roadId)
  });
  drawingManager.setRoadDirectionOverlayEnabled(true);

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
      text += `\nTerrain: ${elevation.toFixed(1)} m`;
    } else {
      lastPointer = null;
      text += "\nPixel: (–, –)";
    }
    statusOverlayEl.textContent = text;
  }

  function shapeChangeHandler(shapes: Shape[]) {
    statusMessageEl.textContent = `Shapes: ${shapes.length}`;
    scheduleAutosave();
    pendingInterrupt();
  }

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
  }

  function updateRoadControlsState() {
    btnAddRoadEl.disabled = roadMode !== "custom";
    btnAutoPopulateEl.disabled = !frameLocked || roadMode !== "auto";
    btnRefreshAutoEl.disabled = !frameLocked || roadMode !== "auto";
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
    if (
      !autoData.fetchedAt &&
      autoData.roads.length === 0 &&
      autoData.buildings.length === 0
    ) {
      autoDataStatusEl.textContent = "No auto data yet.";
      return;
    }
    const roadCount = autoData.counts?.roads ?? autoData.roads.length;
    const buildingCount = autoData.counts?.buildings ?? autoData.buildings.length;
    const fetchedLabel = autoData.fetchedAt ?? "Imported";
    const endpointLabel = autoData.endpoint ? ` · ${autoData.endpoint}` : "";
    autoDataStatusEl.textContent =
      `Roads ${roadCount} · Buildings ${buildingCount} · ${fetchedLabel}${endpointLabel}`;
  }

  function updateEpicenterUI() {
    epicenterRadiusValueEl.textContent = `${Math.round(epicenterRadiusM)} m`;
    if (epicenter) {
      epicenter = { ...epicenter, radiusM: epicenterRadiusM };
      epicenterStatusEl.textContent = `${epicenter.lat.toFixed(5)}, ${epicenter.lon.toFixed(5)}`;
    } else {
      epicenterStatusEl.textContent = "No epicenter set";
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
    epicenter = { lat, lon, radiusM: radius };
  }

  function updateTrafficUI() {
    trafficPresetEl.value = trafficConfig.preset;
    trafficHourEl.value = trafficConfig.hour.toString();
    trafficDetailEl.value = trafficConfig.detail.toString();
    trafficDetailValueEl.textContent = formatTrafficDetail(trafficConfig.detail);
    const isHourly = trafficConfig.preset === "hourly";
    trafficHourRowEl.classList.toggle("hidden", !isHourly);
    trafficHourValueEl.classList.toggle("hidden", !isHourly);
    if (isHourly) {
      trafficHourValueEl.textContent = `${formatHour(trafficConfig.hour)}:00`;
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
  }

  function applyTrafficData() {
    trafficOverlayByRoadId = buildTrafficOverlayData(trafficBaseByRoadId, customRoads);
    applyTrafficViewState();
    applyTrafficVisibility();
  }

  function setEpicenterFromLatLon(lat: number, lon: number) {
    epicenter = { lat, lon, radiusM: epicenterRadiusM };
    pendingEpicenterPick = false;
    updateEpicenterUI();
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
  }

  function setRoadToolMode(mode: "off" | "edit") {
    drawingManager.setRoadToolMode(mode);
  }

  async function fetchAutoData(reason: "manual" | "refresh" | "lock") {
    if (!frameLocked) {
      statusMessageEl.textContent = "Lock the map frame before auto-populating.";
      return;
    }
    const bounds = currentBounds ?? mapView.getBounds();
    if (!bounds) {
      statusMessageEl.textContent = "Map bounds unavailable.";
      return;
    }
    if (autoFetchController) {
      autoFetchController.abort();
    }
    const controller = new AbortController();
    autoFetchController = controller;
    btnAutoPopulateEl.disabled = true;
    btnRefreshAutoEl.disabled = true;
    statusMessageEl.textContent =
      reason === "refresh" ? "Refreshing roads and buildings…" : "Fetching roads and buildings…";
    try {
      const expandedBounds = expandBounds(bounds, 3);
      const result = await fetchOsmRoadsAndBuildings(expandedBounds, {
        signal: controller.signal
      });
      const roads = result.roads.map((road) => mapOsmRoad(road));
      const buildings = result.buildings.map((building) => mapOsmBuilding(building));
      autoData = {
        bounds: expandedBounds,
        roads,
        buildings,
        fetchedAt: formatTimestamp(new Date(result.meta.fetchedAtIso)),
        endpoint: result.meta.endpoint,
        counts: {
          roads: result.meta.counts.roads,
          buildings: result.meta.counts.buildings
        }
      };
      updateAutoDataStatus();
      applyRoadMode();
      trafficBaseByRoadId = null;
      trafficOverlayByRoadId = {};
      trafficMeta = null;
      applyTrafficData();
      setTrafficStatus("Traffic cleared. Recompute for updated roads.");
      statusMessageEl.textContent = "Auto data loaded.";
      scheduleAutosave();
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      console.error(err);
      statusMessageEl.textContent = `Auto data load failed: ${(err as Error).message}`;
    } finally {
      autoFetchController = null;
      updateRoadControlsState();
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
        trafficProgressLabelEl.textContent = `Simulating ${progress.phase}…`;
      }
      return;
    }
    if (type === "error") {
      trafficInFlight = false;
      activeTrafficRunId = 0;
      btnComputeTrafficEl.disabled = false;
      hideTrafficProgress();
      setTrafficStatus(
        typeof data.message === "string" ? data.message : "Traffic simulation failed."
      );
      return;
    }
    if (type === "result" || type === "complete" || type === "done") {
      trafficInFlight = false;
      activeTrafficRunId = 0;
      btnComputeTrafficEl.disabled = false;
      hideTrafficProgress();
      const payload = data as {
        trafficByRoadId?: TrafficSimResult["roadTraffic"];
        meta?: TrafficSimResult["meta"];
      };
      if (payload.trafficByRoadId) {
        trafficBaseByRoadId = convertWorkerTraffic(payload.trafficByRoadId);
        trafficMeta = payload.meta ?? null;
        applyTrafficResultsToRoads(getActiveRoads(), payload.trafficByRoadId);
        applyTrafficData();
        setTrafficStatus(formatTrafficMeta(payload.meta));
      } else {
        setTrafficStatus("Traffic computed.");
      }
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
        trafficInFlight = false;
        activeTrafficRunId = 0;
        btnComputeTrafficEl.disabled = false;
        hideTrafficProgress();
        setTrafficStatus("Traffic worker error.");
      });
      return trafficWorker;
    } catch (err) {
      console.error(err);
      setTrafficStatus("Traffic worker unavailable.");
      return null;
    }
  }

  function requestTrafficCompute() {
    if (trafficInFlight) return;
    const roads = getActiveRoads();
    if (!roads.length) {
      statusMessageEl.textContent = "Add or fetch roads before computing traffic.";
      return;
    }
    const bounds = currentBounds ?? mapView.getBounds();
    if (!bounds) {
      statusMessageEl.textContent = "Map bounds unavailable for traffic.";
      return;
    }
    const trafficRoads = buildTrafficRoads(roads, mapper);
    if (!trafficRoads) {
      statusMessageEl.textContent = "Load topography before simulating custom roads.";
      return;
    }
    const trafficBuildings = buildTrafficBuildings(autoData.buildings, mapper);
    const worker = ensureTrafficWorker();
    if (!worker) {
      return;
    }
    trafficInFlight = true;
    trafficRunId += 1;
    activeTrafficRunId = trafficRunId;
    btnComputeTrafficEl.disabled = true;
    showTrafficProgress("Simulating traffic…");
    trafficConfig.seed = Math.floor(Math.random() * 1_000_000);
    const epicenterPoint = epicenter ?? {
      lat: (bounds.north + bounds.south) / 2,
      lon: (bounds.east + bounds.west) / 2,
      radiusM: epicenterRadiusM
    };
    const request: TrafficSimRequest = {
      roads: trafficRoads,
      buildings: trafficBuildings ?? undefined,
      bounds,
      config: {
        epicenter: { lat: epicenterPoint.lat, lon: epicenterPoint.lon },
        epicenterRadiusM: epicenterRadiusM
      },
      presets: ["am", "pm", "neutral"],
      detailLevel: trafficConfig.detail,
      seed: trafficConfig.seed
    };
    worker.postMessage({ type: "run", payload: request, runId: activeTrafficRunId });
  }

  let pendingShapeRestore: { bounds: GeoBounds | null; shapes: Shape[] } | null = null;

  function buildProjectState(): RuntimeProjectState {
    return {
      bounds: currentBounds,
      basemapMode,
      basemapId: basemapMode,
      settings: { ...settings },
      shapes: drawingManager.getShapes(),
      roadMode,
      autoData: {
        bounds: autoData.bounds,
        roads: autoData.roads,
        buildings: autoData.buildings,
        fetchedAt: autoData.fetchedAt,
        endpoint: autoData.endpoint
      },
      autoRoads: autoData.roads,
      autoBuildings: autoData.buildings,
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
      epicenter: epicenter ? { ...epicenter } : null,
      roadDirections: buildRoadDirectionOverrides([...autoData.roads, ...customRoads]),
      trafficMeta
    };
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
    if (typeof config.preset === "string") {
      trafficConfig.preset = normalizeTrafficPreset(config.preset);
    }
    if (typeof config.hour === "number") {
      trafficConfig.hour = clampInt(config.hour, 0, 23);
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
    if (typeof config.seed === "number") {
      trafficConfig.seed = config.seed;
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
    refreshSettingInputs(settings);
    applyDisplaySettingsToCanvas(drawingManager, settings);
    applyBasemapMode(resolveBasemapMode(project, basemapMode), { warn: false });
    if (project.bounds) {
      mapView.setBounds(project.bounds);
    }
    const nextAutoRoads = resolveProjectAutoRoads(project);
    const nextAutoBuildings = resolveProjectAutoBuildings(project);
    autoData = {
      bounds: extras?.autoData?.bounds ?? project.autoData?.bounds ?? project.bounds ?? null,
      roads: nextAutoRoads.map((road) => ({ ...road, source: road.source ?? "osm" })),
      buildings: nextAutoBuildings,
      fetchedAt: extras?.autoData?.fetchedAt ?? project.autoData?.fetchedAt ?? null,
      endpoint: extras?.autoData?.endpoint ?? project.autoData?.endpoint ?? null,
      counts: extras?.autoData?.counts ?? null
    };
    customRoads = (project.customRoads ?? []).map((road) => ({
      ...road,
      source: road.source ?? "custom"
    }));
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
    applyTrafficConfig(project.traffic?.config ?? project.trafficConfig ?? {});
    trafficView = normalizeTrafficView(project.trafficView, trafficConfig);
    trafficConfig.hour = trafficView.hour;
    trafficConfig.showDirectionArrows = trafficView.showDirection;
    trafficBaseByRoadId = expandTrafficPresets(project.traffic?.data ?? null);
    trafficMeta = extras?.trafficMeta ?? null;
    updateAutoDataStatus();
    updateEpicenterUI();
    updateTrafficUI();
    applyRoadMode();
    applyTrafficData();
    queueShapeRestore(project.bounds ?? null, project.shapes ?? []);
    updateRoadProperties();
  }

  setupTools(drawingManager, () => updateStatusOverlay(null));
  setupSettings(settings, drawingManager, {
    interruptComputations: () => pendingInterrupt(),
    onSettingsChanged: () => scheduleAutosave()
  });

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
    }
  });

  trafficPresetEl.addEventListener("change", () => {
    const preset = trafficPresetEl.value as TrafficPreset;
    trafficConfig.preset = preset;
    if (preset !== "hourly") {
      trafficConfig.hour = presetDefaultHour(preset);
    }
    updateTrafficUI();
    applyTrafficViewState();
    scheduleAutosave();
  });
  trafficHourEl.addEventListener("input", () => {
    trafficConfig.hour = clampInt(Number.parseInt(trafficHourEl.value, 10), 0, 23);
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
  btnComputeTrafficEl.addEventListener("click", () => {
    requestTrafficCompute();
  });
  btnCancelTrafficEl.addEventListener("click", () => {
    if (!trafficInFlight) {
      return;
    }
    if (trafficWorker) {
      trafficWorker.postMessage({ type: "cancel", runId: activeTrafficRunId });
    }
    trafficInFlight = false;
    activeTrafficRunId = 0;
    btnComputeTrafficEl.disabled = false;
    hideTrafficProgress();
    setTrafficStatus("Traffic simulation canceled.");
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

  const actionControls = setupActions(drawingManager, settings, () => mapper, statusMessageEl, {
    onShadingComplete: () => {},
    buildProjectState,
    buildProjectPayload,
    applyProjectState,
    scheduleAutosave
  });
  setupDebugProbe(canvas, () => mapper, () => lastPointer);
  pendingInterrupt = () => {
    actionControls.cancelHeatmap();
  };
  drawingManager.setContours(null);
  drawingManager.setContourOpacity(settings.opacity.contours);
  drawingManager.setShowContours(settings.overlays.showContours);
  actionControls.setTopographyReady(false);

  updateStatusOverlay(null);

  const updateFrameStatus = () => {
    if (frameLocked && currentBounds) {
      mapStatusEl.textContent = `Frame locked: N ${currentBounds.north.toFixed(4)} · S ${currentBounds.south.toFixed(4)} · W ${currentBounds.west.toFixed(4)} · E ${currentBounds.east.toFixed(4)}`;
    } else {
      mapStatusEl.textContent = "Frame unlocked: pan/zoom to set a new reference.";
    }
  };

  const unlockFrameForSearch = () => {
    if (!frameLocked) {
      return;
    }
    frameLocked = false;
    mapView.setLocked(false);
    btnLockFrame.textContent = "Lock frame";
    updateFrameStatus();
    updateRoadControlsState();
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
    addressGoEl.disabled = true;
    statusMessageEl.textContent = "Searching address…";
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
      addressGoEl.disabled = false;
    }
  };

  addressFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = addressInputEl.value.trim();
    if (!query) {
      statusMessageEl.textContent = "Enter an address to search.";
      return;
    }
    void runAddressSearch(query);
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
    const bounds = mapView.getBounds();
    const { frame, gridRows, gridCols } = buildMapFrame(mapView, bounds, settings);
    statusMessageEl.textContent = "Fetching map tiles and terrain…";
    statusOverlayEl.textContent = "Loading map tiles…";
    setWarning(null);
    const tileId = getTileSourceIdForBasemap(basemapMode, autoStreetSupported);
    const tileSource = getTileSource(tileId);
    try {
      const [mapImage, elevationGrid] = await Promise.all([
        renderMapFrameImage(frame, tileSource, { basemapMode: tileId }),
        fetchElevationGrid(bounds, gridRows, gridCols),
      ]);
      const geo = createGeoReference(bounds, { width: frame.width, height: frame.height });
      mapper = new GeoMapper(geo, elevationGrid);
      drawingManager.setGeoMapper(mapper);
      const frameChanged = !currentBounds || !boundsApproxEqual(currentBounds, bounds);
      currentBounds = bounds;
      applyEpicenterDefaults(bounds);
      drawingManager.setBaseImage(mapImage, { resetView: true });
      if (frameChanged) {
        drawingManager.clearShapes();
        drawingManager.clearHeatmap();
        drawingManager.setShading(null, Math.max(2, Math.floor(settings.sampleStepPx)));
      }
      drawingManager.setContours(generateContourSegments(mapper, 1));
      actionControls.setTopographyReady(true);
      applyRoadMode();
      applyTrafficData();
      updateEpicenterUI();
      statusMessageEl.textContent = "Topography loaded.";
      if (
        pendingShapeRestore &&
        pendingShapeRestore.bounds &&
        boundsApproxEqual(pendingShapeRestore.bounds, bounds) &&
        drawingManager.getShapes().length === 0
      ) {
        drawingManager.setShapes(pendingShapeRestore.shapes);
        pendingShapeRestore = null;
        statusMessageEl.textContent = "Topography loaded (project restored).";
      }
      scheduleAutosave();
    } catch (err) {
      console.error(err);
      statusMessageEl.textContent = `Topography load failed: ${(err as Error).message}`;
      setWarning("Unable to load map tiles or elevation data. Check your network and try again.");
    } finally {
      updateStatusOverlay(null);
      updateFrameStatus();
    }
  };

  btnLockFrame.addEventListener("click", async () => {
    frameLocked = !frameLocked;
    mapView.setLocked(frameLocked);
    btnLockFrame.textContent = frameLocked ? "Unlock frame" : "Lock frame";
    updateFrameStatus();
    if (frameLocked) {
      await refreshTopography();
      if (roadMode === "auto") {
        await fetchAutoData("lock");
      }
    }
    updateRoadControlsState();
  });

  btnLoadTopography.addEventListener("click", async () => {
    await refreshTopography();
  });

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
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.tool as ToolMode;
      drawingManager.setTool(tool);
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      onToolChange();
    });
  });
}

function setupSettings(
  settings: AppSettings,
  drawingManager: ReturnType<typeof createDrawingManager>,
  hooks?: { interruptComputations?: () => void; onSettingsChanged?: () => void }
) {
  const siteHeight = document.getElementById("siteHeight") as HTMLInputElement | null;
  const viewerHeight = document.getElementById("viewerHeight") as HTMLInputElement | null;
  const topoSpacing = document.getElementById("topoSpacing") as HTMLInputElement | null;
  const sampleStep = document.getElementById("sampleStep") as HTMLInputElement | null;
  const toggleViewers = document.getElementById("toggleViewers") as HTMLInputElement | null;
  const toggleCandidates = document.getElementById("toggleCandidates") as HTMLInputElement | null;
  const toggleObstacles = document.getElementById("toggleObstacles") as HTMLInputElement | null;
  const toggleContours = document.getElementById("toggleContours") as HTMLInputElement | null;
  const viewerOpacityInput = document.getElementById("viewerOpacity") as HTMLInputElement | null;
  const candidateOpacityInput = document.getElementById("candidateOpacity") as HTMLInputElement | null;
  const obstacleOpacityInput = document.getElementById("obstacleOpacity") as HTMLInputElement | null;
  const heatmapOpacityInput = document.getElementById("heatmapOpacity") as HTMLInputElement | null;
  const shadingOpacityInput = document.getElementById("shadingOpacity") as HTMLInputElement | null;
  const contourOpacityInput = document.getElementById("contourOpacity") as HTMLInputElement | null;

  if (
    !siteHeight ||
    !viewerHeight ||
    !topoSpacing ||
    !sampleStep ||
    !toggleViewers ||
    !toggleCandidates ||
    !toggleObstacles ||
    !toggleContours ||
    !viewerOpacityInput ||
    !candidateOpacityInput ||
    !obstacleOpacityInput ||
    !heatmapOpacityInput ||
    !shadingOpacityInput ||
    !contourOpacityInput
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
    settings.topoSpacingFt = Math.max(5, ensureNumber(topoSpacing, settings.topoSpacingFt));
    settings.sampleStepPx = Math.max(1, ensureNumber(sampleStep, settings.sampleStepPx));
    hooks?.interruptComputations?.();
    hooks?.onSettingsChanged?.();
  };

  [siteHeight, viewerHeight, topoSpacing, sampleStep].forEach((input) => {
    input.addEventListener("input", updateSettings);
  });

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

  const parseAlpha = (input: HTMLInputElement, fallback: number) => {
    const value = Number.parseFloat(input.value);
    return Number.isFinite(value) ? value : fallback;
  };

  const updateOpacity = () => {
    settings.opacity.viewer = parseAlpha(viewerOpacityInput, settings.opacity.viewer);
    settings.opacity.candidate = parseAlpha(candidateOpacityInput, settings.opacity.candidate);
    settings.opacity.obstacle = parseAlpha(obstacleOpacityInput, settings.opacity.obstacle);
    settings.opacity.heatmap = parseAlpha(heatmapOpacityInput, settings.opacity.heatmap);
    settings.opacity.shading = parseAlpha(shadingOpacityInput, settings.opacity.shading);
    settings.opacity.contours = parseAlpha(contourOpacityInput, settings.opacity.contours);
    drawingManager.setZoneOpacity("viewer", settings.opacity.viewer);
    drawingManager.setZoneOpacity("candidate", settings.opacity.candidate);
    drawingManager.setZoneOpacity("obstacle", settings.opacity.obstacle);
    drawingManager.setHeatmapOpacity(settings.opacity.heatmap);
    drawingManager.setShadingOpacity(settings.opacity.shading);
    drawingManager.setContourOpacity(settings.opacity.contours);
    hooks?.interruptComputations?.();
  };

  [
    viewerOpacityInput,
    candidateOpacityInput,
    obstacleOpacityInput,
    heatmapOpacityInput,
    shadingOpacityInput,
    contourOpacityInput
  ].forEach((input) => input.addEventListener("input", updateOpacity));

  updateSettings();
  updateOverlayState();
  updateOpacity();
  applyDisplaySettingsToCanvas(drawingManager, settings);
}

function setupActions(
  drawingManager: ReturnType<typeof createDrawingManager>,
  settings: AppSettings,
  getMapper: () => GeoMapper | null,
  statusMessage: HTMLElement,
  hooks?: {
    onShadingComplete?: () => void;
    buildProjectState?: () => RuntimeProjectState;
    buildProjectPayload?: () => Record<string, unknown>;
    applyProjectState?: (project: RuntimeProjectState, extras?: ProjectExtras) => void;
    scheduleAutosave?: () => void;
  }
): { cancelHeatmap: () => void; setTopographyReady: (ready: boolean) => void } {
  let heatmapComputeToken = 0;
  let topographyReady = false;
  const btnCompute = document.getElementById("btnComputeHeatmap") as HTMLButtonElement | null;
  const btnComputeShade = document.getElementById("btnComputeShading") as HTMLButtonElement | null;
  const btnClearHeatmap = document.getElementById("btnClearHeatmap") as HTMLButtonElement | null;
  const btnClearShading = document.getElementById("btnClearShading") as HTMLButtonElement | null;
  const btnClearShapes = document.getElementById("btnClearShapes") as HTMLButtonElement | null;
  const btnExport = document.getElementById("btnExportProject") as HTMLButtonElement | null;
  const importInput = document.getElementById("importFile") as HTMLInputElement | null;
  const btnExportShapes = document.getElementById("btnExportShapes") as HTMLButtonElement | null;
  const importShapesInput = document.getElementById("importShapesFile") as HTMLInputElement | null;
  const progressContainer = document.getElementById("progressContainer") as HTMLElement | null;
  const progressBar = document.getElementById("computeProgress") as HTMLProgressElement | null;
  const progressLabel = document.getElementById("progressLabel") as HTMLElement | null;

  if (
    !btnCompute ||
    !btnComputeShade ||
    !btnClearHeatmap ||
    !btnClearShading ||
    !btnClearShapes ||
    !btnExport ||
    !importInput ||
    !btnExportShapes ||
    !importShapesInput ||
    !progressContainer ||
    !progressBar ||
    !progressLabel
  ) {
    throw new Error("Control buttons missing from DOM");
  }

  const showProgress = (label: string) => {
    progressLabel.textContent = label;
    progressBar.value = 0;
    progressContainer.classList.remove("hidden");
  };
  const updateProgress = (value: number) => {
    progressBar.value = Math.min(1, Math.max(0, value));
  };
  const hideProgress = () => {
    progressContainer.classList.add("hidden");
  };

  const cancelHeatmap = () => {
    heatmapComputeToken += 1;
    hideProgress();
    btnCompute.disabled = !topographyReady;
  };

  btnCompute.addEventListener("click", async () => {
    const mapper = getMapper();
    if (!mapper) {
      statusMessage.textContent = "Load topography before computing visibility.";
      return;
    }
    btnCompute.disabled = true;
    showProgress("Computing heatmap…");
    statusMessage.textContent = "Computing visibility heatmap…";
    await delayFrame();
    try {
      heatmapComputeToken += 1;
      const token = heatmapComputeToken;
      const shapes = drawingManager.getShapes();
      const passSteps = buildPassSteps(Math.max(1, settings.sampleStepPx), mapper.geo.image);
      const obstaclesSnapshot = shapes.filter((shape) => shape.type === "obstacle");

      for (let i = 0; i < passSteps.length; i += 1) {
        if (token !== heatmapComputeToken) {
          hideProgress();
          btnCompute.disabled = !topographyReady;
          return;
        }
        const step = passSteps[i];
        const tempSettings = withSampleResolution(settings, step);
        const viewers = sampleViewerPoints(shapes, tempSettings, mapper);
        const candidates = sampleCandidatePoints(shapes, tempSettings, mapper);
        if (viewers.length === 0 || candidates.length === 0) {
          statusMessage.textContent = "Need viewer and candidate zones to compute heatmap.";
          drawingManager.clearHeatmap();
          drawingManager.setShading(null, step);
          hideProgress();
          btnCompute.disabled = !topographyReady;
          return;
        }
        const heatmap = computeVisibilityHeatmap(
          viewers,
          candidates,
          obstaclesSnapshot,
          tempSettings,
          mapper
        );
        if (token !== heatmapComputeToken) {
          hideProgress();
          btnCompute.disabled = !topographyReady;
          return;
        }
        drawingManager.setHeatmap(heatmap, Math.max(1, tempSettings.sampleStepPx));
        progressLabel.textContent = `Computing heatmap (pass ${i + 1}/${passSteps.length})…`;
        updateProgress((i + 1) / passSteps.length);
        await delayFrame();
      }

      hideProgress();
      statusMessage.textContent = "Heatmap computation complete.";
    } catch (err) {
      console.error(err);
      statusMessage.textContent = `Heatmap error: ${(err as Error).message}`;
      hideProgress();
    } finally {
      btnCompute.disabled = !topographyReady;
    }
  });

  btnComputeShade.addEventListener("click", async () => {
    const mapper = getMapper();
    if (!mapper) {
      statusMessage.textContent = "Load topography before computing blindspots.";
      return;
    }
    btnComputeShade.disabled = true;
    showProgress("Computing blindspots…");
    statusMessage.textContent = "Computing blindspot visibility…";
    await delayFrame();
    try {
      heatmapComputeToken += 1;
      const token = heatmapComputeToken;
      const shapes = drawingManager.getShapes();
      const shadingSteps = buildPassSteps(Math.max(1, settings.sampleStepPx), mapper.geo.image);
      const obstaclesSnapshot = shapes.filter((shape) => shape.type === "obstacle");
      for (let i = 0; i < shadingSteps.length; i += 1) {
        if (token !== heatmapComputeToken) {
          hideProgress();
          btnComputeShade.disabled = !topographyReady;
          return;
        }
        const step = shadingSteps[i];
        const tempSettings = withSampleResolution(settings, step);
        const viewers = sampleViewerPoints(shapes, tempSettings, mapper);
        if (viewers.length === 0) {
          drawingManager.setShading(null, step);
          statusMessage.textContent = "Need at least one viewer zone to compute blindspots.";
          hideProgress();
          btnComputeShade.disabled = !topographyReady;
          return;
        }
        const mapSamples = sampleMapGridPoints(tempSettings, mapper);
        const shadingCells = computeShadingOverlay(
          viewers,
          mapSamples,
          obstaclesSnapshot,
          tempSettings,
          mapper
        );
        if (token !== heatmapComputeToken) {
          hideProgress();
          btnComputeShade.disabled = !topographyReady;
          return;
        }
        drawingManager.setShading(shadingCells, Math.max(1, tempSettings.sampleStepPx));
        progressLabel.textContent = `Computing shademap (pass ${i + 1}/${shadingSteps.length})…`;
        updateProgress((i + 1) / shadingSteps.length);
        await delayFrame();
      }
      hideProgress();
      statusMessage.textContent = "Blindspot computation complete.";
      hooks?.onShadingComplete?.();
    } catch (err) {
      console.error(err);
      statusMessage.textContent = `Shademap error: ${(err as Error).message}`;
      hideProgress();
    } finally {
      btnComputeShade.disabled = !topographyReady;
    }
  });

  btnClearHeatmap.addEventListener("click", () => {
    drawingManager.clearHeatmap();
    statusMessage.textContent = "Heatmap cleared.";
  });

  btnClearShading.addEventListener("click", () => {
    drawingManager.setShading(null, Math.max(2, Math.floor(settings.sampleStepPx)));
    statusMessage.textContent = "Blindspot map cleared.";
  });

  btnClearShapes.addEventListener("click", () => {
    drawingManager.clearShapes();
    drawingManager.clearHeatmap();
    drawingManager.setShading(null, Math.max(2, Math.floor(settings.sampleStepPx)));
    statusMessage.textContent = "All shapes removed.";
  });

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

  const setTopographyReady = (ready: boolean) => {
    topographyReady = ready;
    btnCompute.disabled = !ready;
    btnComputeShade.disabled = !ready;
  };

  return { cancelHeatmap, setTopographyReady };
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
  if (typeof source.topoSpacingFt === "number") target.topoSpacingFt = source.topoSpacingFt;
  if (typeof source.sampleStepPx === "number") target.sampleStepPx = Math.max(1, source.sampleStepPx);
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
    topoSpacing: settings.topoSpacingFt.toString(),
    sampleStep: settings.sampleStepPx.toString(),
    viewerOpacity: settings.opacity.viewer.toString(),
    candidateOpacity: settings.opacity.candidate.toString(),
    obstacleOpacity: settings.opacity.obstacle.toString(),
    heatmapOpacity: settings.opacity.heatmap.toString(),
    shadingOpacity: settings.opacity.shading.toString(),
    contourOpacity: settings.opacity.contours.toString()
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

function friendlyToolName(tool: ToolMode): string {
  const lookup: Record<ToolMode, string> = {
    select: "Select",
    erase: "Erase",
    drawViewerPolygon: "Viewer Polygon",
    drawCandidatePolygon: "Candidate Polygon",
    drawObstaclePolygon: "Obstacle Polygon",
    drawObstacleEllipse: "Obstacle Ellipse"
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
  ctx.fillText("Use the map above to pick a frame, then lock and load topography.", 20, 70);
  return canvas;
}

function createDefaultSettings(): AppSettings {
  return {
    siteHeightFt: 6,
    viewerHeightFt: 6,
    topoSpacingFt: 25,
    sampleStepPx: 5,
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

function createDefaultTrafficConfig(): TrafficConfig {
  return {
    preset: "neutral",
    hour: 8,
    detail: 3,
    showOverlay: true,
    showDirectionArrows: false,
    seed: Math.floor(Math.random() * 1_000_000)
  };
}

function createDefaultTrafficView(config?: TrafficConfig): TrafficViewState {
  return {
    preset: normalizeTrafficPreset(config?.preset ?? "neutral"),
    hour: clampInt(config?.hour ?? 8, 0, 23),
    showDirection: config?.showDirectionArrows ?? false
  };
}

const TRAFFIC_PRESET_KEYS: TrafficPresetKey[] = ["am", "pm", "neutral"];
const TRAFFIC_PRESETS: TrafficPreset[] = ["am", "pm", "neutral", "hourly"];
const PRESET_DEFAULT_HOURS: Record<TrafficPresetKey, number> = {
  am: 8,
  pm: 17,
  neutral: 12
};

function presetDefaultHour(preset: TrafficPreset): number {
  if (preset === "am" || preset === "pm" || preset === "neutral") {
    return PRESET_DEFAULT_HOURS[preset];
  }
  return PRESET_DEFAULT_HOURS.neutral;
}

function isTrafficPresetKey(value: string): value is TrafficPresetKey {
  return value === "am" || value === "pm" || value === "neutral";
}

function isTrafficPreset(value: string): value is TrafficPreset {
  return value === "am" || value === "pm" || value === "neutral" || value === "hourly";
}

function normalizeTrafficPreset(value: string): TrafficPreset {
  if (value === "am" || value === "pm" || value === "neutral" || value === "hourly") {
    return value;
  }
  return "neutral";
}

function buildTrafficViewState(config: TrafficConfig): TrafficViewState {
  return {
    preset: normalizeTrafficPreset(config.preset),
    hour: clampInt(config.hour, 0, 23),
    showDirection: config.showDirectionArrows
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
    hour: Number.isFinite(view.hour) ? clampInt(view.hour, 0, 23) : fallback.hour,
    showDirection: typeof view.showDirection === "boolean" ? view.showDirection : fallback.showDirection
  };
}

function buildTrafficByPreset(byHour: TrafficByHour): TrafficByPreset {
  return {
    am: { ...byHour },
    pm: { ...byHour },
    neutral: { ...byHour },
    hourly: { ...byHour }
  };
}

function expandTrafficPresets(
  data: TrafficByRoadId | LegacyTrafficByRoadId | null
): TrafficByRoadId | null {
  if (!data) {
    return null;
  }
  const expanded: TrafficByRoadId = {};
  Object.entries(data).forEach(([roadId, byPreset]) => {
    if (isLegacyTrafficEntry(byPreset)) {
      const byHour = buildTrafficByHourFromScores(byPreset.forward, byPreset.backward);
      if (Object.keys(byHour).length > 0) {
        expanded[roadId] = buildTrafficByPreset(byHour);
      }
      return;
    }
    const presetKeys = Object.keys(byPreset);
    if (!presetKeys.length) {
      return;
    }
    const baseKey = presetKeys.find((key) => isTrafficPresetKey(key)) ?? presetKeys[0];
    const baseByHour = byPreset[baseKey] ?? {};
    expanded[roadId] = {
      am: byPreset.am ?? baseByHour,
      pm: byPreset.pm ?? baseByHour,
      neutral: byPreset.neutral ?? baseByHour,
      hourly: byPreset.hourly ?? baseByHour
    };
  });
  return expanded;
}

function isLegacyTrafficEntry(value: unknown): value is LegacyTrafficByRoadId[string] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const forward = record.forward;
  const backward = record.backward;
  return (
    (typeof forward === "number" && Number.isFinite(forward)) ||
    (typeof backward === "number" && Number.isFinite(backward))
  );
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
  trafficByRoadId: TrafficSimResult["roadTraffic"]
): void {
  for (const road of roads) {
    const traffic = trafficByRoadId[road.id];
    if (!traffic) {
      continue;
    }
    const forward = traffic.hourlyScore.forward ?? [];
    const backward = traffic.hourlyScore.backward ?? [];
    const hourlyDirectionalScores: RoadHourlyDirectionalScore[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const forwardValue = Number.isFinite(forward[hour]) ? (forward[hour] as number) : 0;
      const backwardValue = Number.isFinite(backward[hour]) ? (backward[hour] as number) : 0;
      hourlyDirectionalScores.push({
        hour,
        forward: clampTrafficScore(forwardValue),
        backward: clampTrafficScore(backwardValue)
      });
    }
    const nextTraffic: RoadTraffic = {
      ...(road.traffic ?? {}),
      hourlyDirectionalScores
    };
    road.traffic = nextTraffic;
  }
}

function buildLegacyTrafficByRoadId(
  data: TrafficByRoadId | null,
  view: TrafficViewState
): LegacyTrafficByRoadId | null {
  if (!data) {
    return null;
  }
  const preset = normalizeTrafficPreset(view.preset);
  const hour = clampInt(view.hour, 0, 23);
  const legacy: LegacyTrafficByRoadId = {};
  Object.entries(data).forEach(([roadId, byPreset]) => {
    const presetData =
      byPreset[preset] ??
      byPreset.neutral ??
      byPreset.am ??
      byPreset.pm ??
      byPreset.hourly;
    if (!presetData) {
      return;
    }
    const scores = presetData[hour] ?? presetData[0];
    if (!scores) {
      return;
    }
    const forward = Number.isFinite(scores.forward) ? (scores.forward as number) : undefined;
    const backward = Number.isFinite(scores.reverse) ? (scores.reverse as number) : undefined;
    if (forward === undefined && backward === undefined) {
      return;
    }
    legacy[roadId] = {
      forward: forward ?? 0,
      backward: backward ?? 0
    };
  });
  return Object.keys(legacy).length > 0 ? legacy : null;
}

function formatTrafficMeta(meta?: TrafficSimResult["meta"] | null): string {
  if (!meta) {
    return "Traffic computed.";
  }
  const duration = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : "–";
  return `Traffic computed · trips ${meta.trips} · k ${meta.kRoutes} · ${duration}`;
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
      class: road.class
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
    height: building.heightM
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

function boundsApproxEqual(a: GeoBounds, b: GeoBounds): boolean {
  const epsilon = 0.0001;
  return (
    Math.abs(a.north - b.north) < epsilon &&
    Math.abs(a.south - b.south) < epsilon &&
    Math.abs(a.east - b.east) < epsilon &&
    Math.abs(a.west - b.west) < epsilon
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
