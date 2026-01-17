import type { FacePriorityArc, ImportedModelRef, StructureMode } from "./types";
import { resolveFacePriorityIndices } from "./structureOptimizer";
import {
  findClosestEdgeIndex,
  isPolygonSimple,
  normalizeRing,
  polygonArea,
  polygonCentroid,
  polygonPerimeter,
  polygonSignedArea
} from "./structureGeometry";
import { deleteAsset, getAsset, putAsset } from "./assets/assetsDb";
import { buildFootprintProxy, loadModelFromBuffer } from "./assets/modelLoader";

const FEET_TO_METERS = 0.3048;
const METERS_TO_FEET = 1 / FEET_TO_METERS;
const MIN_HEIGHT_FT = 1;
const ROTATE_SNAP_DEG = 15;
const HANDLE_RADIUS = 6;
const CENTER_RADIUS = 6;
const ROTATE_HANDLE_RADIUS = 7;
const ROTATE_HANDLE_OFFSET = 28;
const EDGE_HOVER_DISTANCE = 12;

export type StructureEditorMode =
  | "select"
  | "draw_polygon"
  | "edit_vertices"
  | "move"
  | "rotate"
  | "face_priority";

export interface StructureEditorState {
  mode: StructureMode;
  centerPx: { x: number; y: number };
  footprintPoints: { x: number; y: number }[];
  heightMeters: number;
  rotationDeg: number;
  placeAtCenter: boolean;
  facePriority?: FacePriorityArc;
  imported?: ImportedModelRef;
}

export interface StructureFrameInfo {
  widthPx: number;
  heightPx: number;
  widthM: number;
  heightM: number;
}

interface StructureEditorOptions {
  modal: HTMLElement;
  canvas: HTMLCanvasElement;
  rotationInput: HTMLInputElement;
  heightInput: HTMLInputElement;
  heightSlider: HTMLInputElement;
  perimeterValue: HTMLElement;
  areaValue: HTMLElement;
  frontEdgeValue: HTMLElement;
  tabButtons: HTMLButtonElement[];
  tabPanels: HTMLElement[];
  toolButtons: HTMLButtonElement[];
  arcButtons: HTMLButtonElement[];
  importFileInput: HTMLInputElement;
  importNameValue: HTMLElement;
  importFormatValue: HTMLElement;
  importScaleInput: HTMLInputElement;
  importRotationInput: HTMLInputElement;
  importOffsetXInput: HTMLInputElement;
  importOffsetYInput: HTMLInputElement;
  importOffsetZInput: HTMLInputElement;
  importGenerateProxyButton: HTMLButtonElement;
  importProxyStatus: HTMLElement;
  closeButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  applyButton: HTMLButtonElement;
  onApply: (state: StructureEditorState) => void;
  onCancel?: () => void;
}

interface Viewport {
  frameWidth: number;
  frameHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  pixelsPerMeterX: number;
  pixelsPerMeterY: number;
}

type DragMode = "move" | "rotate" | "vertex";

type StructureEditorDraftUpdate = Omit<Partial<StructureEditorState>, "imported"> & {
  imported?: Partial<ImportedModelRef>;
};

interface DragState {
  mode: DragMode;
  pointerId: number;
  startPointerFrame: { x: number; y: number };
  startCenterFrame: { x: number; y: number };
  startRotationDeg: number;
  startFootprint: { x: number; y: number }[];
  vertexIndex?: number;
  rotateStartAngle?: number;
}

