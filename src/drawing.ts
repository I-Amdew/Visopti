import {
  HeatmapCell,
  Shape,
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
import {
  Point as RoadRenderPoint,
  Bounds as RoadBounds,
  PolylineHit,
  PolylineSample,
  catmullRomSpline,
  distanceToPolyline,
  samplePolyline,
  computeBounds
} from "./roads/geometry";

const POLYGON_CLOSE_RADIUS = 12;
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
const ROAD_ARROW_SPACING = 70;
const ROAD_CURVE_SAMPLES = 12;
const ROAD_DIRECTION_SAMPLES = 10;

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
  | "drawCandidatePolygon"
  | "drawViewerPolygon";

export type RoadToolMode = "off" | "edit";

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
  onRoadSelectionChanged?: (roadId: string | null) => void;
  onRoadEditSelectionChanged?: (selection: RoadEditSelection) => void;
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
  roadRenderIndex: Record<string, RoadRenderCache>;
  autoRoadRender: RoadRenderCache[];
  customRoadRender: RoadRenderCache[];
  buildingRender: BuildingRenderCache[];
  trafficByRoadId: TrafficByRoadId;
  trafficViewState: TrafficViewState;
  trafficOverlayEnabled: boolean;
  roadDirectionOverlayEnabled: boolean;
  selectedRoadId: string | null;
  selectedShapeId: string | null;
  currentTool: ToolMode;
  roadToolMode: RoadToolMode;
  roadEdit: RoadEditState;
  customRoadsDirty: boolean;
  geoMapper: GeoMapper | null;
  dragState: DragState | null;
  polygonDraft: PolygonDraft | null;
  pointer: { x: number; y: number } | null;
  view: ViewState;
  panDrag: PanDragState | null;
  directionDrag: DirectionDragState | null;
  activeViewerEditId: string | null;
  visibilityFilter: Record<ZoneType, boolean>;
  zoneOpacity: Record<ZoneType, number>;
  heatmapOpacity: number;
  shadingOpacity: number;
  showContours: boolean;
  contourOpacity: number;
}

interface DragState {
  start: { x: number; y: number };
  current: { x: number; y: number };
  kind: "ellipse";
  zone: ZoneType;
}

interface PolygonDraft {
  zone: ZoneType;
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
  showDirectionLine: boolean;
}

interface BuildingRenderCache {
  id: string;
  points: RoadRenderPoint[];
  bounds: RoadBounds | null;
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

interface TrafficScores {
  combined: number | null;
  forward?: number;
  reverse?: number;
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
  setGeoMapper(mapper: GeoMapper | null): void;
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
  setRoadData(data: { autoRoads: Road[]; customRoads: Road[] }): void;
  setBuildings(buildings: Building[]): void;
  setTrafficData(trafficByRoadId: TrafficByRoadId, trafficViewState: TrafficViewState): void;
  setTrafficOverlayEnabled(enabled: boolean): void;
  setRoadDirectionOverlayEnabled(enabled: boolean): void;
  setModel(data: {
    autoRoads?: Road[];
    customRoads?: Road[];
    buildings?: Building[];
    trafficByRoadId?: TrafficByRoadId;
    trafficViewState?: TrafficViewState;
    geoMapper?: GeoMapper | null;
  }): void;
  getSelectedRoadId(): string | null;
  setSelectedRoadId(id: string | null): void;
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
    onRoadSelectionChanged,
    onRoadEditSelectionChanged
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
    roadRenderIndex: {},
    autoRoadRender: [],
    customRoadRender: [],
    buildingRender: [],
    trafficByRoadId: {},
    trafficViewState: {
      preset: "default",
      hour: 12,
      showDirection: false
    },
    trafficOverlayEnabled: false,
    roadDirectionOverlayEnabled: true,
    selectedRoadId: null,
    selectedShapeId: null,
    currentTool: "select",
    roadToolMode: "off",
    roadEdit: {
      draft: null,
      drag: null,
      selectedPointIndex: null
    },
    customRoadsDirty: false,
    geoMapper: null,
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
    contourOpacity: 0.9
  };
  const notifyInteraction = () => {
    onInteraction?.();
  };
  const notifyRoadSelection = () => {
    onRoadSelectionChanged?.(state.selectedRoadId);
  };
  let lastCanvasWidth = canvas.width;
  let lastCanvasHeight = canvas.height;
  let lastRoadEditSelection: RoadEditSelection = {
    roadId: null,
    pointIndex: null,
    hasDraft: false
  };

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

