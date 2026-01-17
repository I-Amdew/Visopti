import {
  GeoBounds,
  GeoPoint,
  GeoProjector,
  HeatmapCell,
  Shape,
  SignKind,
  TreeType,
  ZoneType,
  RectShape,
  EllipseShape,
  ViewerDirection
} from "./types";
import { ContourSegment } from "./contours";
import { GeoMapper } from "./geo";
import {
  Road,
  Building,
  TrafficByRoadId,
  TrafficViewState,
  MapPoint
} from "./roads/types";
import type { WorldFeatureKind, WorldModel } from "./world/worldModel";
import { resolveBuildingHeightInfo } from "./world/height";
import { demandWeightForClass, resolveLaneCounts } from "./traffic/lanes";
import type { LaneCounts } from "./traffic/lanes";
import {
  Point as RoadRenderPoint,
  Bounds as RoadBounds,
  PolylineHit,
  PolylineSample,
  catmullRomSpline,
  distanceToPolyline,
  samplePolyline,
  computeBounds,
  offsetPolyline
} from "./roads/geometry";

interface TrafficEpicenter {
  point: GeoPoint;
  weight: number;
}

const POLYGON_CLOSE_RADIUS = 12;
const SHAPE_VERTEX_RADIUS = 5;
const SHAPE_VERTEX_HIT_RADIUS = 10;
const DEFAULT_CONE_RAD = Math.PI * 0.75;
const MIN_CONE_RAD = Math.PI / 18;
const MAX_CONE_RAD = Math.PI;
const HANDLE_MIN_DISTANCE = 40;
const HANDLE_MAX_DISTANCE = 200;
const HANDLE_HIT_RADIUS = 14;
const ANCHOR_HIT_RADIUS = 18;
const SNAP_RADIUS = 12;
const ROAD_SELECT_RADIUS = 10;
const ROAD_INSERT_RADIUS = 12;
const ROAD_CONTROL_RADIUS = 7;
const POINT_FEATURE_HIT_RADIUS = 10;
const ROAD_ARROW_SPACING = 70;
const ROAD_FLOW_SPACING = 32;
const ROAD_CURVE_SAMPLES = 12;
const ROAD_DIRECTION_SAMPLES = 10;
const LANE_WIDTH_RATIO = 0.0045;
const MIN_LANE_WIDTH_PX = 3;
const MAX_LANE_WIDTH_PX = 5;
const MAX_RENDERED_LANES = 8;
const FEET_TO_METERS = 0.3048;
const ISO_VIEW_ANGLE = -Math.PI * 0.75;
const ISO_HEIGHT_SCALE = 0.6;
const VIEW_SPIN_SPEED = 0.6;
const DEFAULT_BUILDING_HEIGHT_M = 3;
const TREE_FILL = "#4ade80";
const TREE_STROKE = "#1f7f6c";
const DENSE_COVER_FILL = "#2c8f4d";
const DENSE_COVER_STROKE = "#1d5f34";
const SIGN_FILL = "#f59e0b";
const SIGN_STROKE = "#b45309";
const SIGNAL_FILL = "#ef4444";
const SIGNAL_STROKE = "#991b1b";

export function shouldIgnoreGlobalKeyEvents(activeEl: Element | null): boolean {
  if (!activeEl) {
    return false;
  }
  const tagName = activeEl.tagName?.toUpperCase() ?? "";
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  const editable = (activeEl as HTMLElement).isContentEditable;
  if (editable) {
    return true;
  }
  if (typeof activeEl.getAttribute === "function") {
    const attr = activeEl.getAttribute("contenteditable");
    if (attr && attr.toLowerCase() !== "false") {
      return true;
    }
  }
  return false;
}

export type ToolMode =
  | "select"
  | "erase"
  | "drawObstacleEllipse"
  | "drawObstaclePolygon"
  | "drawDenseCoverPolygon"
  | "drawCandidatePolygon"
  | "drawViewerPolygon"
  | "placeTreePine"
  | "placeTreeDeciduous"
  | "placeSign"
  | "labelTreePine"
  | "labelTreeDeciduous"
  | "labelSign"
  | "labelBillboard";

export type RoadToolMode = "off" | "edit";

export type MapStylePreset = "satellite" | "simple" | "locked";

export type WorldLayer = "roads" | "buildings" | "trees" | "signs" | "candidates" | "traffic";

export interface FeatureSelection {
  kind: WorldFeatureKind;
  id: string;
}

export interface RoadEditSelection {
  roadId: string | null;
  pointIndex: number | null;
  hasDraft: boolean;
}

type BaseImage = CanvasImageSource & { width: number; height: number };

interface DrawingManagerOptions {
  canvas: HTMLCanvasElement;
  image: BaseImage;
  onShapesChanged?: (shapes: Shape[]) => void;
  onPointerMove?: (pixel: { x: number; y: number } | null) => void;
  onInteraction?: () => void;
  onShapeSelectionChanged?: (shapeId: string | null) => void;
  onRoadSelectionChanged?: (roadId: string | null) => void;
  onRoadEditSelectionChanged?: (selection: RoadEditSelection) => void;
  onFeatureSelectionChanged?: (selection: FeatureSelection | null) => void;
  onFeaturePlaced?: (request: {
    kind: "tree" | "sign";
    location: GeoPoint;
    treeType?: TreeType;
    signKind?: SignKind;
    radiusMeters?: number;
    yawDegrees?: number;
  }) => void;
  onFeatureMoved?: (request: {
    kind: "tree" | "sign";
    id: string;
    location: GeoPoint;
  }) => void;
  onDenseCoverCreated?: (request: { polygon: GeoPoint[]; density: number }) => void;
  onDenseCoverDeleted?: (id: string) => void;
}

interface DrawingManagerState {
  shapes: Shape[];
  heatmapData: { cells: HeatmapCell[]; cellSize: number } | null;
  heatmapBitmap: HTMLCanvasElement | null;
  heatmapCellSize: number;
  bestHeatmapCell: HeatmapCell | null;
  shadingData: { cells: HeatmapCell[]; cellSize: number } | null;
  shadingBitmap: HTMLCanvasElement | null;
  shadingCellSize: number;
  contours: ContourSegment[] | null;
  autoRoads: Road[];
  customRoads: Road[];
  buildings: Building[];
  worldModel: WorldModel | null;
  roadRenderIndex: Record<string, RoadRenderCache>;
  autoRoadRender: RoadRenderCache[];
  customRoadRender: RoadRenderCache[];
  buildingRender: BuildingRenderCache[];
  structureRender: StructureRenderData | null;
  structureOverlay: StructureOverlayData | null;
  trafficByRoadId: TrafficByRoadId;
  trafficViewState: TrafficViewState;
  trafficEpicenters: TrafficEpicenter[];
  trafficOverlayEnabled: boolean;
  trafficAnimationTime: number;
  trafficPreview: TrafficPreviewState;
  roadDirectionOverlayEnabled: boolean;
  selectedRoadId: string | null;
  selectedShapeId: string | null;
  selectedFeature: FeatureSelection | null;
  currentTool: ToolMode;
  roadToolMode: RoadToolMode;
  roadEdit: RoadEditState;
  shapeEdit: ShapeEditState;
  shapeVertexDrag: ShapeVertexDragState | null;
  featureDrag: { kind: "tree" | "sign"; id: string } | null;
  customRoadsDirty: boolean;
  geoProjector: GeoProjector | null;
  geoMapper: GeoMapper | null;
  debugHud: DebugHudData;
  dragState: DragState | null;
  polygonDraft: PolygonDraft | null;
  pointer: { x: number; y: number } | null;
  view: ViewState;
  panDrag: PanDragState | null;
  directionDrag: DirectionDragState | null;
  activeViewerEditId: string | null;
  mapStylePreset: MapStylePreset;
  threeDViewEnabled: boolean;
  viewSpinActive: boolean;
  viewYaw: number;
  inspectMode: boolean;
  layerVisibility: Record<WorldLayer, boolean>;
  visibilityFilter: Record<ZoneType, boolean>;
  zoneOpacity: Record<ZoneType, number>;
  heatmapOpacity: number;
  shadingOpacity: number;
  showContours: boolean;
  contourOpacity: number;
  denseCoverDensity: number;
}

interface EllipseDragState {
  start: { x: number; y: number };
  current: { x: number; y: number };
  kind: "ellipse";
  zone: ZoneType;
}

interface TreeLabelDragState {
  start: { x: number; y: number };
  current: { x: number; y: number };
  kind: "tree";
  treeType: TreeType;
}

type DragState = EllipseDragState | TreeLabelDragState;

type PolygonDraftMode = "shape" | "dense_cover";

interface PolygonDraft {
  mode: PolygonDraftMode;
  zone?: ZoneType;
  points: { x: number; y: number }[];
}

interface ViewState {
  scale: number;
  offsetX: number;
  offsetY: number;
  minScale: number;
  maxScale: number;
  baseScale: number;
}

interface PanDragState {
  startCanvas: { x: number; y: number };
  startOffset: { x: number; y: number };
}

interface DirectionDragState {
  shapeId: string;
  anchor: { x: number; y: number };
  hasMoved: boolean;
}

interface RoadRenderCache {
  id: string;
  source: "auto" | "custom";
  controlPoints: RoadRenderPoint[];
  renderPoints: RoadRenderPoint[];
  directionPoints: RoadRenderPoint[] | null;
  bounds: RoadBounds | null;
  arrowSamples: PolylineSample[];
  flowSamples: PolylineSample[];
  showDirectionLine: boolean;
  roadClass?: Road["class"];
  laneCounts?: LaneCounts;
  oneway?: Road["oneway"];
}

interface BuildingRenderCache {
  id: string;
  points: RoadRenderPoint[];
  bounds: RoadBounds | null;
  center: RoadRenderPoint | null;
  heightM: number | null;
}

export interface StructureRenderData {
  points: RoadRenderPoint[];
  heightM: number;
}

export interface StructureOverlayData {
  faceScores?: number[];
  highlight?: boolean;
}

interface RoadDraft {
  points: RoadRenderPoint[];
  storeMode: "pixel" | "geo";
}

interface RoadDragState {
  roadId: string;
  pointIndex: number;
}

interface RoadEditState {
  draft: RoadDraft | null;
  drag: RoadDragState | null;
  selectedPointIndex: number | null;
}

interface ShapeEditState {
  shapeId: string | null;
  pointIndex: number | null;
}

interface ShapeVertexDragState {
  shapeId: string;
  pointIndex: number;
}

interface TrafficPreviewPlan {
  direction: 1 | -1;
  step: number;
  speed: number;
  offset: number;
  radius: number;
  startIndex: number;
  span: number;
}

interface TrafficPreviewState {
  active: boolean;
  seed: number;
  plans: Map<string, TrafficPreviewPlan[]>;
}

interface TrafficScores {
  combined: number | null;
  forward?: number;
  reverse?: number;
}

export interface DebugHudData {
  workflowMode: string;
  lockedBounds: GeoBounds | null;
  autoDataLoaded: boolean;
  autoDataLoading: boolean;
  autoRoadCount: number | null;
  buildingCount: number | null;
  topographyLoading: boolean;
  lastError: string | null;
}

export interface DrawingManager {
  getShapes(): Shape[];
  setShapes(shapes: Shape[]): void;
  clearShapes(): void;
  getTool(): ToolMode;
  setTool(tool: ToolMode): void;
  getRoadToolMode(): RoadToolMode;
  setRoadToolMode(mode: RoadToolMode): void;
  setBaseImage(image: BaseImage, options?: { resetView?: boolean }): void;
  setMapStylePreset(preset: MapStylePreset): void;
  setGeoProjector(projector: GeoProjector | null): void;
  setGeoMapper(mapper: GeoMapper | null): void;
  setDebugHudData(data: DebugHudData): void;
  setHeatmap(cells: HeatmapCell[] | null, cellSize: number): void;
  clearHeatmap(): void;
  setHeatmapOpacity(value: number): void;
  setZoneOpacity(zone: ZoneType, alpha: number): void;
  setZoneVisibility(zone: ZoneType, visible: boolean): void;
  setShading(cells: HeatmapCell[] | null, cellSize: number): void;
  setShadingOpacity(value: number): void;
  setContours(segments: ContourSegment[] | null): void;
  setShowContours(value: boolean): void;
  setContourOpacity(value: number): void;
  setDenseCoverDensity(value: number): void;
  setRoadData(data: { autoRoads: Road[]; customRoads: Road[] }): void;
  setBuildings(buildings: Building[]): void;
  setWorldModel(model: WorldModel | null): void;
  setWorldLayerVisibility(layer: WorldLayer, visible: boolean): void;
  setInspectMode(enabled: boolean): void;
  setStructure(structure: StructureRenderData | null): void;
  setStructureOverlay(overlay: StructureOverlayData | null): void;
  setTrafficData(trafficByRoadId: TrafficByRoadId, trafficViewState: TrafficViewState): void;
  setTrafficEpicenters(epicenters: TrafficEpicenter[]): void;
  setTrafficOverlayEnabled(enabled: boolean): void;
  setTrafficPreview(options: { active: boolean; seed?: number }): void;
  setRoadDirectionOverlayEnabled(enabled: boolean): void;
  setThreeDViewEnabled(enabled: boolean): void;
  setViewSpinActive(active: boolean): void;
  setModel(data: {
    autoRoads?: Road[];
    customRoads?: Road[];
    buildings?: Building[];
    trafficByRoadId?: TrafficByRoadId;
    trafficViewState?: TrafficViewState;
    geoProjector?: GeoProjector | null;
    geoMapper?: GeoMapper | null;
  }): void;
  getSelectedShapeId(): string | null;
  setSelectedShapeId(id: string | null): void;
  focusShape(id: string, options?: { padding?: number }): void;
  getSelectedRoadId(): string | null;
  setSelectedRoadId(id: string | null): void;
  getSelectedFeature(): FeatureSelection | null;
  getRoadEditSelection(): RoadEditSelection;
  getCustomRoads(): Road[];
  getCustomRoadsDirty(): boolean;
  clearCustomRoadsDirty(): void;
  redraw(): void;
}