export function createStructureEditor(options: StructureEditorOptions) {
  const {
    modal,
    canvas,
    rotationInput,
    heightInput,
    heightSlider,
    perimeterValue,
    areaValue,
    frontEdgeValue,
    tabButtons,
    tabPanels,
    toolButtons,
    arcButtons,
    importFileInput,
    importNameValue,
    importFormatValue,
    importScaleInput,
    importRotationInput,
    importOffsetXInput,
    importOffsetYInput,
    importOffsetZInput,
    importGenerateProxyButton,
    importProxyStatus,
    closeButton,
    cancelButton,
    applyButton,
    onApply,
    onCancel
  } = options;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Structure editor canvas 2D context unavailable.");
  }

  let isOpen = false;
  let mode: StructureEditorMode = "select";
  let arcChoice: FacePriorityArc["arcDeg"] = 180;
  let draft: StructureEditorState | null = null;
  let pendingAssetIds = new Set<string>();
  let frameInfo: StructureFrameInfo | null = null;
  let dragState: DragState | null = null;
  let lastFocus: HTMLElement | null = null;
  let canvasSize = { width: 0, height: 0 };
  let draftPointsFrame: { x: number; y: number }[] = [];
  let draftPointerFrame: { x: number; y: number } | null = null;
  let hoverEdgeIndex: number | null = null;
  let hoverEdgePoint: { x: number; y: number } | null = null;

  const resizeObserver = new ResizeObserver(() => {
    if (!isOpen) {
      return;
    }
    resizeCanvas();
    render();
  });
  resizeObserver.observe(canvas);

  const resizeCanvas = () => {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    if (nextWidth === canvasSize.width && nextHeight === canvasSize.height) {
      return;
    }
    canvasSize = { width: nextWidth, height: nextHeight };
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(nextWidth * dpr));
    canvas.height = Math.max(1, Math.round(nextHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const normalizeRotation = (value: number) => {
    if (!Number.isFinite(value)) {
      return 0;
    }
    let next = value % 360;
    if (next < 0) {
      next += 360;
    }
    return next;
  };

  const formatDisplay = (value: number, decimals = 1) => {
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

  const formatInput = (value: number, decimals = 1) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    const factor = 10 ** decimals;
    return (Math.round(value * factor) / factor).toString();
  };

  const normalizeImported = (
    value: ImportedModelRef | undefined
  ): ImportedModelRef | undefined => {
    if (!value) {
      return undefined;
    }
    const offset = value.offset ?? { x: 0, y: 0, z: 0 };
    const points = value.footprintProxy?.points ?? [];
    return {
      assetId: value.assetId,
      name: value.name ?? value.assetId,
      format: value.format,
      scale: Number.isFinite(value.scale) && value.scale > 0 ? value.scale : 1,
      rotationDeg: Number.isFinite(value.rotationDeg) ? value.rotationDeg : 0,
      offset: {
        x: Number.isFinite(offset.x) ? offset.x : 0,
        y: Number.isFinite(offset.y) ? offset.y : 0,
        z: Number.isFinite(offset.z) ? offset.z : 0
      },
      footprintProxy:
        points.length >= 3
          ? { points: points.map((point) => ({ x: point.x, y: point.y })) }
          : undefined
    };
  };

  const isImportedRef = (value: Partial<ImportedModelRef>): value is ImportedModelRef =>
    typeof value.assetId === "string" &&
    typeof value.name === "string" &&
    (value.format === "glb" ||
      value.format === "gltf" ||
      value.format === "obj" ||
      value.format === "stl") &&
    Boolean(value.offset);

  const syncTabState = () => {
    const active = draft?.mode ?? "parametric";
    tabButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.structureTab === active);
    });
    tabPanels.forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.structurePanel === active);
    });
    const importedActive = active === "imported";
    toolButtons.forEach((button) => {
      button.disabled = importedActive;
    });
    arcButtons.forEach((button) => {
      button.disabled = importedActive;
    });
    if (importedActive) {
      canvas.style.cursor = "default";
    }
  };

  const syncImportInputs = () => {
    const imported = draft?.imported;
    importNameValue.textContent = imported?.name ?? "None";
    importFormatValue.textContent = imported?.format ? imported.format.toUpperCase() : "--";
    const scaleValue = imported ? formatInput(imported.scale, 3) : "";
    const rotationValue = imported ? formatInput(imported.rotationDeg, 0) : "";
    const offset = imported?.offset ?? { x: 0, y: 0, z: 0 };
    if (document.activeElement !== importScaleInput) {
      importScaleInput.value = scaleValue;
    }
    if (document.activeElement !== importRotationInput) {
      importRotationInput.value = rotationValue;
    }
    if (document.activeElement !== importOffsetXInput) {
      importOffsetXInput.value = formatInput(offset.x, 2);
    }
    if (document.activeElement !== importOffsetYInput) {
      importOffsetYInput.value = formatInput(offset.y, 2);
    }
    if (document.activeElement !== importOffsetZInput) {
      importOffsetZInput.value = formatInput(offset.z, 2);
    }
    const hasProxy = Boolean(imported?.footprintProxy?.points?.length);
    importProxyStatus.textContent = hasProxy
      ? `${imported?.footprintProxy?.points.length ?? 0} pts`
      : "None";
    const hasImported = Boolean(imported);
    importScaleInput.disabled = !hasImported;
    importRotationInput.disabled = !hasImported;
    importOffsetXInput.disabled = !hasImported;
    importOffsetYInput.disabled = !hasImported;
    importOffsetZInput.disabled = !hasImported;
    importGenerateProxyButton.disabled = !hasImported;
  };

  const cleanupPendingAssets = (keepId?: string) => {
    const ids = Array.from(pendingAssetIds);
    pendingAssetIds.clear();
    ids.forEach((id) => {
      if (id !== keepId) {
        void deleteAsset(id);
      }
    });
  };

  const createAssetId = () => {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return `asset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  };

  const resolveFormat = (name: string): ImportedModelRef["format"] | null => {
    const ext = name.split(".").pop()?.toLowerCase();
    if (ext === "glb" || ext === "gltf" || ext === "obj" || ext === "stl") {
      return ext;
    }
    return null;
  };

  const computeViewport = (): Viewport => {
    const frameWidth = Math.max(1, frameInfo?.widthPx ?? canvasSize.width);
    const frameHeight = Math.max(1, frameInfo?.heightPx ?? canvasSize.height);
    const fallbackWidthM = frameWidth * FEET_TO_METERS;
    const fallbackHeightM = frameHeight * FEET_TO_METERS;
    const widthM = Math.max(0.1, frameInfo?.widthM ?? fallbackWidthM);
    const heightM = Math.max(0.1, frameInfo?.heightM ?? fallbackHeightM);
    const availableWidth = Math.max(1, canvasSize.width - 64);
    const availableHeight = Math.max(1, canvasSize.height - 64);
    const scale = Math.min(availableWidth / frameWidth, availableHeight / frameHeight);
    const safeScale = Number.isFinite(scale) ? Math.max(0.05, scale) : 1;
    const offsetX = (canvasSize.width - frameWidth * safeScale) / 2;
    const offsetY = (canvasSize.height - frameHeight * safeScale) / 2;
    return {
      frameWidth,
      frameHeight,
      scale: safeScale,
      offsetX,
      offsetY,
      pixelsPerMeterX: frameWidth / widthM,
      pixelsPerMeterY: frameHeight / heightM
    };
  };

  const toCanvas = (point: { x: number; y: number }, view: Viewport) => ({
    x: view.offsetX + point.x * view.scale,
    y: view.offsetY + point.y * view.scale
  });

  const toFrame = (point: { x: number; y: number }, view: Viewport) => ({
    x: (point.x - view.offsetX) / view.scale,
    y: (point.y - view.offsetY) / view.scale
  });

  const localToFrame = (
    point: { x: number; y: number },
    view: Viewport,
    center: { x: number; y: number },
    rotationDeg: number
  ) => {
    const angle = (normalizeRotation(rotationDeg) * Math.PI) / 180;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const scaledX = point.x * view.pixelsPerMeterX;
    const scaledY = point.y * view.pixelsPerMeterY;
    return {
      x: center.x + scaledX * cosA - scaledY * sinA,
      y: center.y + scaledX * sinA + scaledY * cosA
    };
  };

  const frameToLocal = (
    point: { x: number; y: number },
    view: Viewport,
    center: { x: number; y: number },
    rotationDeg: number
  ) => {
    const angle = (normalizeRotation(rotationDeg) * Math.PI) / 180;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const localPxX = dx * cosA + dy * sinA;
    const localPxY = -dx * sinA + dy * cosA;
    return {
      x: localPxX / view.pixelsPerMeterX,
      y: localPxY / view.pixelsPerMeterY
    };
  };

  const getCanvasPoint = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const getFootprintPoints = () => {
    if (!draft) {
      return [];
    }
    return normalizeRing(draft.footprintPoints);
  };

  const getFootprintFramePoints = (view: Viewport) => {
    const currentDraft = draft;
    if (!currentDraft) {
      return [];
    }
    const points = getFootprintPoints();
    return points.map((point) =>
      localToFrame(point, view, currentDraft.centerPx, currentDraft.rotationDeg)
    );
  };

  const getFootprintCanvasPoints = (view: Viewport) =>
    getFootprintFramePoints(view).map((point) => toCanvas(point, view));

  const getRotateHandle = (canvasPoints: { x: number; y: number }[]) => {
    if (canvasPoints.length === 0) {
      return null;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    for (const point of canvasPoints) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
    }
    return {
      x: (minX + maxX) / 2,
      y: minY - ROTATE_HANDLE_OFFSET
    };
  };

  const pointInPolygon = (point: { x: number; y: number }, polygon: { x: number; y: number }[]) => {
    if (polygon.length < 3) {
      return false;
    }
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;
      const intersect =
        yi > point.y !== yj > point.y &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi;
      if (intersect) {
        inside = !inside;
      }
    }
    return inside;
  };

  const drawLabel = (text: string, x: number, y: number) => {
    ctx.save();
    ctx.font = "12px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const metrics = ctx.measureText(text);
    const paddingX = 6;
    const width = metrics.width + paddingX * 2;
    const height = 18;
    ctx.fillStyle = "rgba(12, 18, 26, 0.85)";
    ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
    ctx.lineWidth = 1;
    ctx.fillRect(x - width / 2, y - height / 2, width, height);
    ctx.strokeRect(x - width / 2, y - height / 2, width, height);
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(text, x, y);
    ctx.restore();
  };

  const updateReadouts = () => {
    if (!draft) {
      return;
    }
    const points = getFootprintPoints();
    if (points.length < 3) {
      perimeterValue.textContent = "--";
      areaValue.textContent = "--";
    } else {
      const perimeterM = polygonPerimeter(points);
      const areaM2 = polygonArea(points);
      const perimeterFt = perimeterM * METERS_TO_FEET;
      const areaFt2 = areaM2 * METERS_TO_FEET * METERS_TO_FEET;
      perimeterValue.textContent = `${formatDisplay(perimeterFt, 1)} ft`;
      areaValue.textContent = `${formatDisplay(areaFt2, 0)} sq ft`;
    }
    const primaryEdgeIndex = draft.facePriority?.primaryEdgeIndex;
    frontEdgeValue.textContent =
      primaryEdgeIndex === undefined || points.length < 2
        ? "None"
        : `Edge ${primaryEdgeIndex + 1}`;
  };

  const syncInputs = () => {
    if (!draft) {
      return;
    }
    const heightFt = Math.max(MIN_HEIGHT_FT, draft.heightMeters * METERS_TO_FEET);
    if (document.activeElement !== heightInput) {
      heightInput.value = formatInput(heightFt, 1);
    }
    if (document.activeElement !== heightSlider) {
      heightSlider.value = formatInput(heightFt, 0);
    }
    if (document.activeElement !== rotationInput) {
      rotationInput.value = formatInput(normalizeRotation(draft.rotationDeg), 0);
    }
  };

  const drawHandle = (x: number, y: number, radius: number, fill: string) => {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "rgba(226, 232, 240, 0.95)";
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  const renderDraftPolygon = (view: Viewport) => {
    if (draftPointsFrame.length === 0) {
      return;
    }
    const pointsCanvas = draftPointsFrame.map((point) => toCanvas(point, view));
    ctx.save();
    ctx.strokeStyle = "rgba(250, 204, 21, 0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pointsCanvas[0].x, pointsCanvas[0].y);
    for (let i = 1; i < pointsCanvas.length; i += 1) {
      ctx.lineTo(pointsCanvas[i].x, pointsCanvas[i].y);
    }
    if (draftPointerFrame) {
      const pointerCanvas = toCanvas(draftPointerFrame, view);
      ctx.lineTo(pointerCanvas.x, pointerCanvas.y);
    }
    ctx.stroke();
    for (const point of pointsCanvas) {
      drawHandle(point.x, point.y, HANDLE_RADIUS - 1, "rgba(15, 23, 42, 0.8)");
    }
    ctx.restore();
  };

  const render = () => {
    if (!draft) {
      return;
    }
    resizeCanvas();
    const view = computeViewport();
    ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);
    ctx.fillStyle = "#0c1117";
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

    const frameCanvas = {
      x: view.offsetX,
      y: view.offsetY,
      width: view.frameWidth * view.scale,
      height: view.frameHeight * view.scale
    };
    ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(frameCanvas.x, frameCanvas.y, frameCanvas.width, frameCanvas.height);

    const pointsFrame = getFootprintFramePoints(view);
    const pointsCanvas = pointsFrame.map((point) => toCanvas(point, view));

    if (pointsCanvas.length >= 3) {
      ctx.fillStyle = "rgba(92, 194, 242, 0.18)";
      ctx.strokeStyle = "rgba(125, 211, 252, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pointsCanvas[0].x, pointsCanvas[0].y);
      for (let i = 1; i < pointsCanvas.length; i += 1) {
        ctx.lineTo(pointsCanvas[i].x, pointsCanvas[i].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    const prioritized = draft.facePriority
      ? new Set(resolveFacePriorityIndices(pointsCanvas.length, draft.facePriority))
      : new Set<number>();
    const primaryIndex = draft.facePriority?.primaryEdgeIndex ?? -1;

    if (pointsCanvas.length >= 2) {
      for (let i = 0; i < pointsCanvas.length; i += 1) {
        const next = (i + 1) % pointsCanvas.length;
        const isPrimary = i === primaryIndex;
        const isPrioritized = prioritized.has(i);
        ctx.strokeStyle = isPrimary
          ? "rgba(56, 189, 248, 0.95)"
          : isPrioritized
            ? "rgba(56, 189, 248, 0.5)"
            : "rgba(148, 163, 184, 0.5)";
        ctx.lineWidth = isPrimary ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(pointsCanvas[i].x, pointsCanvas[i].y);
        ctx.lineTo(pointsCanvas[next].x, pointsCanvas[next].y);
        ctx.stroke();
      }
    }

    if (mode === "draw_polygon") {
      renderDraftPolygon(view);
    }

    if (pointsCanvas.length >= 1) {
      if (mode === "edit_vertices" || mode === "select") {
        for (const point of pointsCanvas) {
          drawHandle(point.x, point.y, HANDLE_RADIUS, "#1f2937");
        }
      }
      if (mode === "move" || mode === "select") {
        const centerCanvas = toCanvas(draft.centerPx, view);
        drawHandle(centerCanvas.x, centerCanvas.y, CENTER_RADIUS, "rgba(15, 23, 42, 0.9)");
      }
      if (mode === "rotate" || mode === "select") {
        const rotateHandle = getRotateHandle(pointsCanvas);
        if (rotateHandle) {
          const centerCanvas = toCanvas(draft.centerPx, view);
          ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(centerCanvas.x, centerCanvas.y);
          ctx.lineTo(rotateHandle.x, rotateHandle.y);
          ctx.stroke();
          drawHandle(rotateHandle.x, rotateHandle.y, ROTATE_HANDLE_RADIUS, "#0f172a");
        }
      }
    }

    if (hoverEdgeIndex !== null && pointsCanvas.length >= 2 && hoverEdgePoint) {
      const localPoints = getFootprintPoints();
      const next = (hoverEdgeIndex + 1) % localPoints.length;
      if (next >= 0) {
        const lengthM = Math.hypot(
          localPoints[next].x - localPoints[hoverEdgeIndex].x,
          localPoints[next].y - localPoints[hoverEdgeIndex].y
        );
        const lengthFt = lengthM * METERS_TO_FEET;
        drawLabel(`${formatDisplay(lengthFt, 1)} ft`, hoverEdgePoint.x, hoverEdgePoint.y - 16);
      }
    }

    updateReadouts();
    syncInputs();
    syncImportInputs();
    syncTabState();
  };

  const updateDraft = (next: StructureEditorDraftUpdate) => {
    if (!draft) {
      return;
    }
    const view = computeViewport();
    const rotation = normalizeRotation(next.rotationDeg ?? draft.rotationDeg);
    const frameWidth = view.frameWidth;
    const frameHeight = view.frameHeight;
    const nextCenter = next.centerPx ?? draft.centerPx;
    const center = {
      x: clamp(nextCenter.x, 0, frameWidth),
      y: clamp(nextCenter.y, 0, frameHeight)
    };
    let imported = draft.imported;
    if (Object.prototype.hasOwnProperty.call(next, "imported")) {
      if (!next.imported) {
        imported = undefined;
      } else if (draft.imported) {
        const hasFootprintProxy = Object.prototype.hasOwnProperty.call(
          next.imported,
          "footprintProxy"
        );
        imported = {
          ...draft.imported,
          ...next.imported,
          offset: {
            ...draft.imported.offset,
            ...(next.imported.offset ?? {})
          },
          footprintProxy: hasFootprintProxy
            ? next.imported.footprintProxy
            : draft.imported.footprintProxy
        };
      } else if (isImportedRef(next.imported)) {
        imported = normalizeImported(next.imported);
      }
    }
    draft = {
      mode: next.mode ?? draft.mode,
      centerPx: center,
      footprintPoints: next.footprintPoints ?? draft.footprintPoints,
      heightMeters: next.heightMeters ?? draft.heightMeters,
      rotationDeg: rotation,
      placeAtCenter: next.placeAtCenter ?? draft.placeAtCenter,
      facePriority: next.facePriority ?? draft.facePriority,
      imported
    };
    render();
  };

  const setActiveTab = (next: StructureMode) => {
    if (!draft || draft.mode === next) {
      return;
    }
    if (next === "imported") {
      dragState = null;
      mode = "select";
      draftPointsFrame = [];
      draftPointerFrame = null;
    }
    updateDraft({ mode: next });
  };

  const setMode = (next: StructureEditorMode) => {
    if (mode === next) {
      return;
    }
    if (draft?.mode === "imported") {
      return;
    }
    mode = next;
    hoverEdgeIndex = null;
    hoverEdgePoint = null;
    if (mode === "draw_polygon") {
      draftPointsFrame = [];
      draftPointerFrame = null;
    }
    toolButtons.forEach((button) => {
      const buttonMode = button.dataset.mode as StructureEditorMode | undefined;
      button.classList.toggle("is-active", buttonMode === mode);
    });
    render();
  };

  const setArcChoice = (arc: FacePriorityArc["arcDeg"]) => {
    arcChoice = arc;
    if (draft?.facePriority) {
      draft.facePriority = { ...draft.facePriority, arcDeg: arc };
    }
    arcButtons.forEach((button) => {
      const value = Number(button.dataset.arc);
      button.classList.toggle("is-active", value === arc);
    });
    render();
  };

  const beginDrag = (event: PointerEvent, modeToStart: DragMode, data?: { vertexIndex?: number }) => {
    if (!draft) {
      return;
    }
    const view = computeViewport();
    const pointerFrame = toFrame(getCanvasPoint(event), view);
    dragState = {
      mode: modeToStart,
      pointerId: event.pointerId,
      startPointerFrame: pointerFrame,
      startCenterFrame: { ...draft.centerPx },
      startRotationDeg: draft.rotationDeg,
      startFootprint: draft.footprintPoints.map((point) => ({ ...point })),
      vertexIndex: data?.vertexIndex
    };
    if (modeToStart === "rotate") {
      const dx = pointerFrame.x - draft.centerPx.x;
      const dy = pointerFrame.y - draft.centerPx.y;
      dragState.rotateStartAngle = Math.atan2(dy, dx);
    }
    canvas.setPointerCapture(event.pointerId);
  };

  const updateDrag = (event: PointerEvent) => {
    if (!draft || !dragState) {
      return;
    }
    const view = computeViewport();
    const pointerFrame = toFrame(getCanvasPoint(event), view);
    if (dragState.mode === "move") {
      const delta = {
        x: pointerFrame.x - dragState.startPointerFrame.x,
        y: pointerFrame.y - dragState.startPointerFrame.y
      };
      updateDraft({
        centerPx: {
          x: dragState.startCenterFrame.x + delta.x,
          y: dragState.startCenterFrame.y + delta.y
        },
        placeAtCenter: false
      });
      return;
    }
    if (dragState.mode === "rotate") {
      const dx = pointerFrame.x - dragState.startCenterFrame.x;
      const dy = pointerFrame.y - dragState.startCenterFrame.y;
      const angle = Math.atan2(dy, dx);
      const delta = angle - (dragState.rotateStartAngle ?? 0);
      let rotation = dragState.startRotationDeg + (delta * 180) / Math.PI;
      if (event.shiftKey) {
        rotation = Math.round(rotation / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
      }
      updateDraft({ rotationDeg: rotation });
      return;
    }
    if (dragState.mode === "vertex" && dragState.vertexIndex !== undefined) {
      const points = dragState.startFootprint.map((point) => ({ ...point }));
      points[dragState.vertexIndex] = frameToLocal(
        pointerFrame,
        view,
        dragState.startCenterFrame,
        dragState.startRotationDeg
      );
      if (isPolygonSimple(points) && Math.abs(polygonSignedArea(points)) > 1e-6) {
        updateDraft({ footprintPoints: points, placeAtCenter: false });
      }
    }
  };

  const endDrag = () => {
    dragState = null;
    canvas.style.cursor = "default";
  };

  const updateHoverEdge = (event: PointerEvent) => {
    if (!draft) {
      return;
    }
    const view = computeViewport();
    const pointerCanvas = getCanvasPoint(event);
    const pointsCanvas = getFootprintCanvasPoints(view);
    const hit = findClosestEdgeIndex(pointsCanvas, pointerCanvas, EDGE_HOVER_DISTANCE);
    if (!hit) {
      hoverEdgeIndex = null;
      hoverEdgePoint = null;
      return;
    }
    hoverEdgeIndex = hit.index;
    hoverEdgePoint = hit.closest;
  };

  const updateCursor = (event: PointerEvent) => {
    if (!draft || dragState) {
      return;
    }
    if (mode === "draw_polygon") {
      canvas.style.cursor = "crosshair";
      return;
    }
    const view = computeViewport();
    const pointerCanvas = getCanvasPoint(event);
    const pointsCanvas = getFootprintCanvasPoints(view);

    if ((mode === "rotate" || mode === "select") && pointsCanvas.length > 0) {
      const rotateHandle = getRotateHandle(pointsCanvas);
      if (rotateHandle) {
        const dx = pointerCanvas.x - rotateHandle.x;
        const dy = pointerCanvas.y - rotateHandle.y;
        if (dx * dx + dy * dy <= ROTATE_HANDLE_RADIUS ** 2) {
          canvas.style.cursor = "crosshair";
          return;
        }
      }
    }

    if (mode === "edit_vertices" || mode === "select") {
      for (const point of pointsCanvas) {
        const dx = pointerCanvas.x - point.x;
        const dy = pointerCanvas.y - point.y;
        if (dx * dx + dy * dy <= HANDLE_RADIUS ** 2) {
          canvas.style.cursor = "grab";
          return;
        }
      }
    }

    if (mode === "move" || mode === "select") {
      const pointerFrame = toFrame(pointerCanvas, view);
      const pointsFrame = getFootprintFramePoints(view);
      if (pointInPolygon(pointerFrame, pointsFrame)) {
        canvas.style.cursor = "move";
        return;
      }
    }

    if (mode === "face_priority") {
      canvas.style.cursor = "pointer";
      return;
    }

    canvas.style.cursor = "default";
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!draft || event.button !== 0) {
      return;
    }
    if (draft.mode === "imported") {
      return;
    }
    if (mode === "draw_polygon") {
      const view = computeViewport();
      const pointerFrame = toFrame(getCanvasPoint(event), view);
      draftPointsFrame = [...draftPointsFrame, pointerFrame];
      draftPointerFrame = pointerFrame;
      render();
      event.preventDefault();
      return;
    }

    const view = computeViewport();
    const pointerCanvas = getCanvasPoint(event);
    const pointsCanvas = getFootprintCanvasPoints(view);

    if (mode === "face_priority") {
      const hit = findClosestEdgeIndex(pointsCanvas, pointerCanvas, EDGE_HOVER_DISTANCE);
      if (hit) {
        updateDraft({
          facePriority: {
            primaryEdgeIndex: hit.index,
            arcDeg: draft.facePriority?.arcDeg ?? arcChoice
          }
        });
      }
      return;
    }

    if ((mode === "rotate" || mode === "select") && pointsCanvas.length > 0) {
      const rotateHandle = getRotateHandle(pointsCanvas);
      if (rotateHandle) {
        const dx = pointerCanvas.x - rotateHandle.x;
        const dy = pointerCanvas.y - rotateHandle.y;
        if (dx * dx + dy * dy <= ROTATE_HANDLE_RADIUS ** 2) {
          beginDrag(event, "rotate");
          canvas.style.cursor = "crosshair";
          event.preventDefault();
          return;
        }
      }
    }

    if (mode === "edit_vertices" || mode === "select") {
      for (let i = 0; i < pointsCanvas.length; i += 1) {
        const point = pointsCanvas[i];
        const dx = pointerCanvas.x - point.x;
        const dy = pointerCanvas.y - point.y;
        if (dx * dx + dy * dy <= HANDLE_RADIUS ** 2) {
          beginDrag(event, "vertex", { vertexIndex: i });
          canvas.style.cursor = "grabbing";
          event.preventDefault();
          return;
        }
      }
    }

    if (mode === "move" || mode === "select") {
      const pointerFrame = toFrame(pointerCanvas, view);
      const pointsFrame = getFootprintFramePoints(view);
      if (pointInPolygon(pointerFrame, pointsFrame)) {
        beginDrag(event, "move");
        canvas.style.cursor = "grabbing";
        event.preventDefault();
      }
    }
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!draft) {
      return;
    }
    if (draft.mode === "imported") {
      return;
    }
    if (dragState) {
      updateDrag(event);
      event.preventDefault();
      return;
    }
    if (mode === "draw_polygon") {
      const view = computeViewport();
      draftPointerFrame = toFrame(getCanvasPoint(event), view);
      render();
      return;
    }
    updateHoverEdge(event);
    render();
    updateCursor(event);
  };

  const handlePointerUp = () => {
    if (dragState) {
      endDrag();
    }
  };

  const handlePointerLeave = () => {
    if (!dragState) {
      canvas.style.cursor = "default";
      hoverEdgeIndex = null;
      hoverEdgePoint = null;
      render();
    }
  };

  const finalizeDrawing = () => {
    const currentDraft = draft;
    if (!currentDraft || draftPointsFrame.length < 3) {
      return;
    }
    const view = computeViewport();
    const rawPoints = draftPointsFrame
      .map((point) => ({ ...point }))
      .filter((point, index, arr) => {
        if (index === 0) {
          return true;
        }
        const prev = arr[index - 1];
        return Math.hypot(point.x - prev.x, point.y - prev.y) > 1e-3;
      });
    if (rawPoints.length < 3) {
      return;
    }
    const first = rawPoints[0];
    const last = rawPoints[rawPoints.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-3) {
      rawPoints.pop();
    }
    if (rawPoints.length < 3) {
      return;
    }
    if (!isPolygonSimple(rawPoints)) {
      return;
    }
    const centroid = polygonCentroid(rawPoints);
    const localPoints = rawPoints.map((point) =>
      frameToLocal(point, view, centroid, currentDraft.rotationDeg)
    );
    if (!isPolygonSimple(localPoints)) {
      return;
    }
    if (Math.abs(polygonSignedArea(localPoints)) < 1e-6) {
      return;
    }
    const signedArea = polygonSignedArea(localPoints);
    const normalized = signedArea >= 0 ? localPoints : localPoints.slice().reverse();
    updateDraft({
      centerPx: centroid,
      footprintPoints: normalized,
      placeAtCenter: false
    });
    draftPointsFrame = [];
    draftPointerFrame = null;
    setMode("select");
  };

  const handleDoubleClick = (event: MouseEvent) => {
    if (mode !== "draw_polygon" || draft?.mode === "imported") {
      return;
    }
    event.preventDefault();
    finalizeDrawing();
  };

  const normalizeState = (state: StructureEditorState, frame: StructureFrameInfo | null) => {
    const frameWidth = frame?.widthPx ?? canvasSize.width;
    const frameHeight = frame?.heightPx ?? canvasSize.height;
    const modeValue: StructureMode = state.mode === "imported" ? "imported" : "parametric";
    let center = state.centerPx;
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) {
      center = { x: frameWidth / 2, y: frameHeight / 2 };
    }
    if (state.placeAtCenter) {
      center = { x: frameWidth / 2, y: frameHeight / 2 };
    }
    const points = normalizeRing(state.footprintPoints);
    const fallback = [
      { x: -5, y: -5 },
      { x: 5, y: -5 },
      { x: 5, y: 5 },
      { x: -5, y: 5 }
    ];
    const validPoints = points.length >= 3 ? points : fallback;
    return {
      mode: modeValue,
      centerPx: { x: clamp(center.x, 0, frameWidth), y: clamp(center.y, 0, frameHeight) },
      footprintPoints: validPoints,
      heightMeters: Math.max(MIN_HEIGHT_FT * FEET_TO_METERS, state.heightMeters),
      rotationDeg: normalizeRotation(state.rotationDeg),
      placeAtCenter: state.placeAtCenter,
      facePriority: state.facePriority,
      imported: normalizeImported(state.imported)
    };
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (!isOpen) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter" && mode === "draw_polygon") {
      event.preventDefault();
      finalizeDrawing();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
      )
    ).filter((el) => !el.hasAttribute("disabled"));
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey) {
      if (document.activeElement === first || document.activeElement === modal) {
        last.focus();
        event.preventDefault();
      }
    } else if (document.activeElement === last) {
      first.focus();
      event.preventDefault();
    }
  };

  const open = (state: StructureEditorState, nextFrame: StructureFrameInfo | null) => {
    frameInfo = nextFrame;
    resizeCanvas();
    draft = normalizeState(state, nextFrame);
    pendingAssetIds.clear();
    arcChoice = draft.facePriority?.arcDeg ?? 180;
    mode = "select";
    toolButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.mode === mode);
    });
    arcButtons.forEach((button) => {
      button.classList.toggle("is-active", Number(button.dataset.arc) === arcChoice);
    });
    isOpen = true;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    lastFocus = document.activeElement as HTMLElement | null;
    render();
    updateReadouts();
    syncInputs();
    syncImportInputs();
    syncTabState();
    requestAnimationFrame(() => {
      if (draft?.mode === "imported") {
        importFileInput.focus();
      } else {
        heightInput.focus();
      }
    });
  };

  const close = () => {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    dragState = null;
    cleanupPendingAssets();
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    if (lastFocus) {
      lastFocus.focus();
    }
  };

  const destroy = () => {
    resizeObserver.disconnect();
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerup", handlePointerUp);
    canvas.removeEventListener("pointercancel", handlePointerUp);
    canvas.removeEventListener("pointerleave", handlePointerLeave);
    canvas.removeEventListener("dblclick", handleDoubleClick);
    document.removeEventListener("keydown", handleKeydown);
  };

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerUp);
  canvas.addEventListener("pointerleave", handlePointerLeave);
  canvas.addEventListener("dblclick", handleDoubleClick);

  heightInput.addEventListener("input", () => {
    const value = Number.parseFloat(heightInput.value);
    if (Number.isFinite(value)) {
      updateDraft({ heightMeters: Math.max(MIN_HEIGHT_FT, value) * FEET_TO_METERS });
    }
  });
  heightSlider.addEventListener("input", () => {
    const value = Number.parseFloat(heightSlider.value);
    if (Number.isFinite(value)) {
      updateDraft({ heightMeters: Math.max(MIN_HEIGHT_FT, value) * FEET_TO_METERS });
    }
  });
  rotationInput.addEventListener("input", () => {
    const value = Number.parseFloat(rotationInput.value);
    if (Number.isFinite(value)) {
      updateDraft({ rotationDeg: value });
    }
  });

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.structureTab;
      if (tab === "parametric" || tab === "imported") {
        setActiveTab(tab);
      }
    });
  });

  importFileInput.addEventListener("change", async () => {
    if (!importFileInput.files || importFileInput.files.length === 0) {
      return;
    }
    const file = importFileInput.files[0];
    const format = resolveFormat(file.name);
    if (!format) {
      importNameValue.textContent = "Unsupported file";
      importFormatValue.textContent = "--";
      importFileInput.value = "";
      return;
    }
    try {
      importNameValue.textContent = "Loading...";
      importFormatValue.textContent = format.toUpperCase();
      const assetId = createAssetId();
      const data = await file.arrayBuffer();
      await putAsset({
        id: assetId,
        name: file.name,
        mime: file.type || "application/octet-stream",
        data
      });
      const previous = draft?.imported?.assetId;
      if (previous && pendingAssetIds.has(previous)) {
        pendingAssetIds.delete(previous);
        void deleteAsset(previous);
      }
      pendingAssetIds.add(assetId);
      const nextImported: ImportedModelRef = {
        assetId,
        name: file.name,
        format,
        scale: draft?.imported?.scale ?? 1,
        rotationDeg: draft?.imported?.rotationDeg ?? 0,
        offset: draft?.imported?.offset ?? { x: 0, y: 0, z: 0 },
        footprintProxy: undefined
      };
      updateDraft({ mode: "imported", imported: normalizeImported(nextImported) });
    } catch {
      importNameValue.textContent = "Import failed";
      importFormatValue.textContent = "--";
    } finally {
      importFileInput.value = "";
    }
  });

  importScaleInput.addEventListener("input", () => {
    if (!draft?.imported) {
      return;
    }
    const value = Number.parseFloat(importScaleInput.value);
    if (Number.isFinite(value) && value > 0) {
      updateDraft({ imported: { scale: value } });
    }
  });

  importRotationInput.addEventListener("input", () => {
    if (!draft?.imported) {
      return;
    }
    const value = Number.parseFloat(importRotationInput.value);
    if (Number.isFinite(value)) {
      updateDraft({ imported: { rotationDeg: value } });
    }
  });

  const handleOffsetInput = () => {
    if (!draft?.imported) {
      return;
    }
    const x = Number.parseFloat(importOffsetXInput.value);
    const y = Number.parseFloat(importOffsetYInput.value);
    const z = Number.parseFloat(importOffsetZInput.value);
    updateDraft({
      imported: {
        offset: {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          z: Number.isFinite(z) ? z : 0
        }
      }
    });
  };
  importOffsetXInput.addEventListener("input", handleOffsetInput);
  importOffsetYInput.addEventListener("input", handleOffsetInput);
  importOffsetZInput.addEventListener("input", handleOffsetInput);

  importGenerateProxyButton.addEventListener("click", async () => {
    if (!draft?.imported) {
      return;
    }
    importGenerateProxyButton.disabled = true;
    importProxyStatus.textContent = "Working...";
    try {
      const asset = await getAsset(draft.imported.assetId);
      if (!asset) {
        importProxyStatus.textContent = "Missing asset";
        return;
      }
      const object = await loadModelFromBuffer(asset.data, draft.imported.format);
      if (!object) {
        importProxyStatus.textContent = "Load failed";
        return;
      }
      const proxy = buildFootprintProxy(object);
      if (!proxy) {
        importProxyStatus.textContent = "No geometry";
        return;
      }
      updateDraft({ imported: { footprintProxy: proxy } });
    } finally {
      importGenerateProxyButton.disabled = false;
    }
  });

  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.mode as StructureEditorMode | undefined;
      if (nextMode) {
        setMode(nextMode);
      }
    });
  });

  arcButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const value = Number(button.dataset.arc);
      if (value === 180 || value === 270) {
        setArcChoice(value);
      }
    });
  });

  closeButton.addEventListener("click", () => close());
  cancelButton.addEventListener("click", () => {
    onCancel?.();
    close();
  });
  applyButton.addEventListener("click", () => {
    if (!draft) {
      return;
    }
    cleanupPendingAssets(draft.imported?.assetId);
    const imported = draft.imported
      ? {
          ...draft.imported,
          offset: { ...draft.imported.offset },
          footprintProxy: draft.imported.footprintProxy
            ? {
                points: draft.imported.footprintProxy.points.map((point) => ({ ...point }))
              }
            : undefined
        }
      : undefined;
    onApply({
      mode: draft.mode,
      centerPx: { ...draft.centerPx },
      footprintPoints: draft.footprintPoints.map((point) => ({ ...point })),
      heightMeters: draft.heightMeters,
      rotationDeg: draft.rotationDeg,
      placeAtCenter: draft.placeAtCenter,
      facePriority: draft.facePriority ? { ...draft.facePriority } : undefined,
      imported
    });
    close();
  });
  document.addEventListener("keydown", handleKeydown);

  return {
    open,
    close,
    destroy,
    isOpen: () => isOpen
  };
}