  function notifyShapes() {
    onShapesChanged?.(state.shapes.slice());
  }

  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    const appliedScale = state.view.scale * state.view.baseScale;
    ctx.setTransform(appliedScale, 0, 0, appliedScale, state.view.offsetX, state.view.offsetY);
    ctx.drawImage(baseImage, 0, 0, baseWidth, baseHeight);
    if (state.shadingBitmap) {
      ctx.drawImage(state.shadingBitmap, 0, 0, baseWidth, baseHeight);
    }
    if (state.showContours && state.contours) {
      drawContours(ctx, state.contours, state.contourOpacity);
    }
    drawBuildings(ctx, state);
    drawRoads(ctx, state);
    drawShapes(ctx, state);
    if (state.heatmapBitmap) {
      ctx.drawImage(state.heatmapBitmap, 0, 0, baseWidth, baseHeight);
    }
    if (state.bestHeatmapCell) {
      drawBestCellMarker(ctx, state.bestHeatmapCell.pixel.x, state.bestHeatmapCell.pixel.y);
    }
    drawPreviews(ctx, state);
    ctx.restore();
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

    if (state.roadToolMode === "edit") {
      handleRoadMouseDown(pos);
      return;
    }

    switch (state.currentTool) {
      case "select": {
        const selectedShape = selectShapeAt(pos);
        if (selectedShape) {
          setSelectedRoadId(null);
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
          state.selectedShapeId = null;
        }
        redraw();
        return;
      }
      case "erase":
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
      if (maybeClosePolygon(pos, drawInfo.zone)) {
        redraw();
        return;
      }
      extendPolygon(pos, drawInfo.zone);
      redraw();
      return;
    }

    if (drawInfo.kind === "ellipse") {
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

  function commitDragShape() {
    const drag = state.dragState;
    state.dragState = null;
    if (!drag) {
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
    const shape = createEllipseShape(drag.zone, x, y, Math.abs(width), Math.abs(height));
    state.shapes.push(prepareIncomingShape(shape));
    notifyShapes();
    redraw();
  }

  function selectShapeAt(pos: { x: number; y: number }): Shape | null {
    const target = hitTest(pos, state.shapes, state.visibilityFilter);
    state.selectedShapeId = target?.id ?? null;
    if (!target || target.type !== "viewer") {
      state.activeViewerEditId = null;
    }
    return target ?? null;
  }

  function setSelectedRoadId(nextId: string | null, shouldNotify = true) {
    if (state.selectedRoadId === nextId) {
      return;
    }
    state.selectedRoadId = nextId;
    if (nextId) {
      state.selectedShapeId = null;
    }
    state.roadEdit.selectedPointIndex = null;
    state.roadEdit.drag = null;
    notifyRoadEditSelection(shouldNotify);
    if (shouldNotify) {
      notifyRoadSelection();
    }
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

  function resolveMapPoint(point: MapPoint, mapper: GeoMapper | null): RoadRenderPoint | null {
    if ("x" in point && "y" in point) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return null;
      }
      return { x: point.x, y: point.y };
    }
    if ("lat" in point && "lon" in point && mapper) {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
        return null;
      }
      return mapper.latLonToPixel(point.lat, point.lon);
    }
    return null;
  }