export function createDrawingManager(options: DrawingManagerOptions): DrawingManager {
  const {
    canvas,
    image,
    onShapesChanged,
    onPointerMove,
    onInteraction,
    onShapeSelectionChanged,
    onRoadSelectionChanged,
    onRoadEditSelectionChanged,
    onFeatureSelectionChanged,
    onFeaturePlaced,
    onFeatureMoved,
    onDenseCoverCreated,
    onDenseCoverDeleted
  } = options;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context unavailable");
  }
  const ctx = context;

  let baseImage: BaseImage = image;
  let baseWidth = image.width;
  let baseHeight = image.height;
  const state: DrawingManagerState = {
    shapes: [],
    heatmapData: null,
    heatmapBitmap: null,
    heatmapCellSize: 20,
    bestHeatmapCell: null,
    shadingData: null,
    shadingBitmap: null,
    shadingCellSize: 20,
    contours: null,
    autoRoads: [],
    customRoads: [],
    buildings: [],
    worldModel: null,
    roadRenderIndex: {},
    autoRoadRender: [],
    customRoadRender: [],
    buildingRender: [],
    structureRender: null,
    structureOverlay: null,
    trafficByRoadId: {},
    trafficViewState: {
      preset: "default",
      hour: 12,
      showDirection: false,
      flowDensity: "medium"
    },
    trafficEpicenters: [],
    trafficOverlayEnabled: false,
    trafficAnimationTime: 0,
    trafficPreview: {
      active: false,
      seed: 0,
      plans: new Map()
    },
    roadDirectionOverlayEnabled: true,
    selectedRoadId: null,
    selectedShapeId: null,
    selectedFeature: null,
    currentTool: "select",
    roadToolMode: "off",
    roadEdit: {
      draft: null,
      drag: null,
      selectedPointIndex: null
    },
    shapeEdit: {
      shapeId: null,
      pointIndex: null
    },
    shapeVertexDrag: null,
    featureDrag: null,
    customRoadsDirty: false,
    geoProjector: null,
    geoMapper: null,
    debugHud: {
      workflowMode: "explore",
      lockedBounds: null,
      autoDataLoaded: false,
      autoDataLoading: false,
      autoRoadCount: null,
      buildingCount: null,
      topographyLoading: false,
      lastError: null
    },
    dragState: null,
    polygonDraft: null,
    pointer: null,
    view: {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      minScale: 0.25,
      maxScale: 6,
      baseScale: 1
    },
    panDrag: null,
    directionDrag: null,
    activeViewerEditId: null,
    mapStylePreset: "satellite",
    threeDViewEnabled: false,
    viewSpinActive: false,
    viewYaw: 0,
    inspectMode: false,
    layerVisibility: {
      roads: true,
      buildings: true,
      trees: true,
      signs: true,
      candidates: true,
      traffic: true
    },
    visibilityFilter: {
      obstacle: true,
      candidate: true,
      viewer: true
    },
    zoneOpacity: {
      obstacle: 0.85,
      candidate: 0.6,
      viewer: 0.6
    },
    heatmapOpacity: 0.45,
    shadingOpacity: 0.6,
    showContours: false,
    contourOpacity: 0.9,
    denseCoverDensity: 0.7
  };
  let lastSelectedShapeId: string | null = null;
  let lastSelectedFeature: FeatureSelection | null = null;
  const notifyInteraction = () => {
    onInteraction?.();
  };
  const notifyShapeSelection = (shouldNotify = true) => {
    if (!onShapeSelectionChanged) {
      return;
    }
    if (state.selectedShapeId === lastSelectedShapeId) {
      return;
    }
    lastSelectedShapeId = state.selectedShapeId;
    if (shouldNotify) {
      onShapeSelectionChanged(state.selectedShapeId);
    }
  };
  const notifyRoadSelection = () => {
    onRoadSelectionChanged?.(state.selectedRoadId);
  };
  const notifyFeatureSelection = (shouldNotify = true) => {
    if (!onFeatureSelectionChanged) {
      lastSelectedFeature = state.selectedFeature ? { ...state.selectedFeature } : null;
      return;
    }
    const next = state.selectedFeature;
    const changed =
      (next?.id ?? null) !== (lastSelectedFeature?.id ?? null) ||
      (next?.kind ?? null) !== (lastSelectedFeature?.kind ?? null);
    lastSelectedFeature = next ? { ...next } : null;
    if (changed && shouldNotify) {
      onFeatureSelectionChanged(next ? { ...next } : null);
    }
  };
  let lastCanvasWidth = canvas.width;
  let lastCanvasHeight = canvas.height;
  let lastRoadEditSelection: RoadEditSelection = {
    roadId: null,
    pointIndex: null,
    hasDraft: false
  };
  let trafficAnimationFrame: number | null = null;
  let trafficAnimationActive = false;
  let lastAnimationTime = 0;

  const getRoadEditSelectionSnapshot = (): RoadEditSelection => ({
    roadId: state.selectedRoadId,
    pointIndex: state.roadEdit.selectedPointIndex,
    hasDraft: !!state.roadEdit.draft
  });

  const notifyRoadEditSelection = (shouldNotify = true) => {
    if (!onRoadEditSelectionChanged) {
      lastRoadEditSelection = getRoadEditSelectionSnapshot();
      return;
    }
    const next = getRoadEditSelectionSnapshot();
    const changed =
      next.roadId !== lastRoadEditSelection.roadId ||
      next.pointIndex !== lastRoadEditSelection.pointIndex ||
      next.hasDraft !== lastRoadEditSelection.hasDraft;
    lastRoadEditSelection = next;
    if (changed && shouldNotify) {
      onRoadEditSelectionChanged(next);
    }
  };

  const shouldAnimateTraffic = () => {
    const trafficVisible = state.layerVisibility.traffic;
    return (
      (trafficVisible && state.trafficPreview.active) ||
      (trafficVisible && state.trafficOverlayEnabled && Object.keys(state.trafficByRoadId).length > 0) ||
      (state.threeDViewEnabled && state.viewSpinActive)
    );
  };

  const stopTrafficAnimation = () => {
    if (trafficAnimationFrame !== null) {
      cancelAnimationFrame(trafficAnimationFrame);
      trafficAnimationFrame = null;
    }
    trafficAnimationActive = false;
  };

  const startTrafficAnimation = () => {
    if (trafficAnimationActive) {
      return;
    }
    trafficAnimationActive = true;
    lastAnimationTime = performance.now();
    const tick = (time: number) => {
      if (!trafficAnimationActive) {
        return;
      }
      const delta = Math.max(0, (time - lastAnimationTime) / 1000);
      lastAnimationTime = time;
      state.trafficAnimationTime = (state.trafficAnimationTime + delta) % 60;
      if (state.threeDViewEnabled && state.viewSpinActive) {
        state.viewYaw = (state.viewYaw + delta * VIEW_SPIN_SPEED) % (Math.PI * 2);
      }
      redraw();
      trafficAnimationFrame = requestAnimationFrame(tick);
    };
    trafficAnimationFrame = requestAnimationFrame(tick);
  };

  const updateTrafficAnimation = () => {
    if (shouldAnimateTraffic()) {
      startTrafficAnimation();
    } else {
      stopTrafficAnimation();
    }
  };

  function notifyShapes() {
    onShapesChanged?.(state.shapes.slice());
  }

  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const mapStyle = resolveMapStyle(state.mapStylePreset);
    const lockedStyle =
      state.mapStylePreset === "locked" ? resolveLockedOverlayStyle() : null;
    const background = lockedStyle?.background ?? mapStyle.background;
    const metersPerPixel = computeMetersPerPixel(state, canvas);
    const isometricView = resolveIsometricView(state);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const hasRoads =
      state.autoRoadRender.length > 0 || state.customRoadRender.length > 0;
    const hasBuildings = state.buildingRender.length > 0;
    const showPlaceholder = !!lockedStyle && !hasRoads && !hasBuildings;
    if (showPlaceholder && lockedStyle) {
      drawPlaceholderGrid(ctx, canvas, lockedStyle);
    }
    ctx.save();
    const appliedScale = state.view.scale * state.view.baseScale;
    const baseLaneWidthPx = resolveBaseLaneWidthPx(canvas);
    ctx.setTransform(appliedScale, 0, 0, appliedScale, state.view.offsetX, state.view.offsetY);
    if (mapStyle.showBaseImage) {
      ctx.drawImage(baseImage, 0, 0, baseWidth, baseHeight);
    } else {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, baseWidth, baseHeight);
    }
    if (state.geoMapper && state.shadingBitmap) {
      ctx.drawImage(state.shadingBitmap, 0, 0, baseWidth, baseHeight);
    }
    if (state.geoMapper && state.showContours && state.contours) {
      drawContours(ctx, state.contours, state.contourOpacity);
    }
    if (state.layerVisibility.buildings) {
      drawBuildings(ctx, state, mapStyle, lockedStyle, isometricView, metersPerPixel);
    }
    if (state.layerVisibility.roads) {
      drawRoads(ctx, state, mapStyle, lockedStyle, appliedScale, baseLaneWidthPx);
    }
    if (state.layerVisibility.trees) {
      drawDenseCover(ctx, state);
      drawTrees(ctx, state, lockedStyle, metersPerPixel);
    }
    if (state.layerVisibility.signs) {
      drawSigns(ctx, state, lockedStyle, metersPerPixel);
    }
    if (state.layerVisibility.traffic) {
      drawTrafficSignals(ctx, state, lockedStyle, appliedScale);
      drawTrafficEpicenters(ctx, state, lockedStyle, appliedScale);
    }
    drawStructure(ctx, state, lockedStyle, isometricView, metersPerPixel);
    drawShapes(ctx, state, lockedStyle);
    if (state.heatmapBitmap) {
      ctx.drawImage(state.heatmapBitmap, 0, 0, baseWidth, baseHeight);
    }
    if (state.bestHeatmapCell) {
      drawBestCellMarker(ctx, state.bestHeatmapCell.pixel.x, state.bestHeatmapCell.pixel.y);
    }
    drawPreviews(ctx, state, lockedStyle);
    ctx.restore();
    if (lockedStyle) {
      drawLockedHud(
        ctx,
        canvas,
        state,
        lockedStyle,
        {
          hasRoads,
          hasBuildings,
          autoDataLoading: state.debugHud.autoDataLoading
        }
      );
    }
    drawDebugHud(ctx, canvas, state);
  }

  function drawDebugHud(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    state: DrawingManagerState
  ) {
    if (!isDebugHudEnabled()) {
      return;
    }
    const hud = state.debugHud;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.round(rect.width);
    const cssHeight = Math.round(rect.height);
    const dpr = window.devicePixelRatio || 1;
    const boundsLabel = hud.lockedBounds ? formatBoundsLabel(hud.lockedBounds) : "n/a";
    const geoLabel = state.geoProjector ? "yes" : "no";
    const elevationLabel = state.geoMapper ? "yes" : "no";
    const lines: string[] = [];
    lines.push(`mode: ${hud.workflowMode}`);
    lines.push(`bounds: ${boundsLabel}`);
    lines.push(`canvas: css ${cssWidth}x${cssHeight} px ${canvas.width}x${canvas.height} dpr ${dpr.toFixed(2)}`);
    lines.push(`geoProjector: ${geoLabel} elevation: ${elevationLabel}`);
    lines.push(formatAutoDataLine(hud));
    lines.push(formatTerrainLine(hud, state));
    lines.push(`error: ${formatErrorLabel(hud.lastError)}`);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = "12px Menlo, Consolas, monospace";
    ctx.textBaseline = "top";
    const padding = 8;
    const lineHeight = 14;
    let maxWidth = 0;
    for (const line of lines) {
      maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
    }
    const maxPanelWidth = Math.max(0, canvas.width - padding * 2);
    const panelWidth = Math.min(maxPanelWidth, Math.ceil(maxWidth + padding * 2));
    const panelHeight = lineHeight * lines.length + padding * 2;
    const originX = 12;
    const originY = 12;
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(originX, originY, panelWidth, panelHeight);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.strokeRect(originX, originY, panelWidth, panelHeight);
    ctx.fillStyle = "#f1f5f9";
    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillText(lines[i], originX + padding, originY + padding + i * lineHeight);
    }
    ctx.restore();
  }

  function formatBoundsLabel(bounds: GeoBounds): string {
    return `N ${bounds.north.toFixed(4)} S ${bounds.south.toFixed(4)} W ${bounds.west.toFixed(4)} E ${bounds.east.toFixed(4)}`;
  }

  function formatAutoDataLine(hud: DebugHudData): string {
    if (hud.autoDataLoading) {
      return "auto data: loading";
    }
    if (!hud.autoDataLoaded) {
      return "auto data: n/a";
    }
    const roadCount = hud.autoRoadCount ?? 0;
    const buildingCount = hud.buildingCount ?? 0;
    return `auto data: roads ${roadCount} buildings ${buildingCount}`;
  }

  function formatTerrainLine(hud: DebugHudData, state: DrawingManagerState): string {
    if (hud.topographyLoading) {
      return "terrain: loading";
    }
    if (state.geoMapper) {
      return "terrain: ready";
    }
    return "terrain: n/a";
  }

  function formatErrorLabel(message: string | null): string {
    if (!message) {
      return "none";
    }
    const trimmed = message.trim();
    if (!trimmed) {
      return "none";
    }
    if (trimmed.length > 160) {
      return `${trimmed.slice(0, 157)}...`;
    }
    return trimmed;
  }

  function isDebugHudEnabled(): boolean {
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

  function updatePointer(pos: { x: number; y: number } | null) {
    state.pointer = pos;
    onPointerMove?.(pos);
  }

  function handleMouseDown(ev: MouseEvent) {
    if (ev.button === 0) {
      notifyInteraction();
    }
    if (ev.button === 1 || ev.button === 2) {
      beginPan(ev);
      return;
    }
    if (ev.button !== 0) {
      return;
    }
    const pos = getMousePos(canvas, ev, state);
    updatePointer(pos);

    if (state.inspectMode) {
      const selection = selectFeatureAt(pos);
      if (selection && (selection.kind === "tree" || selection.kind === "sign")) {
        beginFeatureDrag(selection);
      }
      redraw();
      return;
    }

    if (state.roadToolMode === "edit") {
      handleRoadMouseDown(pos);
      return;
    }

    switch (state.currentTool) {
      case "placeTreePine":
      case "placeTreeDeciduous":
      case "placeSign":
        placePointFeature(state.currentTool, pos);
        redraw();
        return;
      case "labelTreePine":
      case "labelTreeDeciduous":
        state.dragState = {
          start: pos,
          current: pos,
          kind: "tree",
          treeType: state.currentTool === "labelTreePine" ? "pine" : "deciduous"
        };
        redraw();
        return;
      case "labelSign":
      case "labelBillboard":
        placePointFeature(state.currentTool, pos);
        redraw();
        return;
      case "select": {
        const vertexHit = hitTestShapeVertex(pos);
        if (vertexHit) {
          setSelectedRoadId(null);
          setSelectedShapeId(vertexHit.shape.id);
          state.shapeEdit = { shapeId: vertexHit.shape.id, pointIndex: vertexHit.pointIndex };
          state.shapeVertexDrag = {
            shapeId: vertexHit.shape.id,
            pointIndex: vertexHit.pointIndex
          };
          redraw();
          return;
        }
        const selectedShape = selectShapeAt(pos);
        if (selectedShape) {
          setSelectedRoadId(null);
          state.shapeEdit = { shapeId: selectedShape.id, pointIndex: null };
          state.shapeVertexDrag = null;
          if (selectedShape.type === "viewer" && ev.button === 0) {
            if (beginViewerConeEdit(selectedShape, pos)) {
              return;
            }
          }
          redraw();
          return;
        }
        const road = selectRoadAt(pos, true);
        if (road) {
          setSelectedShapeId(null);
        }
        redraw();
        return;
      }
    case "erase":
        if (eraseDenseCoverAt(pos)) {
          redraw();
          return;
        }
        if (eraseShapeAt(pos)) {
          notifyShapes();
          redraw();
        }
        return;
      default:
        break;
    }

    const drawInfo = toolToDrawInfo(state.currentTool);
    if (!drawInfo) {
      return;
    }
    if (drawInfo.kind === "polygon") {
      if (maybeClosePolygon(pos, drawInfo)) {
        redraw();
        return;
      }
      extendPolygon(pos, drawInfo);
      redraw();
      return;
    }

    if (drawInfo.kind === "ellipse" && drawInfo.zone) {
      state.dragState = {
        start: pos,
        current: pos,
        kind: "ellipse",
        zone: drawInfo.zone
      };
    }
  }

  function handleMouseMove(ev: MouseEvent) {
    if (state.panDrag) {
      updatePanDrag(ev);
      return;
    }
    const pos = getMousePos(canvas, ev, state);
    updatePointer(pos);
    if (state.directionDrag) {
      updateDirectionDragPosition(pos, false);
      return;
    }
    if (state.shapeVertexDrag) {
      updateShapeVertexDrag(pos);
      return;
    }
    if (state.featureDrag) {
      updateFeatureDrag(pos);
      return;
    }
    if (state.roadToolMode === "edit") {
      if (state.roadEdit.drag) {
        updateRoadDrag(pos);
        return;
      }
      if (state.roadEdit.draft) {
        redraw();
        return;
      }
    }
    if (state.dragState) {
      state.dragState.current = pos;
      redraw();
    } else if (state.polygonDraft) {
      redraw();
    }
  }

  function handleMouseUp(ev: MouseEvent) {
    if (state.panDrag) {
      endPan();
      return;
    }
    if (state.directionDrag) {
      const pos = getMousePos(canvas, ev, state);
      updateDirectionDragPosition(pos, true);
      return;
    }
    if (state.shapeVertexDrag) {
      finishShapeVertexDrag(true);
      return;
    }
    if (state.featureDrag) {
      endFeatureDrag();
      return;
    }
    if (state.roadEdit.drag) {
      endRoadDrag();
      return;
    }
    if (!state.dragState || ev.button !== 0) {
      return;
    }
    const finalPos = getMousePos(canvas, ev, state);
    state.dragState.current = finalPos;
    commitDragShape();
  }

  function handleMouseLeave() {
    updatePointer(null);
    if (state.panDrag) {
      endPan();
    }
    if (state.directionDrag) {
      finishViewerConeEdit(true);
    }
    if (state.shapeVertexDrag) {
      finishShapeVertexDrag(true);
    }
    if (state.featureDrag) {
      endFeatureDrag();
    }
    if (state.roadEdit.drag) {
      endRoadDrag();
    }
    if (state.dragState) {
      commitDragShape();
    }
  }

  function handleDoubleClick(ev: MouseEvent) {
    if (state.roadToolMode === "edit" && state.roadEdit.draft) {
      ev.preventDefault();
      finalizeRoadDraft();
      return;
    }
    if (!state.polygonDraft) {
      return;
    }
    ev.preventDefault();
    finalizePolygon();
  }

  function handleKeyDown(ev: KeyboardEvent) {
    if (shouldIgnoreGlobalKeyEvents(document.activeElement)) {
      return;
    }
    if (state.roadToolMode === "edit") {
      if (ev.key === "Escape" && state.roadEdit.draft) {
        cancelRoadDraft();
        return;
      }
      if (ev.key === "Enter" && state.roadEdit.draft) {
        finalizeRoadDraft();
        return;
      }
      if (ev.key === "Delete" || ev.key === "Backspace") {
        deleteSelectedRoadPoint();
        return;
      }
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      deleteSelectedShapeVertex();
      return;
    }
    if (ev.key === "Escape" && state.polygonDraft) {
      state.polygonDraft = null;
      redraw();
    }
    if (ev.key === "Enter" && state.polygonDraft) {
      finalizePolygon();
    }
  }

  function beginViewerConeEdit(shape: Shape, click: { x: number; y: number }): boolean {
    if (shape.type !== "viewer" || !pointInShape(click, shape)) {
      return false;
    }
    const currentAnchor = getViewerAnchor(shape);
    const distance = Math.hypot(click.x - currentAnchor.x, click.y - currentAnchor.y);
    const anchor =
      distance <= ANCHOR_HIT_RADIUS * 1.35
        ? currentAnchor
        : { x: click.x, y: click.y };
    shape.viewerAnchor = anchor;
    if (!shape.direction) {
      shape.direction = {
        angleRad: 0,
        coneRad: DEFAULT_CONE_RAD
      } as ViewerDirection;
    }
    state.activeViewerEditId = shape.id;
    state.directionDrag = {
      shapeId: shape.id,
      anchor,
      hasMoved: false
    };
    redraw();
    return true;
  }

  function finishViewerConeEdit(shouldNotify: boolean) {
    if (state.directionDrag) {
      state.directionDrag = null;
    }
    if (state.activeViewerEditId) {
      state.activeViewerEditId = null;
    }
    if (shouldNotify) {
      notifyShapes();
    }
  }

  function updateShapeVertexDrag(pos: { x: number; y: number }) {
    const drag = state.shapeVertexDrag;
    if (!drag) {
      return;
    }
    const target = state.shapes.find((shape) => shape.id === drag.shapeId);
    if (!target || target.kind !== "polygon") {
      state.shapeVertexDrag = null;
      return;
    }
    if (drag.pointIndex < 0 || drag.pointIndex >= target.points.length) {
      state.shapeVertexDrag = null;
      return;
    }
    target.points[drag.pointIndex] = { x: pos.x, y: pos.y };
    state.shapeEdit = { shapeId: drag.shapeId, pointIndex: drag.pointIndex };
    redraw();
  }

  function finishShapeVertexDrag(shouldNotify: boolean) {
    if (!state.shapeVertexDrag) {
      return;
    }
    state.shapeVertexDrag = null;
    if (shouldNotify) {
      notifyShapes();
    }
  }

  function placePointFeature(tool: ToolMode, pos: { x: number; y: number }) {
    if (!onFeaturePlaced) {
      return;
    }
    const location = resolveFeatureLatLon(pos);
    if (!location) {
      return;
    }
    if (tool === "placeTreePine") {
      onFeaturePlaced({ kind: "tree", location, treeType: "pine" });
      notifyInteraction();
      return;
    }
    if (tool === "placeTreeDeciduous") {
      onFeaturePlaced({ kind: "tree", location, treeType: "deciduous" });
      notifyInteraction();
      return;
    }
    if (tool === "placeSign") {
      onFeaturePlaced({ kind: "sign", location, signKind: "sign" });
      notifyInteraction();
    }
    if (tool === "labelSign") {
      onFeaturePlaced({ kind: "sign", location, signKind: "sign" });
      notifyInteraction();
    }
    if (tool === "labelBillboard") {
      onFeaturePlaced({ kind: "sign", location, signKind: "billboard" });
      notifyInteraction();
    }
  }

  function beginFeatureDrag(selection: FeatureSelection): boolean {
    if (selection.kind !== "tree" && selection.kind !== "sign") {
      return false;
    }
    state.featureDrag = { kind: selection.kind, id: selection.id };
    notifyInteraction();
    return true;
  }

  function updateFeatureDrag(pos: { x: number; y: number }) {
    const drag = state.featureDrag;
    if (!drag || !onFeatureMoved) {
      return;
    }
    const location = resolveFeatureLatLon(pos);
    if (!location) {
      return;
    }
    onFeatureMoved({ kind: drag.kind, id: drag.id, location });
  }

  function endFeatureDrag() {
    if (!state.featureDrag) {
      return;
    }
    state.featureDrag = null;
    notifyInteraction();
  }

  function deleteSelectedShapeVertex() {
    const { shapeId, pointIndex } = state.shapeEdit;
    if (!shapeId || pointIndex === null) {
      return;
    }
    const target = state.shapes.find((shape) => shape.id === shapeId);
    if (!target || target.kind !== "polygon") {
      return;
    }
    if (target.points.length <= 3) {
      return;
    }
    target.points.splice(pointIndex, 1);
    const nextIndex = Math.min(pointIndex, target.points.length - 1);
    state.shapeEdit = { shapeId, pointIndex: nextIndex };
    state.shapeVertexDrag = null;
    notifyShapes();
    redraw();
  }

  function beginPan(ev: MouseEvent) {
    updatePointer(null);
    const canvasPoint = getCanvasPoint(canvas, ev);
    state.panDrag = {
      startCanvas: canvasPoint,
      startOffset: { x: state.view.offsetX, y: state.view.offsetY }
    };
  }

  function updatePanDrag(ev: MouseEvent) {
    const pan = state.panDrag;
    if (!pan) {
      return;
    }
    notifyInteraction();
    const canvasPoint = getCanvasPoint(canvas, ev);
    const dx = canvasPoint.x - pan.startCanvas.x;
    const dy = canvasPoint.y - pan.startCanvas.y;
    state.view.offsetX = pan.startOffset.x + dx;
    state.view.offsetY = pan.startOffset.y + dy;
    redraw();
  }

  function endPan() {
    state.panDrag = null;
  }

  function handleWheel(ev: WheelEvent) {
    ev.preventDefault();
    notifyInteraction();
    const canvasPoint = getCanvasPoint(canvas, ev);
    let changed = false;
    if (ev.ctrlKey || ev.metaKey) {
      const scaleFactor = Math.exp(-ev.deltaY * 0.002);
      changed = applyZoomAt(canvasPoint, scaleFactor);
    } else {
      state.view.offsetX -= ev.deltaX;
      state.view.offsetY -= ev.deltaY;
      changed = true;
    }
    if (changed) {
      redraw();
    }
  }

  function applyZoomAt(canvasPoint: { x: number; y: number }, zoomFactor: number): boolean {
    const worldBefore = canvasToWorld(canvasPoint.x, canvasPoint.y, state);
    const newScale = clampValue(
      state.view.scale * zoomFactor,
      state.view.minScale,
      state.view.maxScale
    );
    if (Math.abs(newScale - state.view.scale) < 1e-4) {
      return false;
    }
    state.view.scale = newScale;
    recenterViewOnWorld(canvasPoint, worldBefore);
    return true;
  }

  function recenterViewOnWorld(
    canvasPoint: { x: number; y: number },
    worldPoint: { x: number; y: number }
  ) {
    const appliedScale = state.view.scale * state.view.baseScale;
    state.view.offsetX = canvasPoint.x - worldPoint.x * appliedScale;
    state.view.offsetY = canvasPoint.y - worldPoint.y * appliedScale;
  }

  canvas.addEventListener("mousedown", handleMouseDown);
  canvas.addEventListener("mousemove", handleMouseMove);
  canvas.addEventListener("mouseup", handleMouseUp);
  canvas.addEventListener("mouseleave", handleMouseLeave);
  canvas.addEventListener("dblclick", handleDoubleClick);
  canvas.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("keydown", handleKeyDown);

  function nextShapeName(type: ZoneType): string {
    const used = new Set(
      state.shapes.map((shape) => shape.name?.trim()).filter((name) => name)
    );
    let index = state.shapes.filter((shape) => shape.type === type).length + 1;
    let name = defaultShapeName(type, index);
    while (used.has(name)) {
      index += 1;
      name = defaultShapeName(type, index);
    }
    return name;
  }

  function normalizeIncomingShapes(shapes: Shape[]): Shape[] {
    const nameCounts: Record<ZoneType, number> = {
      obstacle: 0,
      candidate: 0,
      viewer: 0
    };
    return shapes.map((shape) => {
      const normalized = prepareIncomingShape(shape);
      const id =
        typeof normalized.id === "string" && normalized.id.trim() ? normalized.id : createId();
      const type = normalized.type;
      const nameCount = (nameCounts[type] ?? 0) + 1;
      nameCounts[type] = nameCount;
      const name = normalizeShapeName(normalized.name, defaultShapeName(type, nameCount));
      const color = normalizeShapeColor(normalized.color);
      const visible = normalized.visible !== false;
      return { ...normalized, id, name, color, visible };
    });
  }

  function commitDragShape() {
    const drag = state.dragState;
    state.dragState = null;
    if (!drag) {
      return;
    }
    if (drag.kind === "tree") {
      commitTreeLabel(drag);
      return;
    }
    const width = drag.current.x - drag.start.x;
    const height = drag.current.y - drag.start.y;
    if (Math.abs(width) < 2 || Math.abs(height) < 2) {
      redraw();
      return;
    }
    const x = width < 0 ? drag.current.x : drag.start.x;
    const y = height < 0 ? drag.current.y : drag.start.y;
    const shape = createEllipseShape(
      drag.zone,
      x,
      y,
      Math.abs(width),
      Math.abs(height),
      nextShapeName(drag.zone)
    );
    state.shapes.push(prepareIncomingShape(shape));
    notifyShapes();
    redraw();
  }

  function commitTreeLabel(drag: TreeLabelDragState) {
    if (!onFeaturePlaced) {
      redraw();
      return;
    }
    const center = resolveFeatureLatLon(drag.start);
    if (!center) {
      redraw();
      return;
    }
    const edge = resolveFeatureLatLon(drag.current);
    let radiusMeters: number | null = null;
    if (edge) {
      const meters = haversineMeters(center.lat, center.lon, edge.lat, edge.lon);
      if (Number.isFinite(meters) && meters > 0.05) {
        radiusMeters = meters;
      }
    }
    onFeaturePlaced({
      kind: "tree",
      location: center,
      treeType: drag.treeType,
      radiusMeters: radiusMeters ?? undefined
    });
    notifyInteraction();
    redraw();
  }

  function setSelectedShapeId(nextId: string | null, shouldNotify = true) {
    if (state.selectedShapeId === nextId) {
      return;
    }
    if (state.activeViewerEditId && state.activeViewerEditId !== nextId) {
      finishViewerConeEdit(shouldNotify);
    }
    state.selectedShapeId = nextId;
    state.shapeEdit = { shapeId: nextId, pointIndex: null };
    state.shapeVertexDrag = null;
    if (!state.inspectMode && state.selectedFeature) {
      setSelectedFeature(null, shouldNotify);
    }
    notifyShapeSelection(shouldNotify);
  }

  function selectShapeAt(pos: { x: number; y: number }): Shape | null {
    const target = hitTest(pos, state.shapes, state.visibilityFilter);
    setSelectedShapeId(target?.id ?? null);
    if (!target || target.type !== "viewer") {
      state.activeViewerEditId = null;
    }
    return target ?? null;
  }

  function hitTestShapeVertex(
    pos: { x: number; y: number }
  ): { shape: Shape; pointIndex: number } | null {
    for (let i = state.shapes.length - 1; i >= 0; i -= 1) {
      const shape = state.shapes[i];
      if (!state.visibilityFilter[shape.type] || shape.visible === false) {
        continue;
      }
      if (shape.kind !== "polygon") {
        continue;
      }
      for (let j = 0; j < shape.points.length; j += 1) {
        if (isPointNear(shape.points[j], pos, SHAPE_VERTEX_HIT_RADIUS)) {
          return { shape, pointIndex: j };
        }
      }
    }
    return null;
  }

  function setSelectedRoadId(nextId: string | null, shouldNotify = true) {
    if (state.selectedRoadId === nextId) {
      return;
    }
    state.selectedRoadId = nextId;
    if (nextId) {
      setSelectedShapeId(null, shouldNotify);
    }
    state.roadEdit.selectedPointIndex = null;
    state.roadEdit.drag = null;
    notifyRoadEditSelection(shouldNotify);
    if (shouldNotify) {
      notifyRoadSelection();
    }
    if (!state.inspectMode && state.selectedFeature) {
      setSelectedFeature(null, shouldNotify);
    }
  }

  function setSelectedFeature(next: FeatureSelection | null, shouldNotify = true) {
    const current = state.selectedFeature;
    if (current?.id === next?.id && current?.kind === next?.kind) {
      return;
    }
    state.selectedFeature = next ? { ...next } : null;
    notifyFeatureSelection(shouldNotify);
  }

  function findRoadById(id: string | null): { road: Road; source: "auto" | "custom" } | null {
    if (!id) {
      return null;
    }
    const auto = state.autoRoads.find((road) => road.id === id);
    if (auto) {
      return { road: auto, source: "auto" };
    }
    const custom = state.customRoads.find((road) => road.id === id);
    if (custom) {
      return { road: custom, source: "custom" };
    }
    return null;
  }

  function findCustomRoadIndex(id: string): number {
    return state.customRoads.findIndex((road) => road.id === id);
  }

  function pointNearBounds(point: RoadRenderPoint, bounds: RoadBounds, padding: number): boolean {
    return (
      point.x >= bounds.minX - padding &&
      point.x <= bounds.maxX + padding &&
      point.y >= bounds.minY - padding &&
      point.y <= bounds.maxY + padding
    );
  }

  function hitTestRoad(
    point: RoadRenderPoint,
    threshold: number,
    includeAuto: boolean
  ): { road: RoadRenderCache; hit: PolylineHit } | null {
    let best: { road: RoadRenderCache; hit: PolylineHit } | null = null;
    let bestDistance = threshold;
    const pools = includeAuto
      ? [state.customRoadRender, state.autoRoadRender]
      : [state.customRoadRender];
    for (const roads of pools) {
      for (const road of roads) {
        if (!road.bounds) {
          continue;
        }
        if (!pointNearBounds(point, road.bounds, threshold)) {
          continue;
        }
        const hit = distanceToPolyline(point, road.renderPoints);
        if (!hit) {
          continue;
        }
        if (hit.distance <= bestDistance) {
          bestDistance = hit.distance;
          best = { road, hit };
        }
      }
    }
    return best;
  }

  function selectRoadAt(point: RoadRenderPoint, includeAuto: boolean): RoadRenderCache | null {
    const hit = hitTestRoad(point, ROAD_SELECT_RADIUS, includeAuto);
    if (hit) {
      setSelectedRoadId(hit.road.id);
      return hit.road;
    }
    setSelectedRoadId(null);
    return null;
  }

  function hitTestBuilding(point: RoadRenderPoint): BuildingRenderCache | null {
    for (let i = state.buildingRender.length - 1; i >= 0; i -= 1) {
      const building = state.buildingRender[i];
      if (building.bounds && !pointNearBounds(point, building.bounds, 4)) {
        continue;
      }
      if (pointInPolygon(point, building.points)) {
        return building;
      }
    }
    return null;
  }

  function hitTestCandidateShape(point: RoadRenderPoint): Shape | null {
    for (let i = state.shapes.length - 1; i >= 0; i -= 1) {
      const shape = state.shapes[i];
      if (shape.type !== "candidate") {
        continue;
      }
      if (!state.visibilityFilter[shape.type] || shape.visible === false) {
        continue;
      }
      if (pointInShape(point, shape)) {
        return shape;
      }
    }
    return null;
  }

  function resolveFeaturePoint(
    location: { lat: number; lon: number },
    render?: { x: number; y: number }
  ): RoadRenderPoint | null {
    if (render) {
      return { x: render.x, y: render.y };
    }
    const projector = state.geoProjector ?? state.geoMapper;
    if (!projector) {
      return null;
    }
    return projector.latLonToPixel(location.lat, location.lon);
  }

  function resolveFeatureLatLon(point: RoadRenderPoint): GeoPoint | null {
    const projector = state.geoProjector ?? state.geoMapper;
    if (!projector) {
      return null;
    }
    return projector.pixelToLatLon(point.x, point.y);
  }

  function hitTestPointFeature<T extends { id: string; location: { lat: number; lon: number }; render?: { x: number; y: number } }>(
    point: RoadRenderPoint,
    features: T[]
  ): T | null {
    for (let i = features.length - 1; i >= 0; i -= 1) {
      const feature = features[i];
      const featurePoint = resolveFeaturePoint(feature.location, feature.render);
      if (!featurePoint) {
        continue;
      }
      if (Math.hypot(featurePoint.x - point.x, featurePoint.y - point.y) <= POINT_FEATURE_HIT_RADIUS) {
        return feature;
      }
    }
    return null;
  }

  function selectFeatureAt(point: RoadRenderPoint): FeatureSelection | null {
    let selection: FeatureSelection | null = null;
    if (state.layerVisibility.buildings) {
      const building = hitTestBuilding(point);
      if (building) {
        selection = { kind: "building", id: building.id };
      }
    }
    if (!selection && state.layerVisibility.roads) {
      const roadHit = hitTestRoad(point, ROAD_SELECT_RADIUS, true);
      if (roadHit) {
        selection = { kind: "road", id: roadHit.road.id };
      }
    }
    if (!selection && state.layerVisibility.trees && state.worldModel) {
      const tree = hitTestPointFeature(point, state.worldModel.trees);
      if (tree) {
        selection = { kind: "tree", id: tree.id };
      }
    }
    if (!selection && state.layerVisibility.signs && state.worldModel) {
      const sign = hitTestPointFeature(point, state.worldModel.signs);
      if (sign) {
        selection = { kind: "sign", id: sign.id };
      }
    }
    if (!selection && state.layerVisibility.traffic && state.worldModel) {
      const signal = hitTestPointFeature(point, state.worldModel.trafficSignals);
      if (signal) {
        selection = { kind: "traffic_signal", id: signal.id };
      }
    }
    if (!selection && state.layerVisibility.candidates) {
      const candidate = hitTestCandidateShape(point);
      if (candidate) {
        selection = { kind: "candidate", id: candidate.id };
      }
    }

    if (selection?.kind === "road") {
      setSelectedRoadId(selection.id);
      setSelectedShapeId(null);
    } else if (selection?.kind === "candidate") {
      setSelectedRoadId(null);
      setSelectedShapeId(selection.id);
    } else {
      setSelectedRoadId(null);
      setSelectedShapeId(null);
    }
    setSelectedFeature(selection);
    return selection;
  }

  function resolveMapPoint(
    point: MapPoint,
    projector: GeoProjector | null,
    mapper: GeoMapper | null
  ): RoadRenderPoint | null {
    if ("x" in point && "y" in point) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return null;
      }
      return { x: point.x, y: point.y };
    }
    if ("lat" in point && "lon" in point) {
      const source = projector ?? mapper;
      if (!source) {
        return null;
      }
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
        return null;
      }
      return source.latLonToPixel(point.lat, point.lon);
    }
    return null;
  }

  function mapPoints(points: MapPoint[]): RoadRenderPoint[] {
    const mapped: RoadRenderPoint[] = [];
    for (const point of points) {
      const resolved = resolveMapPoint(point, state.geoProjector, state.geoMapper);
      if (resolved) {
        mapped.push(resolved);
      }
    }
    return mapped;
  }

  function roadUsesGeo(road: Road): boolean {
    const sample = road.points[0];
    return !!sample && "lat" in sample && "lon" in sample;
  }

  function pixelToRoadPoint(pixel: RoadRenderPoint, road: Road): MapPoint | null {
    if (roadUsesGeo(road)) {
      const projector = state.geoProjector ?? state.geoMapper;
      if (!projector) {
        return null;
      }
      const { lat, lon } = projector.pixelToLatLon(pixel.x, pixel.y);
      return { lat, lon };
    }
    return { x: pixel.x, y: pixel.y };
  }

  function buildRoadRenderCache(road: Road, source: "auto" | "custom"): RoadRenderCache | null {
    const controlPoints = mapPoints(road.points);
    if (controlPoints.length < 2) {
      return null;
    }
    const renderPoints = catmullRomSpline(controlPoints, ROAD_CURVE_SAMPLES);
    const directionOverride = road.directionLine ? mapPoints(road.directionLine) : [];
    const directionSource = directionOverride.length >= 2 ? directionOverride : controlPoints;
    const directionPoints =
      directionSource.length >= 2
        ? catmullRomSpline(directionSource, ROAD_DIRECTION_SAMPLES)
        : null;
    const bounds = computeBounds(renderPoints);
    const laneCounts = resolveLaneCounts(road);
    return {
      id: road.id,
      source,
      controlPoints,
      renderPoints,
      directionPoints,
      bounds,
      arrowSamples: samplePolyline(renderPoints, ROAD_ARROW_SPACING),
      flowSamples: samplePolyline(renderPoints, ROAD_FLOW_SPACING),
      showDirectionLine: !!road.showDirectionLine,
      roadClass: road.class,
      laneCounts,
      oneway: road.oneway
    };
  }

  function adaptWorldRoadFeature(feature: WorldModel["roads"][number]): Road {
    return {
      id: feature.id,
      points: feature.geometry.points,
      class: feature.class,
      oneway: feature.oneway,
      lanes: feature.lanes,
      lanesForward: feature.lanesForward,
      lanesBackward: feature.lanesBackward,
      lanesInferred: feature.lanesInferred,
      name: feature.name,
      showDirectionLine: false,
      source: feature.source
    };
  }

  function rebuildRoadCaches() {
    const autoRender: RoadRenderCache[] = [];
    const customRender: RoadRenderCache[] = [];
    const index: Record<string, RoadRenderCache> = {};
    if (state.worldModel) {
      for (const feature of state.worldModel.roads) {
        const road = adaptWorldRoadFeature(feature);
        const render = buildRoadRenderCache(road, "auto");
        if (render) {
          autoRender.push(render);
          index[render.id] = render;
        }
      }
    } else {
      for (const road of state.autoRoads) {
        const render = buildRoadRenderCache(road, "auto");
        if (render) {
          autoRender.push(render);
          index[render.id] = render;
        }
      }
      for (const road of state.customRoads) {
        const render = buildRoadRenderCache(road, "custom");
        if (render) {
          customRender.push(render);
          index[render.id] = render;
        }
      }
    }
    state.autoRoadRender = autoRender;
    state.customRoadRender = customRender;
    state.roadRenderIndex = index;
    rebuildTrafficPreviewPlans();
  }

  function rebuildTrafficPreviewPlans() {
    if (!state.trafficPreview.active) {
      return;
    }
    const plans = new Map<string, TrafficPreviewPlan[]>();
    const flowScale = flowDensityMultiplier(state.trafficViewState.flowDensity);
    const coverage = clampValue(0.35 * flowScale, 0.2, 0.6);
    const roads = [...state.autoRoadRender, ...state.customRoadRender];
    for (const road of roads) {
      if (road.flowSamples.length === 0) {
        continue;
      }
      const pick = hashUnit(`${road.id}:select`, state.trafficPreview.seed);
      if (pick > coverage) {
        continue;
      }
      const roadPlans = buildTrafficPreviewPlans(road, state.trafficPreview.seed, flowScale);
      if (roadPlans.length) {
        plans.set(road.id, roadPlans);
      }
    }
    state.trafficPreview.plans = plans;
  }

  function updateCustomRoadCache(roadId: string) {
    const road = state.customRoads.find((item) => item.id === roadId);
    if (!road) {
      return;
    }
    const render = buildRoadRenderCache(road, "custom");
    const index = state.customRoadRender.findIndex((item) => item.id === roadId);
    if (render) {
      if (index >= 0) {
        state.customRoadRender[index] = render;
      } else {
        state.customRoadRender.push(render);
      }
      state.roadRenderIndex[roadId] = render;
    } else if (index >= 0) {
      state.customRoadRender.splice(index, 1);
      delete state.roadRenderIndex[roadId];
    }
    rebuildTrafficPreviewPlans();
  }

  function resolveBuildingHeightM(building: Building): number {
    return resolveBuildingHeightInfo(building).effectiveHeightMeters;
  }

  function rebuildBuildingCaches() {
    const render: BuildingRenderCache[] = [];
    if (state.worldModel) {
      for (const building of state.worldModel.buildings) {
        const points =
          building.render?.map((point) => ({ x: point.x, y: point.y })) ??
          mapPoints(building.footprint);
        if (points.length < 3) {
          continue;
        }
        const heightM = building.height.effectiveHeightMeters;
        const bounds = computeBounds(points);
        const center = bounds
          ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
          : null;
        render.push({
          id: building.id,
          points,
          bounds,
          center,
          heightM
        });
      }
    } else {
      for (const building of state.buildings) {
        const points = mapPoints(building.footprint);
        if (points.length < 3) {
          continue;
        }
        const heightM = resolveBuildingHeightM(building);
        const bounds = computeBounds(points);
        const center = bounds
          ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
          : null;
        render.push({
          id: building.id,
          points,
          bounds,
          center,
          heightM
        });
      }
    }
    state.buildingRender = render;
  }

  function syncRoadSelection() {
    if (!state.selectedRoadId) {
      return;
    }
    if (!state.roadRenderIndex[state.selectedRoadId]) {
      setSelectedRoadId(null);
    }
  }

  function getShapeById(id: string | null): Shape | undefined {
    if (!id) {
      return undefined;
    }
    return state.shapes.find((shape) => shape.id === id);
  }

  function getSelectedShape(): Shape | undefined {
    return getShapeById(state.selectedShapeId);
  }

  function updateDirectionDragPosition(pos: { x: number; y: number }, finalize: boolean) {
    const drag = state.directionDrag;
    if (!drag) {
      return;
    }
    const target = state.shapes.find((shape) => shape.id === drag.shapeId);
    if (!target || target.type !== "viewer") {
      finishViewerConeEdit(false);
      return;
    }
    notifyInteraction();
    const dx = pos.x - drag.anchor.x;
    const dy = pos.y - drag.anchor.y;
    const length = Math.hypot(dx, dy);
    if (length < SNAP_RADIUS) {
      if (drag.hasMoved) {
        target.direction = undefined;
        redraw();
      }
      if (finalize) {
        finishViewerConeEdit(true);
      }
      return;
    }
    drag.hasMoved = true;
    const angle = Math.atan2(dy, dx);
    const distance = clampValue(length, HANDLE_MIN_DISTANCE, HANDLE_MAX_DISTANCE);
    const normalized = (distance - HANDLE_MIN_DISTANCE) / (HANDLE_MAX_DISTANCE - HANDLE_MIN_DISTANCE || 1);
    const coneRange = MAX_CONE_RAD - MIN_CONE_RAD;
    const cone = clampValue(MAX_CONE_RAD - normalized * coneRange, MIN_CONE_RAD, MAX_CONE_RAD);
    target.direction = {
      angleRad: angle,
      coneRad: cone
    };
    redraw();
    if (finalize) {
      finishViewerConeEdit(true);
    }
  }

  function eraseShapeAt(pos: { x: number; y: number }): boolean {
    const target = hitTest(pos, state.shapes, state.visibilityFilter);
    if (!target) {
      return false;
    }
    state.shapes = state.shapes.filter((shape) => shape.id !== target.id);
    setSelectedShapeId(null);
    if (state.directionDrag?.shapeId === target.id) {
      finishViewerConeEdit(false);
    }
    return true;
  }

  function eraseDenseCoverAt(pos: { x: number; y: number }): boolean {
    const denseCover = state.worldModel?.denseCover ?? [];
    if (denseCover.length === 0) {
      return false;
    }
    const projector = state.geoProjector ?? state.geoMapper;
    for (let i = denseCover.length - 1; i >= 0; i -= 1) {
      const feature = denseCover[i];
      const points =
        feature.render?.map((point) => ({ x: point.x, y: point.y })) ??
        (projector
          ? feature.polygon.map((point) => projector.latLonToPixel(point.lat, point.lon))
          : null);
      if (!points || points.length < 3) {
        continue;
      }
      if (pointInPolygon(pos, points)) {
        onDenseCoverDeleted?.(feature.id);
        return true;
      }
    }
    return false;
  }

  function extendPolygon(
    point: { x: number; y: number },
    info: { mode: PolygonDraftMode; zone?: ZoneType }
  ) {
    if (
      !state.polygonDraft ||
      state.polygonDraft.mode !== info.mode ||
      state.polygonDraft.zone !== info.zone
    ) {
      state.polygonDraft = {
        mode: info.mode,
        zone: info.zone,
        points: []
      };
    }
    state.polygonDraft.points.push(point);
  }

  function maybeClosePolygon(
    point: { x: number; y: number },
    info: { mode: PolygonDraftMode; zone?: ZoneType }
  ): boolean {
    const poly = state.polygonDraft;
    if (
      !poly ||
      poly.mode !== info.mode ||
      poly.zone !== info.zone ||
      poly.points.length < 3
    ) {
      return false;
    }
    const first = poly.points[0];
    if (isPointNear(first, point, POLYGON_CLOSE_RADIUS)) {
      finalizePolygon();
      return true;
    }
    return false;
  }

  function finalizePolygon() {
    const poly = state.polygonDraft;
    if (!poly || poly.points.length < 3) {
      state.polygonDraft = null;
      redraw();
      return;
    }
    if (poly.mode === "dense_cover") {
      const projector = state.geoProjector ?? state.geoMapper;
      if (projector) {
        const polygon = poly.points.map((point) => projector.pixelToLatLon(point.x, point.y));
        onDenseCoverCreated?.({ polygon, density: state.denseCoverDensity });
      }
      state.polygonDraft = null;
      redraw();
      return;
    }
    if (!poly.zone) {
      state.polygonDraft = null;
      redraw();
      return;
    }
    const shape: Shape = {
      id: createId(),
      name: nextShapeName(poly.zone),
      kind: "polygon",
      type: poly.zone,
      alpha: zoneAlpha(poly.zone),
      visible: true,
      points: poly.points.slice()
    };
    state.shapes.push(prepareIncomingShape(shape));
    state.polygonDraft = null;
    notifyShapes();
    redraw();
  }

  function startRoadDraft(point: RoadRenderPoint) {
    const projector = state.geoProjector ?? state.geoMapper;
    state.roadEdit.draft = {
      points: [point],
      storeMode: projector ? "geo" : "pixel"
    };
    state.roadEdit.selectedPointIndex = null;
    notifyRoadEditSelection();
  }

  function appendRoadDraftPoint(point: RoadRenderPoint) {
    if (!state.roadEdit.draft) {
      startRoadDraft(point);
      return;
    }
    state.roadEdit.draft.points.push(point);
  }

  function finalizeRoadDraft() {
    const draft = state.roadEdit.draft;
    if (!draft || draft.points.length < 2) {
      state.roadEdit.draft = null;
      redraw();
      return;
    }
    const projector = state.geoProjector ?? state.geoMapper;
    const points: MapPoint[] =
      draft.storeMode === "geo" && projector
        ? draft.points.map((p) => {
            const { lat, lon } = projector.pixelToLatLon(p.x, p.y);
            return { lat, lon };
          })
        : draft.points.map((p) => ({ x: p.x, y: p.y }));
    const road: Road = {
      id: createId(),
      points,
      showDirectionLine: false
    };
    state.customRoads.push(road);
    state.customRoadsDirty = true;
    state.roadEdit.draft = null;
    rebuildRoadCaches();
    setSelectedRoadId(road.id);
    redraw();
  }

  function cancelRoadDraft() {
    if (!state.roadEdit.draft) {
      return;
    }
    state.roadEdit.draft = null;
    notifyRoadEditSelection();
    redraw();
  }

  function hitTestRoadControlPoint(
    point: RoadRenderPoint
  ): { roadId: string; pointIndex: number } | null {
    let best: { roadId: string; pointIndex: number } | null = null;
    let bestDistSq = ROAD_CONTROL_RADIUS * ROAD_CONTROL_RADIUS;
    for (const road of state.customRoadRender) {
      for (let i = 0; i < road.controlPoints.length; i += 1) {
        const control = road.controlPoints[i];
        const dx = control.x - point.x;
        const dy = control.y - point.y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= bestDistSq) {
          bestDistSq = distSq;
          best = { roadId: road.id, pointIndex: i };
        }
      }
    }
    return best;
  }

  function beginRoadDrag(roadId: string, pointIndex: number) {
    state.roadEdit.drag = { roadId, pointIndex };
    state.roadEdit.selectedPointIndex = pointIndex;
    notifyRoadEditSelection();
  }

  function updateRoadDrag(point: RoadRenderPoint) {
    const drag = state.roadEdit.drag;
    if (!drag) {
      return;
    }
    const index = findCustomRoadIndex(drag.roadId);
    if (index < 0) {
      return;
    }
    const road = state.customRoads[index];
    const nextPoint = pixelToRoadPoint(point, road);
    if (!nextPoint) {
      return;
    }
    road.points[drag.pointIndex] = nextPoint;
    state.customRoadsDirty = true;
    updateCustomRoadCache(road.id);
    redraw();
  }

  function endRoadDrag() {
    if (!state.roadEdit.drag) {
      return;
    }
    state.roadEdit.drag = null;
  }

  function insertPointOnSelectedRoad(point: RoadRenderPoint): boolean {
    const roadId = state.selectedRoadId;
    if (!roadId) {
      return false;
    }
    const render = state.roadRenderIndex[roadId];
    if (!render || render.source !== "custom") {
      return false;
    }
    const hit = distanceToPolyline(point, render.controlPoints);
    if (!hit || hit.distance > ROAD_INSERT_RADIUS) {
      return false;
    }
    const index = findCustomRoadIndex(roadId);
    if (index < 0) {
      return false;
    }
    const road = state.customRoads[index];
    const insertPoint = pixelToRoadPoint(hit.closest, road);
    if (!insertPoint) {
      return false;
    }
    road.points.splice(hit.segmentIndex + 1, 0, insertPoint);
    state.customRoadsDirty = true;
    updateCustomRoadCache(roadId);
    beginRoadDrag(roadId, hit.segmentIndex + 1);
    redraw();
    return true;
  }

  function deleteSelectedRoadPoint() {
    const roadId = state.selectedRoadId;
    const pointIndex = state.roadEdit.selectedPointIndex;
    if (!roadId || pointIndex === null) {
      return;
    }
    const index = findCustomRoadIndex(roadId);
    if (index < 0) {
      return;
    }
    const road = state.customRoads[index];
    if (road.points.length <= 2) {
      return;
    }
    if (pointIndex < 0 || pointIndex >= road.points.length) {
      return;
    }
    road.points.splice(pointIndex, 1);
    state.customRoadsDirty = true;
    const nextIndex = Math.min(pointIndex, road.points.length - 1);
    state.roadEdit.selectedPointIndex = nextIndex;
    updateCustomRoadCache(roadId);
    notifyRoadEditSelection();
    redraw();
  }

  function handleRoadMouseDown(point: RoadRenderPoint) {
    if (state.roadEdit.draft) {
      appendRoadDraftPoint(point);
      redraw();
      return;
    }
    const controlHit = hitTestRoadControlPoint(point);
    if (controlHit) {
      setSelectedRoadId(controlHit.roadId);
      setSelectedShapeId(null);
      beginRoadDrag(controlHit.roadId, controlHit.pointIndex);
      redraw();
      return;
    }
    if (insertPointOnSelectedRoad(point)) {
      setSelectedShapeId(null);
      return;
    }
    const road = selectRoadAt(point, true);
    if (road) {
      setSelectedShapeId(null);
      redraw();
      return;
    }
    setSelectedRoadId(null);
    setSelectedShapeId(null);
    startRoadDraft(point);
    redraw();
  }

  const api: DrawingManager = {
    getShapes() {
      return state.shapes.slice();
    },
    setShapes(shapes: Shape[]) {
      const normalized = normalizeIncomingShapes(shapes);
      state.shapes = normalized;
      state.shapeVertexDrag = null;
      if (state.selectedShapeId && !normalized.some((shape) => shape.id === state.selectedShapeId)) {
        setSelectedShapeId(null);
      } else {
        state.shapeEdit = { shapeId: state.selectedShapeId, pointIndex: null };
      }
      state.polygonDraft = null;
      if (state.directionDrag || state.activeViewerEditId) {
        finishViewerConeEdit(false);
      }
      notifyShapes();
      redraw();
    },
    clearShapes() {
      state.shapes = [];
      setSelectedShapeId(null);
      state.polygonDraft = null;
      if (state.directionDrag || state.activeViewerEditId) {
        finishViewerConeEdit(false);
      }
      notifyShapes();
      redraw();
    },
    getTool() {
      return state.currentTool;
    },
    setTool(tool: ToolMode) {
      state.currentTool = tool;
      setSelectedShapeId(null);
      state.polygonDraft = null;
      if (state.directionDrag || state.activeViewerEditId) {
        finishViewerConeEdit(false);
      }
      redraw();
    },
    getRoadToolMode() {
      return state.roadToolMode;
    },
    setRoadToolMode(mode: RoadToolMode) {
      if (state.roadToolMode === mode) {
        return;
      }
      state.roadToolMode = mode;
      if (mode === "off") {
        state.roadEdit = { draft: null, drag: null, selectedPointIndex: null };
        notifyRoadEditSelection();
      } else {
        state.polygonDraft = null;
      }
      redraw();
    },
    setBaseImage(nextImage: BaseImage, options?: { resetView?: boolean }) {
      baseImage = nextImage;
      baseWidth = nextImage.width;
      baseHeight = nextImage.height;
      if (options?.resetView) {
        state.view.scale = 1;
        state.view.offsetX = 0;
        state.view.offsetY = 0;
      }
      rebuildRoadCaches();
      rebuildBuildingCaches();
      syncRoadSelection();
      resizeCanvas();
    },
    setMapStylePreset(preset: MapStylePreset) {
      if (state.mapStylePreset === preset) {
        return;
      }
      state.mapStylePreset = preset;
      redraw();
    },
    setGeoProjector(projector: GeoProjector | null) {
      state.geoProjector = projector;
      rebuildRoadCaches();
      rebuildBuildingCaches();
      syncRoadSelection();
      redraw();
    },
    setGeoMapper(mapper: GeoMapper | null) {
      state.geoMapper = mapper;
      rebuildRoadCaches();
      rebuildBuildingCaches();
      syncRoadSelection();
      redraw();
    },
    setDebugHudData(data: DebugHudData) {
      state.debugHud = { ...data };
      redraw();
    },
    setHeatmap(cells: HeatmapCell[] | null, cellSize: number) {
      if (cells && cells.length > 0) {
        state.heatmapData = { cells, cellSize };
        state.heatmapCellSize = cellSize;
        state.bestHeatmapCell = cells.reduce(
          (best, cell) => (!best || cell.score > best.score ? cell : best),
          cells[0]
        );
        state.heatmapBitmap = renderHeatmapBitmap(
          cells,
          cellSize,
          state.heatmapOpacity,
          baseWidth,
          baseHeight
        );
      } else {
        state.heatmapData = null;
        state.bestHeatmapCell = null;
        state.heatmapBitmap = null;
      }
      redraw();
    },
    clearHeatmap() {
      state.heatmapData = null;
      state.heatmapBitmap = null;
      state.bestHeatmapCell = null;
      redraw();
    },
    setHeatmapOpacity(value: number) {
      state.heatmapOpacity = value;
      if (state.heatmapData) {
        state.heatmapBitmap = renderHeatmapBitmap(
          state.heatmapData.cells,
          state.heatmapData.cellSize,
          state.heatmapOpacity,
          baseWidth,
          baseHeight
        );
      }
      redraw();
    },
    setZoneOpacity(zone: ZoneType, alpha: number) {
      state.zoneOpacity[zone] = alpha;
      redraw();
    },
    setZoneVisibility(zone: ZoneType, visible: boolean) {
      state.visibilityFilter[zone] = visible;
      redraw();
    },
    setShading(cells: HeatmapCell[] | null, cellSize: number) {
      if (cells && cells.length > 0) {
        state.shadingData = { cells, cellSize };
        state.shadingCellSize = cellSize;
        state.shadingBitmap = renderShadingBitmap(
          cells,
          cellSize,
          state.shadingOpacity,
          baseWidth,
          baseHeight
        );
      } else {
        state.shadingData = null;
        state.shadingBitmap = null;
      }
      redraw();
    },
    setShadingOpacity(value: number) {
      state.shadingOpacity = value;
      if (state.shadingData) {
        state.shadingBitmap = renderShadingBitmap(
          state.shadingData.cells,
          state.shadingData.cellSize,
          state.shadingOpacity,
          baseWidth,
          baseHeight
        );
      }
      redraw();
    },
    setContours(segments: ContourSegment[] | null) {
      state.contours = segments;
      redraw();
    },
    setShowContours(value: boolean) {
      state.showContours = value;
      redraw();
    },
    setContourOpacity(value: number) {
      state.contourOpacity = value;
      redraw();
    },
    setDenseCoverDensity(value: number) {
      state.denseCoverDensity = clampValue(value, 0, 1);
    },
    setRoadData(data: { autoRoads: Road[]; customRoads: Road[] }) {
      state.autoRoads = data.autoRoads.map((road) => cloneRoad(road));
      state.customRoads = data.customRoads.map((road) => cloneRoad(road));
      state.customRoadsDirty = false;
      state.roadEdit = { draft: null, drag: null, selectedPointIndex: null };
      notifyRoadEditSelection();
      rebuildRoadCaches();
      syncRoadSelection();
      redraw();
    },
    setBuildings(buildings: Building[]) {
      state.buildings = buildings.map((building) => cloneBuilding(building));
      rebuildBuildingCaches();
      redraw();
    },
    setWorldModel(model: WorldModel | null) {
      state.worldModel = model;
      if (model?.structure?.render) {
        state.structureRender = {
          heightM: model.structure.heightMeters,
          points: model.structure.render.map((point) => ({ x: point.x, y: point.y }))
        };
      } else {
        state.structureRender = null;
      }
      rebuildRoadCaches();
      rebuildBuildingCaches();
      syncRoadSelection();
      redraw();
    },
    setWorldLayerVisibility(layer: WorldLayer, visible: boolean) {
      state.layerVisibility[layer] = visible;
      if (!visible && state.selectedFeature?.kind) {
        if (
          (layer === "roads" && state.selectedFeature.kind === "road") ||
          (layer === "buildings" && state.selectedFeature.kind === "building") ||
          (layer === "trees" && state.selectedFeature.kind === "tree") ||
          (layer === "signs" && state.selectedFeature.kind === "sign") ||
          (layer === "candidates" && state.selectedFeature.kind === "candidate") ||
          (layer === "traffic" && state.selectedFeature.kind === "traffic_signal")
        ) {
          setSelectedFeature(null);
          setSelectedRoadId(null);
          setSelectedShapeId(null);
        }
      }
      updateTrafficAnimation();
      redraw();
    },
    setInspectMode(enabled: boolean) {
      if (state.inspectMode === enabled) {
        return;
      }
      state.inspectMode = enabled;
      if (!enabled) {
        setSelectedFeature(null);
        state.featureDrag = null;
      }
      redraw();
    },
    setStructure(structure: StructureRenderData | null) {
      if (!structure) {
        state.structureRender = null;
        redraw();
        return;
      }
      const heightM = Number.isFinite(structure.heightM) ? Math.max(0, structure.heightM) : 0;
      state.structureRender = {
        heightM,
        points: structure.points.map((point) => ({ x: point.x, y: point.y }))
      };
      redraw();
    },
    setStructureOverlay(overlay: StructureOverlayData | null) {
      if (!overlay) {
        state.structureOverlay = null;
        redraw();
        return;
      }
      state.structureOverlay = {
        highlight: overlay.highlight === true,
        faceScores: overlay.faceScores ? overlay.faceScores.slice() : undefined
      };
      redraw();
    },
    setTrafficData(trafficByRoadId: TrafficByRoadId, trafficViewState: TrafficViewState) {
      state.trafficByRoadId = trafficByRoadId;
      state.trafficViewState = { ...trafficViewState };
      rebuildTrafficPreviewPlans();
      updateTrafficAnimation();
      redraw();
    },
    setTrafficEpicenters(epicenters: TrafficEpicenter[]) {
      state.trafficEpicenters = epicenters.map((epicenter) => ({
        point: { ...epicenter.point },
        weight: epicenter.weight
      }));
      redraw();
    },
    setTrafficOverlayEnabled(enabled: boolean) {
      state.trafficOverlayEnabled = enabled;
      updateTrafficAnimation();
      redraw();
    },
    setTrafficPreview(options: { active: boolean; seed?: number }) {
      state.trafficPreview.active = options.active;
      if (typeof options.seed === "number" && Number.isFinite(options.seed)) {
        state.trafficPreview.seed = options.seed;
      }
      if (state.trafficPreview.active) {
        rebuildTrafficPreviewPlans();
      } else {
        state.trafficPreview.plans = new Map();
      }
      updateTrafficAnimation();
      redraw();
    },
    setRoadDirectionOverlayEnabled(enabled: boolean) {
      state.roadDirectionOverlayEnabled = enabled;
      redraw();
    },
    setThreeDViewEnabled(enabled: boolean) {
      if (state.threeDViewEnabled === enabled) {
        return;
      }
      state.threeDViewEnabled = enabled;
      if (!enabled) {
        state.viewSpinActive = false;
        state.viewYaw = 0;
      }
      updateTrafficAnimation();
      redraw();
    },
    setViewSpinActive(active: boolean) {
      const nextActive = state.threeDViewEnabled ? active : false;
      if (state.viewSpinActive === nextActive) {
        return;
      }
      state.viewSpinActive = nextActive;
      if (!nextActive) {
        state.viewYaw = 0;
      }
      updateTrafficAnimation();
      redraw();
    },
    setModel(data: {
      autoRoads?: Road[];
      customRoads?: Road[];
      buildings?: Building[];
      trafficByRoadId?: TrafficByRoadId;
      trafficViewState?: TrafficViewState;
      geoProjector?: GeoProjector | null;
      geoMapper?: GeoMapper | null;
    }) {
      if (typeof data.geoProjector !== "undefined") {
        state.geoProjector = data.geoProjector ?? null;
      }
      if (typeof data.geoMapper !== "undefined") {
        state.geoMapper = data.geoMapper ?? null;
      }
      if (data.autoRoads || data.customRoads) {
        state.autoRoads = data.autoRoads
          ? data.autoRoads.map((road) => cloneRoad(road))
          : state.autoRoads;
        state.customRoads = data.customRoads
          ? data.customRoads.map((road) => cloneRoad(road))
          : state.customRoads;
        state.customRoadsDirty = false;
        state.roadEdit = { draft: null, drag: null, selectedPointIndex: null };
        notifyRoadEditSelection();
      }
      if (data.buildings) {
        state.buildings = data.buildings.map((building) => cloneBuilding(building));
      }
      if (data.trafficByRoadId) {
        state.trafficByRoadId = data.trafficByRoadId;
      }
      if (data.trafficViewState) {
        state.trafficViewState = { ...data.trafficViewState };
      }
      rebuildRoadCaches();
      rebuildBuildingCaches();
      syncRoadSelection();
      updateTrafficAnimation();
      redraw();
    },
    getSelectedShapeId() {
      return state.selectedShapeId;
    },
    setSelectedShapeId(id: string | null) {
      setSelectedShapeId(id);
      redraw();
    },
    focusShape(id: string, options?: { padding?: number }) {
      const shape = getShapeById(id);
      if (!shape) {
        return;
      }
      const bounds = shapeBounds(shape);
      const padding = Math.max(0, options?.padding ?? 24);
      const availableWidth = Math.max(1, canvas.width - padding * 2);
      const availableHeight = Math.max(1, canvas.height - padding * 2);
      const width = Math.max(1, bounds.maxX - bounds.minX);
      const height = Math.max(1, bounds.maxY - bounds.minY);
      const scaleX = availableWidth / width;
      const scaleY = availableHeight / height;
      state.view.scale = clampValue(
        Math.min(scaleX, scaleY) / state.view.baseScale,
        state.view.minScale,
        state.view.maxScale
      );
      const appliedScale = state.view.scale * state.view.baseScale;
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;
      state.view.offsetX = canvas.width / 2 - centerX * appliedScale;
      state.view.offsetY = canvas.height / 2 - centerY * appliedScale;
      redraw();
    },
    getSelectedRoadId() {
      return state.selectedRoadId;
    },
    setSelectedRoadId(id: string | null) {
      setSelectedRoadId(id);
      redraw();
    },
    getSelectedFeature() {
      return state.selectedFeature ? { ...state.selectedFeature } : null;
    },
    getRoadEditSelection() {
      return getRoadEditSelectionSnapshot();
    },
    getCustomRoads() {
      return state.customRoads.map((road) => cloneRoad(road));
    },
    getCustomRoadsDirty() {
      return state.customRoadsDirty;
    },
    clearCustomRoadsDirty() {
      state.customRoadsDirty = false;
    },
    redraw,
  };

  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(canvas.parentElement ?? canvas);
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  return api;

  function resizeCanvas() {
    const parent = canvas.parentElement;
    if (!parent) {
      return;
    }
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, rect.width);
    const cssHeight = Math.max(1, rect.height);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const actualWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const actualHeight = Math.max(1, Math.floor(cssHeight * dpr));
    const worldCenter = lastCanvasWidth > 0 && lastCanvasHeight > 0
      ? canvasToWorld(lastCanvasWidth / 2, lastCanvasHeight / 2, state)
      : { x: baseWidth / 2, y: baseHeight / 2 };

    canvas.width = actualWidth;
    canvas.height = actualHeight;
    lastCanvasWidth = actualWidth;
    lastCanvasHeight = actualHeight;

    const scaleToFit = Math.min(canvas.width / baseWidth, canvas.height / baseHeight);
    state.view.baseScale = scaleToFit;
    const appliedScale = state.view.scale * state.view.baseScale;
    const canvasCenterX = canvas.width / 2;
    const canvasCenterY = canvas.height / 2;
    state.view.offsetX = canvasCenterX - worldCenter.x * appliedScale;
    state.view.offsetY = canvasCenterY - worldCenter.y * appliedScale;

    redraw();
  }
}