  function mapPoints(points: MapPoint[]): RoadRenderPoint[] {
    const mapped: RoadRenderPoint[] = [];
    for (const point of points) {
      const resolved = resolveMapPoint(point, state.geoMapper);
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
      if (!state.geoMapper) {
        return null;
      }
      const { lat, lon } = state.geoMapper.pixelToLatLon(pixel.x, pixel.y);
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
    return {
      id: road.id,
      source,
      controlPoints,
      renderPoints,
      directionPoints,
      bounds,
      arrowSamples: samplePolyline(renderPoints, ROAD_ARROW_SPACING),
      showDirectionLine: !!road.showDirectionLine
    };
  }

  function rebuildRoadCaches() {
    const autoRender: RoadRenderCache[] = [];
    const customRender: RoadRenderCache[] = [];
    const index: Record<string, RoadRenderCache> = {};
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
    state.autoRoadRender = autoRender;
    state.customRoadRender = customRender;
    state.roadRenderIndex = index;
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
  }

  function rebuildBuildingCaches() {
    const render: BuildingRenderCache[] = [];
    for (const building of state.buildings) {
      const points = mapPoints(building.footprint);
      if (points.length < 3) {
        continue;
      }
      render.push({
        id: building.id,
        points,
        bounds: computeBounds(points)
      });
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
    state.selectedShapeId = null;
    if (state.directionDrag?.shapeId === target.id) {
      finishViewerConeEdit(false);
    }
    return true;
  }

  function extendPolygon(point: { x: number; y: number }, zone: ZoneType) {
    if (!state.polygonDraft || state.polygonDraft.zone !== zone) {
      state.polygonDraft = {
        zone,
        points: []
      };
    }
    state.polygonDraft.points.push(point);
  }

  function maybeClosePolygon(point: { x: number; y: number }, zone: ZoneType): boolean {
    const poly = state.polygonDraft;
    if (!poly || poly.zone !== zone || poly.points.length < 3) {
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
    const shape: Shape = {
      id: createId(),
      kind: "polygon",
      type: poly.zone,
      alpha: zoneAlpha(poly.zone),
      points: poly.points.slice()
    };
    state.shapes.push(prepareIncomingShape(shape));
    state.polygonDraft = null;
    notifyShapes();
    redraw();
  }

  function startRoadDraft(point: RoadRenderPoint) {
    state.roadEdit.draft = {
      points: [point],
      storeMode: state.geoMapper ? "geo" : "pixel"
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
    const points: MapPoint[] =
      draft.storeMode === "geo" && state.geoMapper
        ? draft.points.map((p) => {
            const { lat, lon } = state.geoMapper!.pixelToLatLon(p.x, p.y);
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
      state.selectedShapeId = null;
      beginRoadDrag(controlHit.roadId, controlHit.pointIndex);
      redraw();
      return;
    }
    if (insertPointOnSelectedRoad(point)) {
      state.selectedShapeId = null;
      return;
    }
    const road = selectRoadAt(point, true);
    if (road) {
      state.selectedShapeId = null;
      redraw();
      return;
    }
    setSelectedRoadId(null);
    state.selectedShapeId = null;
    startRoadDraft(point);
    redraw();
  }

  const api: DrawingManager = {
    getShapes() {
      return state.shapes.slice();
    },
    setShapes(shapes: Shape[]) {
      state.shapes = shapes.map((shape) => prepareIncomingShape(shape));
      state.selectedShapeId = null;
      state.polygonDraft = null;
      if (state.directionDrag || state.activeViewerEditId) {
        finishViewerConeEdit(false);
      }
      notifyShapes();
      redraw();
    },
    clearShapes() {
      state.shapes = [];
      state.selectedShapeId = null;
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
      state.selectedShapeId = null;
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
    setGeoMapper(mapper: GeoMapper | null) {
      state.geoMapper = mapper;
      rebuildRoadCaches();
      rebuildBuildingCaches();
      syncRoadSelection();
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
    setTrafficData(trafficByRoadId: TrafficByRoadId, trafficViewState: TrafficViewState) {
      state.trafficByRoadId = trafficByRoadId;
      state.trafficViewState = { ...trafficViewState };
      redraw();
    },
    setTrafficOverlayEnabled(enabled: boolean) {
      state.trafficOverlayEnabled = enabled;
      redraw();
    },
    setRoadDirectionOverlayEnabled(enabled: boolean) {
      state.roadDirectionOverlayEnabled = enabled;
      redraw();
    },
    setModel(data: {
      autoRoads?: Road[];
      customRoads?: Road[];
      buildings?: Building[];
      trafficByRoadId?: TrafficByRoadId;
      trafficViewState?: TrafficViewState;
      geoMapper?: GeoMapper | null;
    }) {
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
      redraw();
    },
    getSelectedRoadId() {
      return state.selectedRoadId;
    },
    setSelectedRoadId(id: string | null) {
      setSelectedRoadId(id);
      redraw();
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

function drawShapes(ctx: CanvasRenderingContext2D, state: DrawingManagerState) {
  for (const shape of state.shapes) {
    if (!state.visibilityFilter[shape.type]) {
      continue;
    }
    ctx.save();
    const fillAlpha = shape.alpha * (state.zoneOpacity[shape.type] ?? 1);
    ctx.fillStyle = zoneFill(shape.type, fillAlpha);
    ctx.strokeStyle = outlineColor(shape.type);
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
        state.activeViewerEditId === shape.id
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
      }
    }
    ctx.restore();
  }
}

function drawBuildings(ctx: CanvasRenderingContext2D, state: DrawingManagerState) {
  if (state.buildingRender.length === 0) {
    return;
  }
  ctx.save();
  ctx.fillStyle = "rgba(40,40,40,0.35)";
  ctx.strokeStyle = "rgba(15,15,15,0.65)";
  ctx.lineWidth = 1;
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
}

function drawRoads(ctx: CanvasRenderingContext2D, state: DrawingManagerState) {
  if (state.autoRoadRender.length === 0 && state.customRoadRender.length === 0) {
    return;
  }
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const roadGroups: Array<{ roads: RoadRenderCache[]; baseColor: string; baseWidth: number }> = [
    { roads: state.autoRoadRender, baseColor: "rgba(255,255,255,0.65)", baseWidth: 2 },
    { roads: state.customRoadRender, baseColor: "rgba(0,200,255,0.8)", baseWidth: 3 }
  ];

  for (const group of roadGroups) {
    for (const road of group.roads) {
      strokePolyline(ctx, road.renderPoints, group.baseColor, group.baseWidth);
      if (state.trafficOverlayEnabled) {
        const traffic = resolveTrafficScores(state.trafficByRoadId, state.trafficViewState, road.id);
        if (traffic) {
          const normalized = normalizeTrafficScore(traffic.combined);
          if (normalized > 0) {
            const [r, g, b] = colorForRelativeScore(normalized);
            const width = group.baseWidth + 1 + normalized * 4;
            strokePolyline(ctx, road.renderPoints, rgba(r, g, b, 0.85), width);
          }
          if (state.trafficViewState.showDirection) {
            drawTrafficArrows(ctx, road, traffic);
          }
        }
      }
      if (
        state.roadDirectionOverlayEnabled &&
        road.showDirectionLine &&
        road.directionPoints &&
        road.directionPoints.length >= 2
      ) {
        ctx.save();
        ctx.setLineDash([6, 6]);
        strokePolyline(ctx, road.directionPoints, "rgba(255,255,255,0.85)", 1.5);
        ctx.restore();
      }
      if (state.selectedRoadId === road.id) {
        strokePolyline(ctx, road.renderPoints, "rgba(255,255,255,0.6)", group.baseWidth + 2);
      }
    }
  }
  ctx.restore();
}

function drawPreviews(ctx: CanvasRenderingContext2D, state: DrawingManagerState) {
  const drag = state.dragState;
  if (drag) {
    if (state.visibilityFilter[drag.zone]) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = outlineColor(drag.zone);
      ctx.fillStyle = zoneFill(drag.zone, 0.15);
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
  }

  const poly = state.polygonDraft;
  if (poly) {
    if (state.visibilityFilter[poly.zone]) {
      ctx.save();
      ctx.strokeStyle = outlineColor(poly.zone);
      ctx.fillStyle = zoneFill(poly.zone, 0.2);
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
        drawPolygonCloseHandle(ctx, first, poly.zone, highlight);
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
  highlight: boolean
) {
  ctx.save();
  ctx.lineWidth = highlight ? 3 : 1.5;
  ctx.strokeStyle = highlight ? "#ffffff" : outlineColor(zone);
  ctx.fillStyle = highlight ? "rgba(255,255,255,0.9)" : zoneFill(zone, 0.45);
  ctx.beginPath();
  ctx.arc(point.x, point.y, POLYGON_CLOSE_RADIUS, 0, Math.PI * 2);
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

function toolToDrawInfo(tool: ToolMode): { zone: ZoneType; kind: "ellipse" | "polygon" } | null {
  switch (tool) {
    case "drawViewerPolygon":
      return { zone: "viewer", kind: "polygon" };
    case "drawCandidatePolygon":
      return { zone: "candidate", kind: "polygon" };
    case "drawObstaclePolygon":
      return { zone: "obstacle", kind: "polygon" };
    case "drawObstacleEllipse":
      return { zone: "obstacle", kind: "ellipse" };
    default:
      return null;
  }
}

function createEllipseShape(
  zone: ZoneType,
  x: number,
  y: number,
  width: number,
  height: number
): Shape {
  return {
    id: createId(),
    kind: "ellipse",
    type: zone,
    alpha: zoneAlpha(zone),
    x,
    y,
    width,
    height
  };
}

function zoneAlpha(zone: ZoneType): number {
  return 1;
}

function zoneFill(zone: ZoneType, alpha: number): string {
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

function outlineColor(zone: ZoneType): string {
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
    if (!visibility[shape.type]) {
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

function drawTrafficArrows(
  ctx: CanvasRenderingContext2D,
  road: RoadRenderCache,
  traffic: TrafficScores
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
    drawArrowSet(ctx, road.arrowSamples, forward, 1);
  }
  if (typeof reverse === "number") {
    drawArrowSet(ctx, road.arrowSamples, reverse, -1);
  }
}

function drawArrowSet(
  ctx: CanvasRenderingContext2D,
  samples: PolylineSample[],
  score: number,
  direction: 1 | -1
) {
  const normalized = normalizeTrafficScore(score);
  if (normalized <= 0) {
    return;
  }
  const [r, g, b] = colorForRelativeScore(normalized);
  const size = 4 + normalized * 4;
  ctx.save();
  ctx.fillStyle = rgba(r, g, b, 0.8);
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

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
  isEditing: boolean
) {
  if (shape.type !== "viewer") {
    return;
  }
  const anchor = getViewerAnchor(shape);
  if (isSelected) {
    ctx.save();
    ctx.fillStyle = isEditing ? "#ffffff" : "rgba(255,255,255,0.85)";
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
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const handlePoint = getDirectionHandlePoint(shape);
  ctx.beginPath();
  ctx.fillStyle = "#ffffff";
  ctx.arc(handlePoint.x, handlePoint.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