function drawShapes(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  lockedStyle: LockedOverlayStyle | null
) {
  for (const shape of state.shapes) {
    if (!state.visibilityFilter[shape.type] || shape.visible === false) {
      continue;
    }
    if (shape.type === "candidate" && !state.layerVisibility.candidates) {
      continue;
    }
    ctx.save();
    const fillAlpha = shape.alpha * (state.zoneOpacity[shape.type] ?? 1);
    const shapeColor = typeof shape.color === "string" ? shape.color.trim() : "";
    ctx.fillStyle = shapeColor
      ? applyAlpha(shapeColor, fillAlpha)
      : zoneFill(shape.type, fillAlpha, lockedStyle);
    ctx.strokeStyle = shapeColor ? shapeColor : outlineColor(shape.type, lockedStyle);
    ctx.lineWidth = 1;

    if (shape.kind === "rect") {
      drawRectOrEllipse(ctx, shape);
    } else if (shape.kind === "ellipse") {
      drawRectOrEllipse(ctx, shape);
    } else {
      drawPolygon(ctx, shape.points);
    }

    if (shape.type === "viewer") {
      drawViewerDirectionOverlay(
        ctx,
        shape,
        state.selectedShapeId === shape.id,
        state.activeViewerEditId === shape.id,
        lockedStyle
      );
    }

    if (state.selectedShapeId === shape.id) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      if (shape.kind === "rect") {
        ctx.strokeRect(shape.x, shape.y, shape.width, shape.height);
      } else if (shape.kind === "ellipse") {
        strokeEllipse(ctx, shape.x, shape.y, shape.width, shape.height);
      } else {
        ctx.beginPath();
        shape.points.forEach((p, index) => {
          if (index === 0) {
            ctx.moveTo(p.x, p.y);
          } else {
            ctx.lineTo(p.x, p.y);
          }
        });
        ctx.closePath();
        ctx.stroke();
        const activeVertex =
          state.shapeEdit.shapeId === shape.id ? state.shapeEdit.pointIndex : null;
        shape.points.forEach((point, index) => {
          drawPolygonVertexHandle(
            ctx,
            point,
            shape.type,
            index === activeVertex,
            lockedStyle
          );
        });
      }
    }
    ctx.restore();
  }
}

interface MapRenderStyle {
  preset: MapStylePreset;
  showBaseImage: boolean;
  background: string;
  buildingFill: string;
  buildingStroke: string;
  buildingStrokeWidth: number;
  roadAutoColor: string;
  roadAutoWidth: number;
  roadCustomColor: string;
  roadCustomWidth: number;
  roadCasingColor: string | null;
  roadCasingWidth: number;
  selectedRoadColor: string;
  directionLineColor: string;
}

interface LockedOverlayStyle {
  background: string;
  buildingFill: string;
  buildingStroke: string;
  roadMajor: string;
  roadMinor: string;
  roadCasing: string;
  candidateFill: string;
  candidateStroke: string;
  obstacleFill: string;
  obstacleStroke: string;
  viewerFill: string;
  viewerStroke: string;
  trafficFlow: string;
  structureFill: string;
  structureStroke: string;
}

const LOCKED_OVERLAY_DEFAULTS: LockedOverlayStyle = {
  background: "#e7edf2",
  buildingFill: "#c7d1da",
  buildingStroke: "#aab6c2",
  roadMajor: "#fbfcfe",
  roadMinor: "#f1f4f8",
  roadCasing: "#b5bfca",
  candidateFill: "#3bb39a",
  candidateStroke: "#1f7f6c",
  obstacleFill: "#f26b5b",
  obstacleStroke: "#c24c40",
  viewerFill: "#2b7bbf",
  viewerStroke: "#1f5f94",
  trafficFlow: "#f59e0b",
  structureFill: "#7dd3fc",
  structureStroke: "#38bdf8"
};

let lockedOverlayStyleCache: LockedOverlayStyle | null = null;

function resolveLockedOverlayStyle(): LockedOverlayStyle {
  if (lockedOverlayStyleCache) {
    return lockedOverlayStyleCache;
  }
  if (typeof window === "undefined" || !window.getComputedStyle) {
    lockedOverlayStyleCache = { ...LOCKED_OVERLAY_DEFAULTS };
    return lockedOverlayStyleCache;
  }
  const computed = window.getComputedStyle(document.documentElement);
  lockedOverlayStyleCache = {
    background: readCssColor(computed, "--locked-map-bg", LOCKED_OVERLAY_DEFAULTS.background),
    buildingFill: readCssColor(
      computed,
      "--locked-buildings-fill",
      LOCKED_OVERLAY_DEFAULTS.buildingFill
    ),
    buildingStroke: readCssColor(
      computed,
      "--locked-buildings-stroke",
      LOCKED_OVERLAY_DEFAULTS.buildingStroke
    ),
    roadMajor: readCssColor(computed, "--locked-road-major", LOCKED_OVERLAY_DEFAULTS.roadMajor),
    roadMinor: readCssColor(computed, "--locked-road-minor", LOCKED_OVERLAY_DEFAULTS.roadMinor),
    roadCasing: readCssColor(
      computed,
      "--locked-road-casing",
      LOCKED_OVERLAY_DEFAULTS.roadCasing
    ),
    candidateFill: readCssColor(
      computed,
      "--locked-candidate-fill",
      LOCKED_OVERLAY_DEFAULTS.candidateFill
    ),
    candidateStroke: readCssColor(
      computed,
      "--locked-candidate-stroke",
      LOCKED_OVERLAY_DEFAULTS.candidateStroke
    ),
    obstacleFill: readCssColor(
      computed,
      "--locked-obstacle-fill",
      LOCKED_OVERLAY_DEFAULTS.obstacleFill
    ),
    obstacleStroke: readCssColor(
      computed,
      "--locked-obstacle-stroke",
      LOCKED_OVERLAY_DEFAULTS.obstacleStroke
    ),
    viewerFill: readCssColor(
      computed,
      "--locked-viewer-fill",
      LOCKED_OVERLAY_DEFAULTS.viewerFill
    ),
    viewerStroke: readCssColor(
      computed,
      "--locked-viewer-stroke",
      LOCKED_OVERLAY_DEFAULTS.viewerStroke
    ),
    trafficFlow: readCssColor(
      computed,
      "--locked-traffic-flow",
      LOCKED_OVERLAY_DEFAULTS.trafficFlow
    ),
    structureFill: readCssColor(
      computed,
      "--locked-structure-fill",
      LOCKED_OVERLAY_DEFAULTS.structureFill
    ),
    structureStroke: readCssColor(
      computed,
      "--locked-structure-stroke",
      LOCKED_OVERLAY_DEFAULTS.structureStroke
    )
  };
  return lockedOverlayStyleCache;
}

function readCssColor(
  computed: CSSStyleDeclaration,
  name: string,
  fallback: string
): string {
  const value = computed.getPropertyValue(name).trim();
  return value || fallback;
}

const SIMPLE_ROAD_WIDTH_MULTIPLIER: Record<string, number> = {
  motorway: 1.8,
  trunk: 1.7,
  primary: 1.6,
  secondary: 1.4,
  tertiary: 1.3,
  residential: 1.15,
  unclassified: 1.1,
  living_street: 1.05,
  service: 1.0,
  motorway_link: 1.5,
  trunk_link: 1.45,
  primary_link: 1.4,
  secondary_link: 1.3,
  tertiary_link: 1.2,
  track: 0.9,
  path: 0.8,
  footway: 0.75,
  cycleway: 0.75,
  pedestrian: 0.8,
  construction: 1.0,
  other: 1.0
};

const LOCKED_ROAD_WIDTH_MULTIPLIER: Record<string, number> = {
  motorway: 2.1,
  trunk: 2.0,
  primary: 1.8,
  secondary: 1.6,
  tertiary: 1.4,
  residential: 1.15,
  unclassified: 1.1,
  living_street: 1.05,
  service: 1.0,
  motorway_link: 1.7,
  trunk_link: 1.6,
  primary_link: 1.45,
  secondary_link: 1.35,
  tertiary_link: 1.25,
  track: 0.9,
  path: 0.8,
  footway: 0.75,
  cycleway: 0.75,
  pedestrian: 0.8,
  construction: 1.0,
  other: 1.0
};

const SATELLITE_STYLE: MapRenderStyle = {
  preset: "satellite",
  showBaseImage: true,
  background: "#11161c",
  buildingFill: "rgba(40,40,40,0.35)",
  buildingStroke: "rgba(15,15,15,0.65)",
  buildingStrokeWidth: 1,
  roadAutoColor: "rgba(255,255,255,0.65)",
  roadAutoWidth: 2,
  roadCustomColor: "rgba(0,200,255,0.8)",
  roadCustomWidth: 3,
  roadCasingColor: null,
  roadCasingWidth: 0,
  selectedRoadColor: "rgba(255,255,255,0.6)",
  directionLineColor: "rgba(255,255,255,0.85)"
};

const SIMPLE_STYLE: MapRenderStyle = {
  preset: "simple",
  showBaseImage: false,
  background: "#e6ecef",
  buildingFill: "#c3ccd4",
  buildingStroke: "#aeb7c2",
  buildingStrokeWidth: 0.8,
  roadAutoColor: "#f9fbfd",
  roadAutoWidth: 2.2,
  roadCustomColor: "#e6eef6",
  roadCustomWidth: 2.5,
  roadCasingColor: "rgba(173,182,192,0.9)",
  roadCasingWidth: 1.4,
  selectedRoadColor: "rgba(35,50,72,0.85)",
  directionLineColor: "rgba(120,132,146,0.7)"
};

const LOCKED_STYLE: MapRenderStyle = {
  preset: "locked",
  showBaseImage: false,
  background: LOCKED_OVERLAY_DEFAULTS.background,
  buildingFill: LOCKED_OVERLAY_DEFAULTS.buildingFill,
  buildingStroke: LOCKED_OVERLAY_DEFAULTS.buildingStroke,
  buildingStrokeWidth: 0.9,
  roadAutoColor: LOCKED_OVERLAY_DEFAULTS.roadMinor,
  roadAutoWidth: 2.6,
  roadCustomColor: LOCKED_OVERLAY_DEFAULTS.roadMinor,
  roadCustomWidth: 2.6,
  roadCasingColor: "rgba(150,160,172,0.55)",
  roadCasingWidth: 1.6,
  selectedRoadColor: "rgba(35,50,72,0.85)",
  directionLineColor: "rgba(45,60,80,0.55)"
};

function resolveMapStyle(preset: MapStylePreset): MapRenderStyle {
  if (preset === "simple") {
    return SIMPLE_STYLE;
  }
  if (preset === "locked") {
    return LOCKED_STYLE;
  }
  return SATELLITE_STYLE;
}

function resolveSimpleRoadWidth(
  roadClass: Road["class"],
  baseWidth: number
): number {
  if (!roadClass) {
    return baseWidth;
  }
  const multiplier = SIMPLE_ROAD_WIDTH_MULTIPLIER[roadClass] ?? 1;
  return baseWidth * multiplier;
}

const MAJOR_ROAD_CLASSES = new Set<Road["class"]>([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link"
]);

function isMajorRoadClass(roadClass?: Road["class"]): boolean {
  if (!roadClass) {
    return false;
  }
  return MAJOR_ROAD_CLASSES.has(roadClass);
}

function resolveLockedRoadWidth(roadClass: Road["class"], baseWidth: number): number {
  if (!roadClass) {
    return baseWidth;
  }
  const multiplier = LOCKED_ROAD_WIDTH_MULTIPLIER[roadClass] ?? 1;
  return baseWidth * multiplier;
}

function resolveRoadWidth(
  road: RoadRenderCache,
  baseWidth: number,
  style: MapRenderStyle,
  appliedScale: number,
  isMajor: boolean
): number {
  let width = baseWidth;
  if (style.preset === "simple") {
    width = resolveSimpleRoadWidth(road.roadClass, baseWidth);
  } else if (style.preset === "locked") {
    width = resolveLockedRoadWidth(road.roadClass, baseWidth);
    const laneCounts = resolveLaneCountsForRoad(road);
    const lanes = Math.max(1, laneCounts.total);
    const laneFactor = 1 + Math.min(0.35, (lanes - 1) * 0.08);
    width *= laneFactor;
    const minScreenWidth = isMajor ? 1.8 : 1.2;
    if (Number.isFinite(appliedScale) && appliedScale > 0) {
      const minWidth = minScreenWidth / appliedScale;
      width = Math.max(width, minWidth);
    }
  }
  return width;
}

function resolveBaseLaneWidthPx(canvas: HTMLCanvasElement): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const minSide = Math.min(canvas.width, canvas.height);
  const target = minSide * LANE_WIDTH_RATIO;
  return clampValue(target, MIN_LANE_WIDTH_PX * dpr, MAX_LANE_WIDTH_PX * dpr);
}

function resolveLaneWidthPx(roadClass: Road["class"], baseLaneWidthPx: number): number {
  const classFactor = clampValue(demandWeightForClass(roadClass), 0.75, 1.35);
  return baseLaneWidthPx * classFactor;
}

interface IsometricView {
  offsetDir: { x: number; y: number };
  viewDir: { x: number; y: number };
  heightScale: number;
}

function resolveIsometricView(state: DrawingManagerState): IsometricView | null {
  if (!state.threeDViewEnabled) {
    return null;
  }
  const angle = ISO_VIEW_ANGLE + state.viewYaw;
  const offsetDir = { x: Math.cos(angle), y: Math.sin(angle) };
  const viewDir = { x: -offsetDir.x, y: -offsetDir.y };
  return {
    offsetDir,
    viewDir,
    heightScale: ISO_HEIGHT_SCALE
  };
}

function drawBuildings(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  style: MapRenderStyle,
  lockedStyle: LockedOverlayStyle | null,
  isometricView: IsometricView | null,
  metersPerPixel: number | null
) {
  if (state.buildingRender.length === 0) {
    return;
  }
  const fill = lockedStyle?.buildingFill ?? style.buildingFill;
  const stroke = lockedStyle?.buildingStroke ?? style.buildingStroke;
  const strokeWidth = style.buildingStrokeWidth;
  if (!isometricView || !metersPerPixel || metersPerPixel <= 0) {
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    for (const building of state.buildingRender) {
      ctx.beginPath();
      building.points.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    drawSelectedBuildingOutline(ctx, state, strokeWidth);
    return;
  }
  drawBuildingsExtruded(
    ctx,
    state.buildingRender,
    fill,
    stroke,
    strokeWidth,
    isometricView,
    metersPerPixel
  );
  drawSelectedBuildingOutline(ctx, state, strokeWidth);
}

function drawBuildingsExtruded(
  ctx: CanvasRenderingContext2D,
  buildings: BuildingRenderCache[],
  fill: string,
  stroke: string,
  strokeWidth: number,
  isometricView: IsometricView,
  metersPerPixel: number
) {
  if (buildings.length === 0) {
    return;
  }
  const sideFill = shadeColor(fill, 0.78);
  const topFill = fill;
  const topStroke = stroke;
  const ordered =
    buildings.length > 1
      ? [...buildings].sort((a, b) => {
          const aCenter = a.center ?? a.points[0];
          const bCenter = b.center ?? b.points[0];
          const depthA = aCenter.x * isometricView.viewDir.x + aCenter.y * isometricView.viewDir.y;
          const depthB = bCenter.x * isometricView.viewDir.x + bCenter.y * isometricView.viewDir.y;
          return depthA - depthB;
        })
      : buildings;
  ctx.save();
  ctx.lineJoin = "round";
  for (const building of ordered) {
    const heightM = building.heightM ?? DEFAULT_BUILDING_HEIGHT_M;
    const heightPx = heightM / metersPerPixel;
    if (!Number.isFinite(heightPx) || heightPx <= 0.5) {
      ctx.fillStyle = topFill;
      ctx.strokeStyle = topStroke;
      ctx.lineWidth = strokeWidth;
      ctx.beginPath();
      building.points.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      continue;
    }
    drawExtrudedPolygon(ctx, building.points, heightPx, isometricView, {
      topFill,
      topStroke,
      sideFill,
      strokeWidth
    });
  }
  ctx.restore();
}

function drawSelectedBuildingOutline(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  baseWidth: number
) {
  const selectedId =
    state.selectedFeature?.kind === "building" ? state.selectedFeature.id : null;
  if (!selectedId) {
    return;
  }
  const selected = state.buildingRender.find((building) => building.id === selectedId);
  if (!selected) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(2, baseWidth + 0.8);
  ctx.beginPath();
  selected.points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawDenseCover(ctx: CanvasRenderingContext2D, state: DrawingManagerState) {
  const model = state.worldModel;
  if (!model || model.denseCover.length === 0) {
    return;
  }
  const projector = state.geoProjector ?? state.geoMapper;
  for (const dense of model.denseCover) {
    const points =
      dense.render?.map((point) => ({ x: point.x, y: point.y })) ??
      (projector
        ? dense.polygon.map((point) => projector.latLonToPixel(point.lat, point.lon))
        : null);
    if (!points || points.length < 3) {
      continue;
    }
    const bounds = computeBounds(points);
    if (!bounds) {
      continue;
    }
    const fillAlpha = clampValue(0.12 + dense.density * 0.25, 0.12, 0.45);
    const hatchAlpha = clampValue(0.2 + dense.density * 0.35, 0.2, 0.6);
    const spacing = 10;

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
    ctx.fillStyle = applyAlpha(DENSE_COVER_FILL, fillAlpha);
    ctx.fill();
    ctx.clip();

    ctx.strokeStyle = applyAlpha(DENSE_COVER_STROKE, hatchAlpha);
    ctx.lineWidth = 1;
    const minX = Math.floor(bounds.minX) - bounds.maxY;
    const maxX = Math.ceil(bounds.maxX) + bounds.maxY;
    for (let x = minX; x <= maxX; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, bounds.minY);
      ctx.lineTo(x + (bounds.maxY - bounds.minY), bounds.maxY);
      ctx.stroke();
    }
    ctx.restore();

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
    ctx.strokeStyle = applyAlpha(DENSE_COVER_STROKE, 0.7);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
}

function drawTrees(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  lockedStyle: LockedOverlayStyle | null,
  metersPerPixel: number | null
) {
  const model = state.worldModel;
  if (!model || model.trees.length === 0) {
    return;
  }
  const projector = state.geoProjector ?? state.geoMapper;
  if (!projector) {
    return;
  }
  ctx.save();
  ctx.fillStyle = lockedStyle ? TREE_FILL : applyAlpha(TREE_FILL, 0.9);
  ctx.strokeStyle = TREE_STROKE;
  ctx.lineWidth = 1;
  for (const tree of model.trees) {
    const point = tree.render ?? projector.latLonToPixel(tree.location.lat, tree.location.lon);
    const radiusMeters = tree.baseRadiusMeters;
    const radiusPx = metersPerPixel ? radiusMeters / metersPerPixel : 6;
    const radius = Math.max(4, radiusPx);
    const selected =
      state.selectedFeature?.kind === "tree" && state.selectedFeature.id === tree.id;
    ctx.save();
    if (tree.type === "pine") {
      const halfWidth = radius * 0.9;
      const height = radius * 1.6;
      ctx.beginPath();
      ctx.moveTo(point.x, point.y - height);
      ctx.lineTo(point.x - halfWidth, point.y + radius * 0.5);
      ctx.lineTo(point.x + halfWidth, point.y + radius * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      const canopyRadius = radius * 0.95;
      const canopyY = point.y - radius * 0.3;
      const trunkWidth = radius * 0.35;
      const trunkHeight = radius * 0.75;
      ctx.beginPath();
      ctx.arc(point.x, canopyY, canopyRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = TREE_STROKE;
      ctx.fillRect(
        point.x - trunkWidth / 2,
        canopyY + canopyRadius * 0.2,
        trunkWidth,
        trunkHeight
      );
      ctx.fillStyle = lockedStyle ? TREE_FILL : applyAlpha(TREE_FILL, 0.9);
    }
    if (selected) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 1.35, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawSigns(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  lockedStyle: LockedOverlayStyle | null,
  metersPerPixel: number | null
) {
  const model = state.worldModel;
  if (!model || model.signs.length === 0) {
    return;
  }
  const projector = state.geoProjector ?? state.geoMapper;
  if (!projector) {
    return;
  }
  ctx.save();
  ctx.fillStyle = lockedStyle ? SIGN_FILL : applyAlpha(SIGN_FILL, 0.9);
  ctx.strokeStyle = SIGN_STROKE;
  ctx.lineWidth = 1;
  for (const sign of model.signs) {
    const point = sign.render ?? projector.latLonToPixel(sign.location.lat, sign.location.lon);
    const widthMeters = sign.widthMeters;
    const heightMeters = sign.heightMeters;
    const widthPx = Math.max(10, metersPerPixel ? widthMeters / metersPerPixel : 12);
    const heightPx = Math.max(6, metersPerPixel ? heightMeters / metersPerPixel : 8);
    const yaw = Number.isFinite(sign.yawDegrees) ? sign.yawDegrees : 0;
    const yawRad = (yaw * Math.PI) / 180;
    const selected =
      state.selectedFeature?.kind === "sign" && state.selectedFeature.id === sign.id;
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(yawRad);
    ctx.beginPath();
    ctx.rect(-widthPx / 2, -heightPx / 2, widthPx, heightPx);
    ctx.fill();
    ctx.stroke();
    const tickLength = Math.max(widthPx, heightPx) * 0.6;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -tickLength);
    ctx.stroke();
    if (selected) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(-widthPx / 2 - 2, -heightPx / 2 - 2, widthPx + 4, heightPx + 4);
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawTrafficSignals(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  lockedStyle: LockedOverlayStyle | null,
  appliedScale: number
) {
  const model = state.worldModel;
  if (!model || model.trafficSignals.length === 0) {
    return;
  }
  const projector = state.geoProjector ?? state.geoMapper;
  if (!projector) {
    return;
  }
  const scale = Number.isFinite(appliedScale) && appliedScale > 0 ? appliedScale : 1;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const radius = (3.4 * dpr) / scale;
  const strokeWidth = Math.max(1 * dpr, 1.2) / scale;
  ctx.save();
  ctx.fillStyle = lockedStyle ? SIGNAL_FILL : applyAlpha(SIGNAL_FILL, 0.9);
  ctx.strokeStyle = SIGNAL_STROKE;
  ctx.lineWidth = strokeWidth;
  for (const signal of model.trafficSignals) {
    const point =
      signal.render ?? projector.latLonToPixel(signal.location.lat, signal.location.lon);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawTrafficEpicenters(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  lockedStyle: LockedOverlayStyle | null,
  appliedScale: number
) {
  if (state.trafficEpicenters.length === 0) {
    return;
  }
  const projector = state.geoProjector ?? state.geoMapper;
  if (!projector) {
    return;
  }
  const scale = Number.isFinite(appliedScale) && appliedScale > 0 ? appliedScale : 1;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const baseRadius = (6 * dpr) / scale;
  const strokeWidth = Math.max(1 * dpr, 1.2) / scale;
  const baseColor = lockedStyle?.trafficFlow ?? "#f59e0b";
  ctx.save();
  ctx.fillStyle = applyAlpha(baseColor, 0.25);
  ctx.strokeStyle = applyAlpha(baseColor, 0.5);
  ctx.lineWidth = strokeWidth;
  for (const epicenter of state.trafficEpicenters) {
    const point = projector.latLonToPixel(epicenter.point.lat, epicenter.point.lon);
    const weight = Number.isFinite(epicenter.weight) ? epicenter.weight : 0.2;
    const radius = baseRadius * (0.7 + weight * 1.4);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawStructure(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  lockedStyle: LockedOverlayStyle | null,
  isometricView: IsometricView | null,
  metersPerPixel: number | null
) {
  const structure = state.structureRender;
  if (!structure || structure.points.length < 3) {
    return;
  }
  const fill = lockedStyle?.structureFill ?? "#7dd3fc";
  const stroke = lockedStyle?.structureStroke ?? "#38bdf8";
  const strokeWidth = 1.2;
  const overlay = state.structureOverlay;
  const drawOverlay = () => {
    if (!overlay) {
      return;
    }
    const points = structure.points;
    if (overlay.highlight) {
      ctx.save();
      ctx.strokeStyle = applyAlpha("#f59e0b", 0.85);
      ctx.lineWidth = strokeWidth * 2.4;
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
    if (!overlay.faceScores || overlay.faceScores.length < points.length) {
      return;
    }
    const maxScore = overlay.faceScores.reduce((max, score) => Math.max(max, score), 0);
    if (maxScore <= 0) {
      return;
    }
    ctx.save();
    ctx.lineWidth = strokeWidth * 2;
    ctx.lineCap = "round";
    for (let i = 0; i < points.length; i += 1) {
      const score = overlay.faceScores[i];
      if (!Number.isFinite(score) || score <= 0) {
        continue;
      }
      const normalized = score / maxScore;
      const [r, g, b] = colorForRelativeScore(normalized);
      ctx.strokeStyle = rgba(r, g, b, 0.95);
      const start = points[i];
      const end = points[(i + 1) % points.length];
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
    ctx.restore();
  };
  if (!isometricView || !metersPerPixel || metersPerPixel <= 0) {
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.beginPath();
    structure.points.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    drawOverlay();
    return;
  }
  const heightPx = structure.heightM / metersPerPixel;
  if (!Number.isFinite(heightPx) || heightPx <= 0.5) {
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.beginPath();
    structure.points.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    drawOverlay();
    return;
  }
  const sideFill = shadeColor(fill, 0.74);
  drawExtrudedPolygon(ctx, structure.points, heightPx, isometricView, {
    topFill: fill,
    topStroke: stroke,
    sideFill,
    strokeWidth
  });
  drawOverlay();
}

function drawExtrudedPolygon(
  ctx: CanvasRenderingContext2D,
  points: RoadRenderPoint[],
  heightPx: number,
  isometricView: IsometricView,
  colors: { topFill: string; topStroke: string; sideFill: string; strokeWidth: number }
) {
  if (points.length < 3 || heightPx <= 0) {
    return;
  }
  const offsetX = isometricView.offsetDir.x * heightPx * isometricView.heightScale;
  const offsetY = isometricView.offsetDir.y * heightPx * isometricView.heightScale;
  if (Math.abs(offsetX) < 0.5 && Math.abs(offsetY) < 0.5) {
    ctx.fillStyle = colors.topFill;
    ctx.strokeStyle = colors.topStroke;
    ctx.lineWidth = colors.strokeWidth;
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return;
  }
  const topPoints = points.map((point) => ({
    x: point.x + offsetX,
    y: point.y + offsetY
  }));
  const clockwise = polygonSignedArea(points) >= 0;
  ctx.save();
  ctx.fillStyle = colors.sideFill;
  for (let i = 0; i < points.length; i += 1) {
    const next = (i + 1) % points.length;
    const p0 = points[i];
    const p1 = points[next];
    const t0 = topPoints[i];
    const t1 = topPoints[next];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const nx = clockwise ? dy : -dy;
    const ny = clockwise ? -dx : dx;
    const facing = nx * isometricView.viewDir.x + ny * isometricView.viewDir.y;
    if (facing <= 0) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(t1.x, t1.y);
    ctx.lineTo(t0.x, t0.y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = colors.topFill;
  ctx.strokeStyle = colors.topStroke;
  ctx.lineWidth = colors.strokeWidth;
  ctx.beginPath();
  topPoints.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function polygonSignedArea(points: RoadRenderPoint[]): number {
  if (points.length < 3) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = (i + 1) % points.length;
    sum += points[i].x * points[next].y - points[next].x * points[i].y;
  }
  return sum / 2;
}

function drawRoads(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  style: MapRenderStyle,
  lockedStyle: LockedOverlayStyle | null,
  appliedScale: number,
  baseLaneWidthPx: number
) {
  if (state.autoRoadRender.length === 0 && state.customRoadRender.length === 0) {
    return;
  }
  const trafficVisible = state.layerVisibility.traffic;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const roadGroups: Array<{
    roads: RoadRenderCache[];
    baseColor: string;
    baseWidth: number;
    casingColor?: string | null;
    casingWidth?: number;
  }> = [
    {
      roads: state.autoRoadRender,
      baseColor: style.roadAutoColor,
      baseWidth: style.roadAutoWidth,
      casingColor: style.roadCasingColor,
      casingWidth: style.roadCasingWidth
    },
    {
      roads: state.customRoadRender,
      baseColor: style.roadCustomColor,
      baseWidth: style.roadCustomWidth,
      casingColor: style.roadCasingColor,
      casingWidth: style.roadCasingWidth
    }
  ];

  for (const group of roadGroups) {
    for (const road of group.roads) {
      const isMajor = lockedStyle ? isMajorRoadClass(road.roadClass) : false;
      const casingColor = lockedStyle ? lockedStyle.roadCasing : group.casingColor;
      const baseColor = lockedStyle
        ? isMajor
          ? lockedStyle.roadMajor
          : lockedStyle.roadMinor
        : group.baseColor;
      const casingWidth = group.casingWidth ?? 0;
      const laneCounts = resolveLaneCountsForRoad(road);
      const totalLanes = Math.max(1, laneCounts.total);
      let laneWidth = totalLanes > 0 ? group.baseWidth / totalLanes : group.baseWidth;
      let width = resolveRoadWidth(road, group.baseWidth, style, appliedScale, isMajor);
      let separatorWidth = 0;
      let laneCountForRender = totalLanes;
      let drawSeparators = false;
      if (style.preset === "locked") {
        const scale = Number.isFinite(appliedScale) && appliedScale > 0 ? appliedScale : 1;
        const laneWidthPx = resolveLaneWidthPx(road.roadClass, baseLaneWidthPx);
        laneCountForRender = Math.min(MAX_RENDERED_LANES, Math.max(1, totalLanes));
        laneWidth = laneWidthPx / scale;
        width = laneWidth * laneCountForRender;
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        const separatorWidthPx = clampValue(baseLaneWidthPx * 0.18, 0.8 * dpr, 1.4 * dpr);
        separatorWidth = separatorWidthPx / scale;
        drawSeparators = laneCountForRender > 1 && separatorWidth > 0;
      }
      if (casingColor && casingWidth > 0) {
        strokePolyline(ctx, road.renderPoints, casingColor, width + casingWidth);
      }
      strokePolyline(ctx, road.renderPoints, baseColor, width);
      if (drawSeparators) {
        const separatorColor = shadeColor(baseColor, 0.82);
        for (let i = 1; i < laneCountForRender; i += 1) {
          const offset = (i - laneCountForRender / 2) * laneWidth;
          const line =
            Math.abs(offset) < 1e-3
              ? road.renderPoints
              : offsetPolyline(road.renderPoints, offset, {
                  miterLimit: 3.5,
                  minSegmentLength: 0.5
                });
          strokePolyline(ctx, line, separatorColor, separatorWidth);
        }
      }
      const showPreview = trafficVisible && state.trafficPreview.active;
      const showTrafficOverlay = trafficVisible && state.trafficOverlayEnabled && !showPreview;
      if (showTrafficOverlay) {
        const traffic = resolveTrafficScores(state.trafficByRoadId, state.trafficViewState, road.id);
        if (traffic) {
          const normalized = normalizeTrafficScore(traffic.combined);
          if (normalized > 0) {
            const trafficWidth = width + 1 + normalized * 4;
            const trafficColor = resolveTrafficOverlayColor(normalized, lockedStyle, 0.85);
            strokePolyline(ctx, road.renderPoints, trafficColor, trafficWidth);
          }
          drawTrafficFlowDots(
            ctx,
            road,
            traffic,
            state.trafficAnimationTime,
            state.trafficViewState,
            appliedScale,
            lockedStyle
          );
          if (state.trafficViewState.showDirection) {
            drawTrafficArrows(ctx, road, traffic, lockedStyle);
          }
        }
      }
      if (showPreview) {
        drawTrafficPreviewDots(
          ctx,
          road,
          state.trafficPreview,
          state.trafficAnimationTime,
          appliedScale
        );
      }
      if (
        state.roadDirectionOverlayEnabled &&
        road.showDirectionLine &&
        road.directionPoints &&
        road.directionPoints.length >= 2
      ) {
        ctx.save();
        ctx.setLineDash([6, 6]);
        strokePolyline(ctx, road.directionPoints, style.directionLineColor, 1.5);
        ctx.restore();
      }
      if (state.selectedRoadId === road.id) {
        strokePolyline(ctx, road.renderPoints, style.selectedRoadColor, width + 2);
      }
    }
  }
  ctx.restore();
}

function drawPreviews(
  ctx: CanvasRenderingContext2D,
  state: DrawingManagerState,
  lockedStyle: LockedOverlayStyle | null
) {
  const drag = state.dragState;
  if (drag) {
    if (drag.kind === "ellipse") {
      if (state.visibilityFilter[drag.zone]) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = outlineColor(drag.zone, lockedStyle);
        ctx.fillStyle = zoneFill(drag.zone, 0.15, lockedStyle);
        const width = drag.current.x - drag.start.x;
        const height = drag.current.y - drag.start.y;
        const x = width < 0 ? drag.current.x : drag.start.x;
        const y = height < 0 ? drag.current.y : drag.start.y;
        const w = Math.abs(width);
        const h = Math.abs(height);
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    } else if (drag.kind === "tree") {
      const radius = Math.hypot(drag.current.x - drag.start.x, drag.current.y - drag.start.y);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = TREE_STROKE;
      ctx.fillStyle = applyAlpha(TREE_FILL, 0.2);
      ctx.beginPath();
      ctx.arc(drag.start.x, drag.start.y, Math.max(2, radius), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  const poly = state.polygonDraft;
  if (poly) {
    if (poly.mode === "shape" && poly.zone) {
      if (state.visibilityFilter[poly.zone]) {
        ctx.save();
        ctx.strokeStyle = outlineColor(poly.zone, lockedStyle);
        ctx.fillStyle = zoneFill(poly.zone, 0.2, lockedStyle);
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        poly.points.forEach((p, index) => {
          if (index === 0) {
            ctx.moveTo(p.x, p.y);
          } else {
            ctx.lineTo(p.x, p.y);
          }
        });
        if (state.pointer) {
          if (poly.points.length > 0) {
            ctx.lineTo(state.pointer.x, state.pointer.y);
          }
        }
        ctx.stroke();
        ctx.restore();
        if (poly.points.length >= 3) {
          const first = poly.points[0];
          const highlight =
            !!state.pointer && isPointNear(first, state.pointer, POLYGON_CLOSE_RADIUS);
          drawPolygonCloseHandle(ctx, first, poly.zone, highlight, lockedStyle);
        }
      }
    } else if (poly.mode === "dense_cover") {
      ctx.save();
      ctx.strokeStyle = DENSE_COVER_STROKE;
      ctx.fillStyle = applyAlpha(DENSE_COVER_FILL, 0.25);
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      poly.points.forEach((p, index) => {
        if (index === 0) {
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
      });
      if (state.pointer && poly.points.length > 0) {
        ctx.lineTo(state.pointer.x, state.pointer.y);
      }
      ctx.stroke();
      ctx.restore();
      if (poly.points.length >= 3) {
        const first = poly.points[0];
        const highlight =
          !!state.pointer && isPointNear(first, state.pointer, POLYGON_CLOSE_RADIUS);
        drawDenseCoverCloseHandle(ctx, first, highlight);
      }
    }
  }

  if (state.roadToolMode === "edit") {
    const draft = state.roadEdit.draft;
    if (draft) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "rgba(0,200,255,0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      draft.points.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      if (state.pointer && draft.points.length > 0) {
        ctx.lineTo(state.pointer.x, state.pointer.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const point of draft.points) {
        drawRoadControlPoint(ctx, point, false);
      }
      ctx.restore();
    }

    const selected =
      state.selectedRoadId && state.roadRenderIndex[state.selectedRoadId]
        ? state.roadRenderIndex[state.selectedRoadId]
        : null;
    if (selected && selected.source === "custom") {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      selected.controlPoints.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.stroke();
      ctx.restore();

      selected.controlPoints.forEach((point, index) => {
        drawRoadControlPoint(ctx, point, index === state.roadEdit.selectedPointIndex);
      });
    }
  }
}

const LOCKED_HUD_PANEL_BG = "rgba(255,255,255,0.82)";
const LOCKED_HUD_PANEL_BORDER = "rgba(30,40,50,0.16)";
const LOCKED_HUD_TEXT = "rgba(34,45,56,0.9)";
const LOCKED_HUD_INK = "rgba(25,35,45,0.85)";

function drawPlaceholderGrid(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  lockedStyle: LockedOverlayStyle
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const spacing = 48;
  ctx.strokeStyle = applyAlpha(lockedStyle.roadCasing, 0.18);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= canvas.width; x += spacing) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
  }
  for (let y = 0; y <= canvas.height; y += spacing) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(canvas.width, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function drawLockedHud(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  state: DrawingManagerState,
  lockedStyle: LockedOverlayStyle,
  status: { hasRoads: boolean; hasBuildings: boolean; autoDataLoading: boolean }
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = "12px 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  drawLegend(ctx, 12, 12, lockedStyle);
  drawNorthArrow(ctx, canvas);
  drawScaleBar(ctx, canvas, state);
  const showStatus = status.autoDataLoading || (!status.hasRoads && !status.hasBuildings);
  if (showStatus) {
    const message = status.autoDataLoading
      ? "Loading roads/buildings..."
      : "No roads/buildings yet.";
    drawStatusPill(ctx, canvas, message);
  }
  ctx.restore();
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  lockedStyle: LockedOverlayStyle
) {
  const entries = [
    { label: "Roads", kind: "line" },
    {
      label: "Buildings",
      kind: "rect",
      fill: lockedStyle.buildingFill,
      stroke: lockedStyle.buildingStroke
    },
    {
      label: "Candidate region",
      kind: "rect",
      fill: applyAlpha(lockedStyle.candidateFill, 0.6),
      stroke: lockedStyle.candidateStroke
    },
    {
      label: "Obstacles",
      kind: "rect",
      fill: applyAlpha(lockedStyle.obstacleFill, 0.6),
      stroke: lockedStyle.obstacleStroke
    },
    { label: "Traffic flow", kind: "dots", color: lockedStyle.trafficFlow }
  ] as const;
  const padding = 10;
  const swatchSize = 12;
  const lineHeight = 16;
  const labelGap = 8;
  let maxLabelWidth = 0;
  for (const entry of entries) {
    maxLabelWidth = Math.max(maxLabelWidth, ctx.measureText(entry.label).width);
  }
  const panelWidth = padding * 2 + swatchSize + labelGap + maxLabelWidth;
  const panelHeight = padding * 2 + entries.length * lineHeight;
  drawHudPanel(ctx, originX, originY, panelWidth, panelHeight);
  ctx.textAlign = "left";
  ctx.fillStyle = LOCKED_HUD_TEXT;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const rowY = originY + padding + lineHeight * i + lineHeight / 2;
    const swatchX = originX + padding;
    const swatchY = rowY - swatchSize / 2;
    if (entry.kind === "line") {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = applyAlpha(lockedStyle.roadCasing, 0.7);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(swatchX, rowY);
      ctx.lineTo(swatchX + swatchSize, rowY);
      ctx.stroke();
      ctx.strokeStyle = lockedStyle.roadMajor;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(swatchX, rowY);
      ctx.lineTo(swatchX + swatchSize, rowY);
      ctx.stroke();
      ctx.restore();
    } else if (entry.kind === "rect") {
      ctx.save();
      ctx.fillStyle = entry.fill;
      ctx.strokeStyle = entry.stroke;
      ctx.lineWidth = 1;
      ctx.fillRect(swatchX, swatchY, swatchSize, swatchSize);
      ctx.strokeRect(swatchX, swatchY, swatchSize, swatchSize);
      ctx.restore();
    } else if (entry.kind === "dots") {
      ctx.save();
      ctx.fillStyle = entry.color;
      const dotY = rowY;
      for (let d = 0; d < 3; d += 1) {
        const dotX = swatchX + d * (swatchSize / 2.5);
        ctx.beginPath();
        ctx.arc(dotX, dotY, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.fillStyle = LOCKED_HUD_TEXT;
    ctx.fillText(entry.label, swatchX + swatchSize + labelGap, rowY);
  }
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  const margin = 14;
  const size = 18;
  const x = canvas.width - margin - size / 2;
  const y = margin + size;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = LOCKED_HUD_INK;
  ctx.fillText("N", x, y - size - 2);
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x - size * 0.45, y);
  ctx.lineTo(x + size * 0.45, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  state: DrawingManagerState
) {
  const metersPerPixel = computeMetersPerPixel(state, canvas);
  if (!metersPerPixel || !Number.isFinite(metersPerPixel)) {
    return;
  }
  const metricMeters = 100;
  const imperialMeters = 200 * FEET_TO_METERS;
  const metricPx = metricMeters / metersPerPixel;
  const imperialPx = imperialMeters / metersPerPixel;
  let label = "100 m";
  let barWidth = metricPx;
  if (metricPx > 160 && imperialPx >= 60) {
    label = "200 ft";
    barWidth = imperialPx;
  }
  if (barWidth <= 0) {
    return;
  }
  const margin = 14;
  const x = margin;
  const y = canvas.height - margin;
  ctx.save();
  ctx.strokeStyle = LOCKED_HUD_INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + barWidth, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 4);
  ctx.moveTo(x + barWidth, y - 4);
  ctx.lineTo(x + barWidth, y + 4);
  ctx.stroke();
  ctx.fillStyle = LOCKED_HUD_TEXT;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, x, y - 6);
  ctx.restore();
}

function drawStatusPill(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  text: string
) {
  const paddingX = 12;
  const paddingY = 6;
  const textWidth = ctx.measureText(text).width;
  const width = textWidth + paddingX * 2;
  const height = 2 * paddingY + 12;
  const x = (canvas.width - width) / 2;
  const y = 14;
  drawHudPanel(ctx, x, y, width, height);
  ctx.fillStyle = LOCKED_HUD_TEXT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + width / 2, y + height / 2);
}

function drawHudPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
) {
  ctx.save();
  ctx.fillStyle = LOCKED_HUD_PANEL_BG;
  ctx.strokeStyle = LOCKED_HUD_PANEL_BORDER;
  ctx.lineWidth = 1;
  drawRoundedRect(ctx, x, y, width, height, 8);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function computeMetersPerPixel(
  state: DrawingManagerState,
  canvas: HTMLCanvasElement
): number | null {
  const projector = state.geoProjector ?? state.geoMapper;
  if (!projector) {
    return null;
  }
  const samplePx = Math.min(160, Math.max(80, Math.round(canvas.width * 0.18)));
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const centerWorld = canvasToWorld(centerX, centerY, state);
  const sampleWorld = canvasToWorld(centerX + samplePx, centerY, state);
  const start = projector.pixelToLatLon(centerWorld.x, centerWorld.y);
  const end = projector.pixelToLatLon(sampleWorld.x, sampleWorld.y);
  const meters = haversineMeters(start.lat, start.lon, end.lat, end.lon);
  if (!Number.isFinite(meters) || meters <= 0) {
    return null;
  }
  return meters / samplePx;
}

function drawRectOrEllipse(ctx: CanvasRenderingContext2D, shape: RectShape | EllipseShape) {
  if (shape.kind === "rect") {
    ctx.fillRect(shape.x, shape.y, shape.width, shape.height);
  } else {
    ctx.beginPath();
    ctx.ellipse(
      shape.x + shape.width / 2,
      shape.y + shape.height / 2,
      shape.width / 2,
      shape.height / 2,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
}

function drawPolygon(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]) {
  ctx.beginPath();
  points.forEach((p, index) => {
    if (index === 0) {
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
  });
  ctx.closePath();
  ctx.fill();
}

function strokePolyline(
  ctx: CanvasRenderingContext2D,
  points: RoadRenderPoint[],
  strokeStyle: string,
  lineWidth: number
) {
  if (points.length < 2) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  points.forEach((p, index) => {
    if (index === 0) {
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
  });
  ctx.stroke();
  ctx.restore();
}

function drawPolygonCloseHandle(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  zone: ZoneType,
  highlight: boolean,
  lockedStyle: LockedOverlayStyle | null
) {
  ctx.save();
  ctx.lineWidth = highlight ? 3 : 1.5;
  ctx.strokeStyle = highlight ? "#ffffff" : outlineColor(zone, lockedStyle);
  ctx.fillStyle = highlight
    ? "rgba(255,255,255,0.9)"
    : zoneFill(zone, 0.45, lockedStyle);
  ctx.beginPath();
  ctx.arc(point.x, point.y, POLYGON_CLOSE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawDenseCoverCloseHandle(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  highlight: boolean
) {
  ctx.save();
  ctx.lineWidth = highlight ? 3 : 1.5;
  ctx.strokeStyle = highlight ? "#ffffff" : DENSE_COVER_STROKE;
  ctx.fillStyle = highlight ? "rgba(255,255,255,0.9)" : applyAlpha(DENSE_COVER_FILL, 0.5);
  ctx.beginPath();
  ctx.arc(point.x, point.y, POLYGON_CLOSE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPolygonVertexHandle(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  zone: ZoneType,
  highlight: boolean,
  lockedStyle: LockedOverlayStyle | null
) {
  ctx.save();
  ctx.lineWidth = highlight ? 2 : 1;
  ctx.strokeStyle = highlight ? "#ffffff" : outlineColor(zone, lockedStyle);
  ctx.fillStyle = highlight
    ? "rgba(255,255,255,0.9)"
    : zoneFill(zone, 0.7, lockedStyle);
  ctx.beginPath();
  ctx.arc(point.x, point.y, SHAPE_VERTEX_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawRoadControlPoint(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  isSelected: boolean
) {
  ctx.save();
  ctx.fillStyle = isSelected ? "#ffffff" : "rgba(0,200,255,0.9)";
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.beginPath();
  ctx.arc(point.x, point.y, ROAD_CONTROL_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawContours(
  ctx: CanvasRenderingContext2D,
  segments: ContourSegment[],
  opacity: number
) {
  if (segments.length === 0 || opacity <= 0) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = `rgba(0,0,0,${opacity.toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const segment of segments) {
    ctx.moveTo(segment.start.x, segment.start.y);
    ctx.lineTo(segment.end.x, segment.end.y);
  }
  ctx.stroke();
  ctx.restore();
}

function strokeEllipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
) {
  ctx.beginPath();
  ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function getMousePos(
  canvas: HTMLCanvasElement,
  ev: MouseEvent,
  state: DrawingManagerState
): { x: number; y: number } {
  const canvasPoint = getCanvasPoint(canvas, ev);
  return canvasToWorld(canvasPoint.x, canvasPoint.y, state);
}

function getCanvasPoint(canvas: HTMLCanvasElement, ev: MouseEvent | WheelEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (ev.clientX - rect.left) * scaleX,
    y: (ev.clientY - rect.top) * scaleY
  };
}

function canvasToWorld(
  canvasX: number,
  canvasY: number,
  state: DrawingManagerState
): { x: number; y: number } {
  const appliedScale = state.view.scale * state.view.baseScale;
  return {
    x: (canvasX - state.view.offsetX) / appliedScale,
    y: (canvasY - state.view.offsetY) / appliedScale
  };
}

function toolToDrawInfo(
  tool: ToolMode
): { zone?: ZoneType; kind: "ellipse" | "polygon"; mode: PolygonDraftMode } | null {
  switch (tool) {
    case "drawViewerPolygon":
      return { zone: "viewer", kind: "polygon", mode: "shape" };
    case "drawCandidatePolygon":
      return { zone: "candidate", kind: "polygon", mode: "shape" };
    case "drawObstaclePolygon":
      return { zone: "obstacle", kind: "polygon", mode: "shape" };
    case "drawDenseCoverPolygon":
      return { kind: "polygon", mode: "dense_cover" };
    case "drawObstacleEllipse":
      return { zone: "obstacle", kind: "ellipse", mode: "shape" };
    case "placeTreePine":
    case "placeTreeDeciduous":
    case "placeSign":
    case "labelTreePine":
    case "labelTreeDeciduous":
    case "labelSign":
    case "labelBillboard":
      return null;
    default:
      return null;
  }
}

function createEllipseShape(
  zone: ZoneType,
  x: number,
  y: number,
  width: number,
  height: number,
  name: string
): Shape {
  return {
    id: createId(),
    name,
    kind: "ellipse",
    type: zone,
    alpha: zoneAlpha(zone),
    visible: true,
    x,
    y,
    width,
    height
  };
}

function zoneAlpha(zone: ZoneType): number {
  return 1;
}

function zoneFill(
  zone: ZoneType,
  alpha: number,
  lockedStyle?: LockedOverlayStyle | null
): string {
  if (lockedStyle) {
    switch (zone) {
      case "obstacle":
        return applyAlpha(lockedStyle.obstacleFill, alpha);
      case "candidate":
        return applyAlpha(lockedStyle.candidateFill, alpha);
      case "viewer":
        return applyAlpha(lockedStyle.viewerFill, alpha);
      default:
        return `rgba(255,255,255,${alpha.toFixed(3)})`;
    }
  }
  switch (zone) {
    case "obstacle":
      return `rgba(0,0,0,${alpha.toFixed(3)})`;
    case "candidate":
      return `rgba(0,255,0,${alpha.toFixed(3)})`;
    case "viewer":
      return `rgba(255,0,0,${alpha.toFixed(3)})`;
    default:
      return `rgba(255,255,255,${alpha.toFixed(3)})`;
  }
}

function outlineColor(zone: ZoneType, lockedStyle?: LockedOverlayStyle | null): string {
  if (lockedStyle) {
    switch (zone) {
      case "obstacle":
        return lockedStyle.obstacleStroke;
      case "candidate":
        return lockedStyle.candidateStroke;
      case "viewer":
        return lockedStyle.viewerStroke;
      default:
        return "#fff";
    }
  }
  switch (zone) {
    case "obstacle":
      return "#111";
    case "candidate":
      return "#4caf50";
    case "viewer":
      return "#f44336";
    default:
      return "#fff";
  }
}

function hitTest(
  point: { x: number; y: number },
  shapes: Shape[],
  visibility: Record<ZoneType, boolean>
): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    const shape = shapes[i];
    if (!visibility[shape.type] || shape.visible === false) {
      continue;
    }
    if (pointInShape(point, shape)) {
      return shape;
    }
  }
  return null;
}

function renderHeatmapBitmap(
  cells: HeatmapCell[],
  cellSize: number,
  opacity: number,
  width: number,
  height: number
): HTMLCanvasElement | null {
  if (cells.length === 0 || opacity <= 0) {
    return null;
  }
  let minScore = Infinity;
  let maxScore = -Infinity;
  for (const cell of cells) {
    if (cell.score < minScore) minScore = cell.score;
    if (cell.score > maxScore) maxScore = cell.score;
  }
  const denom = maxScore - minScore || 1;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  const radius = Math.max(cellSize * 0.6, 4);
  for (const cell of cells) {
    const normalized = denom === 0 ? 1 : (cell.score - minScore) / denom;
    if (normalized <= 0) {
      continue;
    }
    const [r, g, b] = colorForRelativeScore(normalized);
    const grad = ctx.createRadialGradient(cell.pixel.x, cell.pixel.y, 0, cell.pixel.x, cell.pixel.y, radius);
    grad.addColorStop(0, rgba(r, g, b, opacity));
    grad.addColorStop(1, rgba(r, g, b, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cell.pixel.x, cell.pixel.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

function drawBestCellMarker(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const size = 12;
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x - size, y - size);
  ctx.lineTo(x + size, y + size);
  ctx.moveTo(x + size, y - size);
  ctx.lineTo(x - size, y + size);
  ctx.stroke();
  ctx.restore();
}

function resolveTrafficScores(
  trafficByRoadId: TrafficByRoadId,
  viewState: TrafficViewState,
  roadId: string
): TrafficScores | null {
  const byPreset = trafficByRoadId[roadId];
  if (!byPreset) {
    return null;
  }
  const presetData = byPreset[viewState.preset];
  if (!presetData) {
    return null;
  }
  const hour = clampValue(Math.round(viewState.hour), 0, 23);
  const scores = presetData[hour];
  if (!scores) {
    return null;
  }
  const forward = readTrafficScore(scores.forward);
  const reverse = readTrafficScore(scores.reverse);
  const total = readTrafficScore(scores.total);
  const combined =
    total ?? (forward !== null && reverse !== null ? Math.max(forward, reverse) : forward ?? reverse ?? null);
  if (combined === null && forward === null && reverse === null) {
    return null;
  }
  return {
    combined,
    forward: forward ?? undefined,
    reverse: reverse ?? undefined
  };
}

function readTrafficScore(value: number | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  return value as number;
}

function normalizeTrafficScore(score: number | null | undefined): number {
  if (!Number.isFinite(score ?? NaN)) {
    return 0;
  }
  return clampValue((score as number) / 100, 0, 1);
}

function resolveTrafficOverlayColor(
  normalized: number,
  lockedStyle: LockedOverlayStyle | null,
  alpha: number
): string {
  const clampedAlpha = clampValue(alpha, 0, 1);
  if (!lockedStyle) {
    const [r, g, b] = colorForRelativeScore(normalized);
    return rgba(r, g, b, clampedAlpha);
  }
  const intensity = clampValue(0.35 + normalized * 0.65, 0, 1);
  return applyAlpha(lockedStyle.trafficFlow, clampedAlpha * intensity);
}

function drawTrafficArrows(
  ctx: CanvasRenderingContext2D,
  road: RoadRenderCache,
  traffic: TrafficScores,
  lockedStyle: LockedOverlayStyle | null
) {
  if (road.arrowSamples.length === 0) {
    return;
  }
  const forward = traffic.forward ?? traffic.combined;
  const reverse = traffic.reverse;
  if (forward === null && typeof reverse !== "number") {
    return;
  }
  if (typeof forward === "number") {
    drawArrowSet(ctx, road.arrowSamples, forward, 1, lockedStyle);
  }
  if (typeof reverse === "number") {
    drawArrowSet(ctx, road.arrowSamples, reverse, -1, lockedStyle);
  }
}

function drawTrafficFlowDots(
  ctx: CanvasRenderingContext2D,
  road: RoadRenderCache,
  traffic: TrafficScores,
  time: number,
  viewState: TrafficViewState,
  appliedScale: number,
  lockedStyle: LockedOverlayStyle | null
) {
  if (road.flowSamples.length === 0) {
    return;
  }
  const forwardScore = typeof traffic.forward === "number" ? traffic.forward : null;
  const reverseScore = typeof traffic.reverse === "number" ? traffic.reverse : null;
  const flowScale = flowDensityMultiplier(viewState.flowDensity);
  const laneCounts = resolveLaneCountsForRoad(road);

  if (forwardScore === null && reverseScore === null) {
    const combined = traffic.combined;
    if (combined === null) {
      return;
    }
    const lanes = resolveCombinedLaneCount(laneCounts);
    drawDirectionalFlowDots(
      ctx,
      road,
      combined,
      time,
      1,
      lanes,
      flowScale,
      appliedScale,
      lockedStyle,
      viewState.showDirection
    );
    return;
  }

  if (typeof forwardScore === "number" && forwardScore > 0) {
    const lanes = resolveDirectionalLaneCount(laneCounts, 1);
    drawDirectionalFlowDots(
      ctx,
      road,
      forwardScore,
      time,
      1,
      lanes,
      flowScale,
      appliedScale,
      lockedStyle,
      viewState.showDirection
    );
  }
  if (typeof reverseScore === "number" && reverseScore > 0) {
    const lanes = resolveDirectionalLaneCount(laneCounts, -1);
    drawDirectionalFlowDots(
      ctx,
      road,
      reverseScore,
      time,
      -1,
      lanes,
      flowScale,
      appliedScale,
      lockedStyle,
      viewState.showDirection
    );
  }
}

function drawDirectionalFlowDots(
  ctx: CanvasRenderingContext2D,
  road: RoadRenderCache,
  score: number,
  time: number,
  direction: 1 | -1,
  lanes: number,
  flowScale: number,
  appliedScale: number,
  lockedStyle: LockedOverlayStyle | null,
  showDirection: boolean
) {
  const normalized = normalizeTrafficScore(score);
  if (normalized <= 0) {
    return;
  }
  const color = resolveTrafficOverlayColor(normalized, lockedStyle, 0.9);
  const laneFactor = laneDensityFactor(lanes);
  const density = clampValue((0.12 + normalized * 0.35) * laneFactor * flowScale, 0.06, 0.6);
  const step = Math.max(1, Math.round(1 / density));
  const speed = 0.6 + normalized * 1.4;
  const offset = Math.floor((time * speed * 12) % road.flowSamples.length);
  const radius = 1.4 + normalized * 2.2;
  const markerScale = showDirection ? 1.25 : 1;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  for (let i = 0; i < road.flowSamples.length; i += step) {
    const idx =
      direction === 1
        ? (i + offset) % road.flowSamples.length
        : (road.flowSamples.length + i - offset) % road.flowSamples.length;
    const sample = road.flowSamples[idx];
    const angle = direction === 1 ? sample.angle : sample.angle + Math.PI;
    drawFlowDot(ctx, sample.x, sample.y, radius, angle, markerScale, appliedScale);
  }
  ctx.restore();
}

function drawFlowDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  angle: number,
  markerScale: number,
  appliedScale: number
) {
  const scale = Number.isFinite(appliedScale) && appliedScale > 0 ? appliedScale : 1;
  const headRadius = Math.max(radius * (0.85 + markerScale * 0.15), 2.4 / scale);
  const tailLength = Math.max(headRadius * (2.6 + markerScale * 0.6), 5.5 / scale);
  const tailWidth = Math.max(headRadius * 0.55, 0.9 / scale);
  const headLength = Math.max(headRadius * (1.05 + markerScale * 0.2), 2.6 / scale);
  const headWidth = Math.max(headRadius * 1.1, 2.2 / scale);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const tailStartX = x - dirX * tailLength;
  const tailStartY = y - dirY * tailLength;
  const tailEndX = x - dirX * headRadius * 0.25;
  const tailEndY = y - dirY * headRadius * 0.25;
  const baseAlpha = ctx.globalAlpha;
  ctx.globalAlpha = baseAlpha * 0.55;
  ctx.lineWidth = tailWidth;
  ctx.beginPath();
  ctx.moveTo(tailStartX, tailStartY);
  ctx.lineTo(tailEndX, tailEndY);
  ctx.stroke();
  ctx.globalAlpha = baseAlpha;
  ctx.beginPath();
  ctx.arc(x, y, headRadius, 0, Math.PI * 2);
  ctx.fill();
  const tipX = x + dirX * (headRadius + headLength);
  const tipY = y + dirY * (headRadius + headLength);
  const baseX = x + dirX * headRadius * 0.2;
  const baseY = y + dirY * headRadius * 0.2;
  const perp = angle + Math.PI / 2;
  const halfWidth = headWidth / 2;
  const leftX = baseX + Math.cos(perp) * halfWidth;
  const leftY = baseY + Math.sin(perp) * halfWidth;
  const rightX = baseX - Math.cos(perp) * halfWidth;
  const rightY = baseY - Math.sin(perp) * halfWidth;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(leftX, leftY);
  ctx.lineTo(rightX, rightY);
  ctx.closePath();
  ctx.fill();
}

function drawTrafficPreviewDots(
  ctx: CanvasRenderingContext2D,
  road: RoadRenderCache,
  preview: TrafficPreviewState,
  time: number,
  appliedScale: number
) {
  if (!preview.active || road.flowSamples.length === 0) {
    return;
  }
  const plans = preview.plans.get(road.id);
  if (!plans || plans.length === 0) {
    return;
  }
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineCap = "round";
  for (const plan of plans) {
    const span = Math.min(plan.span, road.flowSamples.length);
    if (span <= 0) {
      continue;
    }
    const offset = Math.floor((time * plan.speed * 12 + plan.offset) % span);
    for (let i = 0; i < span; i += plan.step) {
      const idxInSpan = (i + offset) % span;
      const sampleIdx =
        plan.direction === 1
          ? (plan.startIndex + idxInSpan) % road.flowSamples.length
          : (plan.startIndex + span - 1 - idxInSpan + road.flowSamples.length) %
            road.flowSamples.length;
      const sample = road.flowSamples[sampleIdx];
      const angle = plan.direction === 1 ? sample.angle : sample.angle + Math.PI;
      drawFlowDot(ctx, sample.x, sample.y, plan.radius, angle, 1.15, appliedScale);
    }
  }
  ctx.restore();
}

function buildTrafficPreviewPlans(
  road: RoadRenderCache,
  seed: number,
  flowScale: number
): TrafficPreviewPlan[] {
  const laneCounts = resolveLaneCountsForRoad(road);
  const classWeight = demandWeightForClass(road.roadClass);
  const classFactor = clampValue(classWeight, 0.6, 1.5);
  const baseDensity = 0.18;
  const span = clampValue(Math.round(road.flowSamples.length * 0.35), 12, 60);
  const plans: TrafficPreviewPlan[] = [];
  const candidates: Array<{ direction: 1 | -1; lanes: number }> = [
    { direction: 1, lanes: laneCounts.forward },
    { direction: -1, lanes: laneCounts.backward }
  ];

  for (const candidate of candidates) {
    if (candidate.lanes <= 0) {
      continue;
    }
    const laneFactor = laneDensityFactor(candidate.lanes);
    const density = clampValue(baseDensity * laneFactor * classFactor * flowScale, 0.06, 0.5);
    const step = Math.max(1, Math.round(1 / density));
    const speedJitter = hashUnit(`${road.id}:${candidate.direction}:speed`, seed) * 0.25;
    const speed = 0.5 + classFactor * 0.7 + speedJitter;
    const startIndex = Math.floor(
      hashUnit(`${road.id}:${candidate.direction}:start`, seed) * road.flowSamples.length
    );
    const offset = Math.floor(
      hashUnit(`${road.id}:${candidate.direction}:offset`, seed) * span
    );
    const radius = clampValue(1.1 + laneFactor * 0.6, 1.1, 2.6);
    plans.push({
      direction: candidate.direction,
      step,
      speed,
      offset,
      radius,
      startIndex,
      span
    });
  }
  return plans;
}

function resolveLaneCountsForRoad(road: RoadRenderCache): LaneCounts {
  if (road.laneCounts) {
    return road.laneCounts;
  }
  return { total: 1, forward: 1, backward: 1, inferred: true };
}

function resolveDirectionalLaneCount(counts: LaneCounts, direction: 1 | -1): number {
  const value = direction === 1 ? counts.forward : counts.backward;
  if (value > 0) {
    return value;
  }
  return Math.max(1, counts.total);
}

function resolveCombinedLaneCount(counts: LaneCounts): number {
  if (counts.forward <= 0 || counts.backward <= 0) {
    return Math.max(1, counts.total);
  }
  return Math.max(1, Math.round((counts.forward + counts.backward) / 2));
}

function laneDensityFactor(lanes: number): number {
  return clampValue(Math.sqrt(Math.max(1, lanes)) / Math.sqrt(2), 0.6, 1.6);
}

function flowDensityMultiplier(density: TrafficViewState["flowDensity"]): number {
  if (density === "low") {
    return 0.7;
  }
  if (density === "high") {
    return 1.35;
  }
  return 1;
}

function hashUnit(value: string, seed: number): number {
  const hash = hashString(value);
  const mixed = (hash ^ seed) >>> 0;
  return mixed / 4294967296;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function drawArrowSet(
  ctx: CanvasRenderingContext2D,
  samples: PolylineSample[],
  score: number,
  direction: 1 | -1,
  lockedStyle: LockedOverlayStyle | null
) {
  const normalized = normalizeTrafficScore(score);
  if (normalized <= 0) {
    return;
  }
  const color = resolveTrafficOverlayColor(normalized, lockedStyle, 0.8);
  const size = 4 + normalized * 4;
  ctx.save();
  ctx.fillStyle = color;
  for (const sample of samples) {
    const angle = direction === 1 ? sample.angle : sample.angle + Math.PI;
    drawArrow(ctx, sample.x, sample.y, angle, size);
  }
  ctx.restore();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.65, size * 0.5);
  ctx.lineTo(-size * 0.65, -size * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function renderShadingBitmap(
  cells: HeatmapCell[],
  cellSize: number,
  opacity: number,
  width: number,
  height: number
): HTMLCanvasElement | null {
  if (cells.length === 0 || opacity <= 0) {
    return null;
  }
  let minScore = Infinity;
  let maxScore = -Infinity;
  for (const cell of cells) {
    if (cell.score < minScore) minScore = cell.score;
    if (cell.score > maxScore) maxScore = cell.score;
  }
  const denom = maxScore - minScore || 1;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  const radius = Math.max(cellSize * 0.6, 5);
  for (const cell of cells) {
    const normalized = denom === 0 ? 0 : (cell.score - minScore) / denom;
    const darkness = 1 - normalized;
    if (darkness <= 0) {
      continue;
    }
    const alpha = Math.min(1, darkness * opacity);
    if (alpha <= 0.01) {
      continue;
    }
    ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(cell.pixel.x, cell.pixel.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

function colorForRelativeScore(score: number): [number, number, number] {
  if (score <= 0) {
    return [60, 60, 60];
  }
  if (score >= 1) {
    return [255, 0, 0];
  }
  const stops = [
    { value: 0, color: [0, 102, 204] },
    { value: 0.33, color: [0, 180, 0] },
    { value: 0.66, color: [255, 220, 0] },
    { value: 1, color: [255, 0, 0] }
  ] as const;
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (score >= a.value && score <= b.value) {
      const t = (score - a.value) / (b.value - a.value);
      const r = Math.round(a.color[0] + (b.color[0] - a.color[0]) * t);
      const g = Math.round(a.color[1] + (b.color[1] - a.color[1]) * t);
      const bVal = Math.round(a.color[2] + (b.color[2] - a.color[2]) * t);
      return [r, g, bVal];
    }
  }
  return [255, 0, 0];
}

function applyAlpha(color: string, alpha: number): string {
  const trimmed = color.trim();
  const clamped = clampValue(alpha, 0, 1);
  if (!trimmed) {
    return color;
  }
  if (trimmed.startsWith("#")) {
    let hex = trimmed.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((char) => `${char}${char}`)
        .join("");
    }
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].every((value) => Number.isFinite(value))) {
        return rgba(r, g, b, clamped);
      }
    }
    return color;
  }
  const rgbMatch = trimmed.match(/^rgba?\\(([^)]+)\\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((part) => part.trim());
    if (parts.length >= 3) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${clamped.toFixed(3)})`;
    }
  }
  return color;
}

function parseColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const trimmed = color.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#")) {
    let hex = trimmed.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((char) => `${char}${char}`)
        .join("");
    }
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].every((value) => Number.isFinite(value))) {
        return { r, g, b, a: 1 };
      }
    }
    return null;
  }
  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbMatch) {
    return null;
  }
  const parts = rgbMatch[1].split(",").map((part) => part.trim());
  if (parts.length < 3) {
    return null;
  }
  const parseChannel = (raw: string): number | null => {
    if (raw.endsWith("%")) {
      const pct = Number.parseFloat(raw.slice(0, -1));
      if (!Number.isFinite(pct)) {
        return null;
      }
      return (pct / 100) * 255;
    }
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  };
  const r = parseChannel(parts[0]);
  const g = parseChannel(parts[1]);
  const b = parseChannel(parts[2]);
  if (r === null || g === null || b === null) {
    return null;
  }
  const a =
    parts.length >= 4
      ? clampValue(Number.parseFloat(parts[3]), 0, 1)
      : 1;
  return { r, g, b, a };
}

function shadeColor(color: string, factor: number): string {
  const parsed = parseColor(color);
  if (!parsed) {
    return color;
  }
  const clamped = clampValue(factor, 0, 2);
  const clampByte = (value: number) => Math.min(255, Math.max(0, Math.round(value)));
  return rgba(
    clampByte(parsed.r * clamped),
    clampByte(parsed.g * clamped),
    clampByte(parsed.b * clamped),
    parsed.a
  );
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radiusM = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radiusM * c;
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function pointInShape(p: { x: number; y: number }, shape: Shape): boolean {
  if (shape.kind === "rect") {
    return (
      p.x >= shape.x &&
      p.x <= shape.x + shape.width &&
      p.y >= shape.y &&
      p.y <= shape.y + shape.height
    );
  }
  if (shape.kind === "ellipse") {
    const rx = shape.width / 2;
    const ry = shape.height / 2;
    if (rx === 0 || ry === 0) {
      return false;
    }
    const cx = shape.x + rx;
    const cy = shape.y + ry;
    const dx = (p.x - cx) / rx;
    const dy = (p.y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return pointInPolygon(p, shape.points);
}

function shapeBounds(shape: Shape): { minX: number; maxX: number; minY: number; maxY: number } {
  if (shape.kind === "rect" || shape.kind === "ellipse") {
    return {
      minX: shape.x,
      maxX: shape.x + shape.width,
      minY: shape.y,
      maxY: shape.y + shape.height
    };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of shape.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  return { minX, maxX, minY, maxY };
}

function pointInPolygon(point: { x: number; y: number }, points: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function isPointNear(a: { x: number; y: number }, b: { x: number; y: number }, radius: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= radius * radius;
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function defaultShapeName(type: ZoneType, index: number): string {
  const label =
    type === "candidate" ? "Candidate" : type === "viewer" ? "Viewer" : "Obstacle";
  return `${label} ${index}`;
}

function normalizeShapeName(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed;
}

function normalizeShapeColor(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function cloneShape(shape: Shape): Shape {
  if (shape.kind === "polygon") {
    return {
      ...shape,
      points: shape.points.map((point) => ({ x: point.x, y: point.y })),
      direction: shape.direction ? { ...shape.direction } : shape.direction,
      viewerAnchor: shape.viewerAnchor ? { ...shape.viewerAnchor } : shape.viewerAnchor
    };
  }
  return {
    ...shape,
    direction: shape.direction ? { ...shape.direction } : shape.direction,
    viewerAnchor: shape.viewerAnchor ? { ...shape.viewerAnchor } : shape.viewerAnchor
  };
}

function cloneRoad(road: Road): Road {
  return {
    ...road,
    points: road.points.map((point) => ("x" in point ? { x: point.x, y: point.y } : { lat: point.lat, lon: point.lon })),
    directionLine: road.directionLine
      ? road.directionLine.map((point) =>
          "x" in point ? { x: point.x, y: point.y } : { lat: point.lat, lon: point.lon }
        )
      : undefined
  };
}

function cloneBuilding(building: Building): Building {
  return {
    ...building,
    footprint: building.footprint.map((point) =>
      "x" in point ? { x: point.x, y: point.y } : { lat: point.lat, lon: point.lon }
    )
  };
}

function normalizeViewerDirection(shape: Shape): Shape {
  if (shape.type === "viewer" && shape.direction) {
    shape.direction = {
      angleRad: shape.direction.angleRad,
      coneRad: clampValue(shape.direction.coneRad, MIN_CONE_RAD, MAX_CONE_RAD)
    };
  } else if (shape.type !== "viewer" && shape.direction) {
    delete shape.direction;
  }
  return shape;
}

function prepareIncomingShape(shape: Shape): Shape {
  const normalized = normalizeViewerDirection(cloneShape(shape));
  ensureViewerAnchor(normalized);
  return normalized;
}

function shapeCentroid(shape: Shape): { x: number; y: number } {
  if (shape.kind === "polygon" && shape.points.length > 0) {
    const sum = shape.points.reduce(
      (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
      { x: 0, y: 0 }
    );
    return { x: sum.x / shape.points.length, y: sum.y / shape.points.length };
  }
  if (shape.kind === "ellipse" || shape.kind === "rect") {
    return { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
  }
  return { x: 0, y: 0 };
}

function ensureViewerAnchor(shape: Shape): void {
  if (shape.type !== "viewer") {
    if (shape.viewerAnchor) {
      delete shape.viewerAnchor;
    }
    return;
  }
  if (!shape.viewerAnchor) {
    shape.viewerAnchor = defaultViewerAnchor(shape);
  }
}

function defaultViewerAnchor(shape: Shape): { x: number; y: number } {
  const centroid = shapeCentroid(shape);
  if (shape.kind === "polygon" && !pointInShape(centroid, shape)) {
    for (const point of shape.points) {
      if (pointInShape(point, shape)) {
        return { x: point.x, y: point.y };
      }
    }
  }
  return centroid;
}

function getViewerAnchor(shape: Shape): { x: number; y: number } {
  if (shape.type !== "viewer") {
    return shapeCentroid(shape);
  }
  if (shape.viewerAnchor) {
    return shape.viewerAnchor;
  }
  const fallback = defaultViewerAnchor(shape);
  shape.viewerAnchor = fallback;
  return fallback;
}

function getDirectionHandlePoint(shape: Shape): { x: number; y: number } {
  const anchor = getViewerAnchor(shape);
  if (!shape.direction) {
    return anchor;
  }
  const coneRange = MAX_CONE_RAD - MIN_CONE_RAD || 1;
  const normalized = clampValue((MAX_CONE_RAD - shape.direction.coneRad) / coneRange, 0, 1);
  const distance = HANDLE_MIN_DISTANCE + normalized * (HANDLE_MAX_DISTANCE - HANDLE_MIN_DISTANCE);
  return {
    x: anchor.x + Math.cos(shape.direction.angleRad) * distance,
    y: anchor.y + Math.sin(shape.direction.angleRad) * distance
  };
}

function drawViewerDirectionOverlay(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  isSelected: boolean,
  isEditing: boolean,
  lockedStyle: LockedOverlayStyle | null
) {
  if (shape.type !== "viewer") {
    return;
  }
  const anchor = getViewerAnchor(shape);
  const viewerFill = lockedStyle?.viewerFill ?? "#ffffff";
  const viewerStroke = lockedStyle?.viewerStroke ?? "#ffffff";
  if (isSelected) {
    ctx.save();
    ctx.fillStyle = isEditing ? viewerStroke : applyAlpha(viewerFill, 0.85);
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, isEditing ? 4 : 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (!isEditing || !shape.direction) {
    return;
  }
  const radius = HANDLE_MAX_DISTANCE;
  const startAngle = shape.direction.angleRad - shape.direction.coneRad / 2;
  const endAngle = shape.direction.angleRad + shape.direction.coneRad / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.arc(anchor.x, anchor.y, radius, startAngle, endAngle);
  ctx.closePath();
  ctx.fillStyle = applyAlpha(viewerFill, 0.18);
  ctx.fill();
  ctx.strokeStyle = viewerStroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const handlePoint = getDirectionHandlePoint(shape);
  ctx.beginPath();
  ctx.fillStyle = viewerStroke;
  ctx.arc(handlePoint.x, handlePoint.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
