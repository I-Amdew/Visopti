const FEET_TO_METERS = 0.3048;
const MIN_SIZE_FT = 1;
const ROTATE_SNAP_DEG = 15;
const HANDLE_RADIUS = 7;
const CENTER_RADIUS = 6;
const ROTATE_HANDLE_RADIUS = 7;
const ROTATE_HANDLE_OFFSET = 28;

type CornerKey = "nw" | "ne" | "se" | "sw";

export interface StructureEditorState {
  centerPx: { x: number; y: number };
  widthFt: number;
  lengthFt: number;
  rotationDeg: number;
  placeAtCenter: boolean;
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
  widthInput: HTMLInputElement;
  lengthInput: HTMLInputElement;
  rotationInput: HTMLInputElement;
  widthValue: HTMLElement;
  lengthValue: HTMLElement;
  areaValue: HTMLElement;
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

interface Geometry {
  centerCanvas: { x: number; y: number };
  axisX: { x: number; y: number };
  axisY: { x: number; y: number };
  halfWidth: number;
  halfLength: number;
  corners: Record<CornerKey, { x: number; y: number }>;
  rotateHandle: { x: number; y: number };
  widthCanvas: number;
  lengthCanvas: number;
}

type DragMode = "move" | "resize" | "rotate";

interface DragState {
  mode: DragMode;
  pointerId: number;
  startPointerFrame: { x: number; y: number };
  startCenterFrame: { x: number; y: number };
  startWidthPx: number;
  startLengthPx: number;
  startRotationDeg: number;
  resizeCorner?: CornerKey;
  oppositeCornerFrame?: { x: number; y: number };
  rotateStartAngle?: number;
}

const CORNER_SIGNS: Record<CornerKey, { x: number; y: number }> = {
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 }
};

export function createStructureEditor(options: StructureEditorOptions) {
  const {
    modal,
    canvas,
    widthInput,
    lengthInput,
    rotationInput,
    widthValue,
    lengthValue,
    areaValue,
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
  let draft: StructureEditorState | null = null;
  let frameInfo: StructureFrameInfo | null = null;
  let dragState: DragState | null = null;
  let lastFocus: HTMLElement | null = null;
  let canvasSize = { width: 0, height: 0 };

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

  const getGeometry = (view: Viewport): Geometry | null => {
    if (!draft) {
      return null;
    }
    const widthPx = draft.widthFt * FEET_TO_METERS * view.pixelsPerMeterX;
    const lengthPx = draft.lengthFt * FEET_TO_METERS * view.pixelsPerMeterY;
    const widthCanvas = widthPx * view.scale;
    const lengthCanvas = lengthPx * view.scale;
    const centerCanvas = toCanvas(draft.centerPx, view);
    const angle = (normalizeRotation(draft.rotationDeg) * Math.PI) / 180;
    const axisX = { x: Math.cos(angle), y: Math.sin(angle) };
    const axisY = { x: -Math.sin(angle), y: Math.cos(angle) };
    const halfWidth = widthCanvas / 2;
    const halfLength = lengthCanvas / 2;

    const localToCanvas = (localX: number, localY: number) => ({
      x: centerCanvas.x + axisX.x * localX + axisY.x * localY,
      y: centerCanvas.y + axisX.y * localX + axisY.y * localY
    });

    return {
      centerCanvas,
      axisX,
      axisY,
      halfWidth,
      halfLength,
      widthCanvas,
      lengthCanvas,
      corners: {
        nw: localToCanvas(-halfWidth, -halfLength),
        ne: localToCanvas(halfWidth, -halfLength),
        se: localToCanvas(halfWidth, halfLength),
        sw: localToCanvas(-halfWidth, halfLength)
      },
      rotateHandle: localToCanvas(0, -halfLength - ROTATE_HANDLE_OFFSET)
    };
  };

  const updateReadouts = () => {
    if (!draft) {
      return;
    }
    const widthFt = draft.widthFt;
    const lengthFt = draft.lengthFt;
    const widthM = widthFt * FEET_TO_METERS;
    const lengthM = lengthFt * FEET_TO_METERS;
    widthValue.textContent = `${formatDisplay(widthFt)} ft (${formatDisplay(widthM)} m)`;
    lengthValue.textContent = `${formatDisplay(lengthFt)} ft (${formatDisplay(lengthM)} m)`;
    areaValue.textContent = `${formatDisplay(widthFt * lengthFt, 0)} sq ft`;
  };

  const syncInputs = () => {
    if (!draft) {
      return;
    }
    if (document.activeElement !== widthInput) {
      widthInput.value = formatInput(draft.widthFt);
    }
    if (document.activeElement !== lengthInput) {
      lengthInput.value = formatInput(draft.lengthFt);
    }
    if (document.activeElement !== rotationInput) {
      rotationInput.value = formatInput(normalizeRotation(draft.rotationDeg), 0);
    }
  };

  const drawLabel = (text: string, x: number, y: number) => {
    ctx.save();
    ctx.font = "12px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const metrics = ctx.measureText(text);
    const paddingX = 6;
    const paddingY = 4;
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

    const geometry = getGeometry(view);
    if (!geometry) {
      return;
    }

    ctx.save();
    ctx.translate(geometry.centerCanvas.x, geometry.centerCanvas.y);
    ctx.rotate((normalizeRotation(draft.rotationDeg) * Math.PI) / 180);
    ctx.fillStyle = "rgba(92, 194, 242, 0.18)";
    ctx.strokeStyle = "rgba(125, 211, 252, 0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(
      -geometry.widthCanvas / 2,
      -geometry.lengthCanvas / 2,
      geometry.widthCanvas,
      geometry.lengthCanvas
    );
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = "rgba(148, 163, 184, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -geometry.lengthCanvas / 2);
    ctx.lineTo(0, geometry.lengthCanvas / 2);
    ctx.moveTo(-geometry.widthCanvas / 2, 0);
    ctx.lineTo(geometry.widthCanvas / 2, 0);
    ctx.stroke();

    const drawHandle = (x: number, y: number, radius: number, fill: string) => {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = "rgba(226, 232, 240, 0.95)";
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    drawHandle(0, 0, CENTER_RADIUS, "rgba(15, 23, 42, 0.9)");

    drawHandle(-geometry.widthCanvas / 2, -geometry.lengthCanvas / 2, HANDLE_RADIUS, "#1f2937");
    drawHandle(geometry.widthCanvas / 2, -geometry.lengthCanvas / 2, HANDLE_RADIUS, "#1f2937");
    drawHandle(geometry.widthCanvas / 2, geometry.lengthCanvas / 2, HANDLE_RADIUS, "#1f2937");
    drawHandle(-geometry.widthCanvas / 2, geometry.lengthCanvas / 2, HANDLE_RADIUS, "#1f2937");

    ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -geometry.lengthCanvas / 2);
    ctx.lineTo(0, -geometry.lengthCanvas / 2 - ROTATE_HANDLE_OFFSET);
    ctx.stroke();
    drawHandle(0, -geometry.lengthCanvas / 2 - ROTATE_HANDLE_OFFSET, ROTATE_HANDLE_RADIUS, "#0f172a");

    ctx.restore();

    const labelOffset = 18;
    const widthLabelPos = {
      x: geometry.centerCanvas.x + geometry.axisY.x * (-geometry.halfLength - labelOffset),
      y: geometry.centerCanvas.y + geometry.axisY.y * (-geometry.halfLength - labelOffset)
    };
    const lengthLabelPos = {
      x: geometry.centerCanvas.x + geometry.axisX.x * (geometry.halfWidth + labelOffset),
      y: geometry.centerCanvas.y + geometry.axisX.y * (geometry.halfWidth + labelOffset)
    };
    drawLabel(`${formatDisplay(draft.widthFt)} ft`, widthLabelPos.x, widthLabelPos.y);
    drawLabel(`${formatDisplay(draft.lengthFt)} ft`, lengthLabelPos.x, lengthLabelPos.y);

    updateReadouts();
    syncInputs();
  };

  const distanceSq = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };

  const hitTest = (pointCanvas: { x: number; y: number }, view: Viewport) => {
    const geometry = getGeometry(view);
    if (!geometry) {
      return null;
    }
    if (distanceSq(pointCanvas, geometry.rotateHandle) <= ROTATE_HANDLE_RADIUS ** 2) {
      return { type: "rotate" as const };
    }
    const cornerKeys = Object.keys(geometry.corners) as CornerKey[];
    for (const key of cornerKeys) {
      if (distanceSq(pointCanvas, geometry.corners[key]) <= HANDLE_RADIUS ** 2) {
        return { type: "resize" as const, corner: key };
      }
    }
    if (distanceSq(pointCanvas, geometry.centerCanvas) <= CENTER_RADIUS ** 2) {
      return { type: "move" as const, centerHandle: true };
    }

    const dx = pointCanvas.x - geometry.centerCanvas.x;
    const dy = pointCanvas.y - geometry.centerCanvas.y;
    const localX = dx * geometry.axisX.x + dy * geometry.axisX.y;
    const localY = dx * geometry.axisY.x + dy * geometry.axisY.y;
    if (Math.abs(localX) <= geometry.halfWidth && Math.abs(localY) <= geometry.halfLength) {
      return { type: "move" as const, centerHandle: false };
    }
    return null;
  };

  const getCanvasPoint = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const updateDraft = (next: Partial<StructureEditorState>) => {
    if (!draft) {
      return;
    }
    const view = computeViewport();
    const nextWidth = Math.max(MIN_SIZE_FT, next.widthFt ?? draft.widthFt);
    const nextLength = Math.max(MIN_SIZE_FT, next.lengthFt ?? draft.lengthFt);
    const rotation = normalizeRotation(next.rotationDeg ?? draft.rotationDeg);
    const frameWidth = view.frameWidth;
    const frameHeight = view.frameHeight;
    const nextCenter = next.centerPx ?? draft.centerPx;
    const center = {
      x: clamp(nextCenter.x, 0, frameWidth),
      y: clamp(nextCenter.y, 0, frameHeight)
    };
    draft = {
      centerPx: center,
      widthFt: nextWidth,
      lengthFt: nextLength,
      rotationDeg: rotation,
      placeAtCenter: next.placeAtCenter ?? draft.placeAtCenter
    };
    render();
  };

  const beginDrag = (event: PointerEvent, hit: ReturnType<typeof hitTest>, view: Viewport) => {
    if (!draft || !hit) {
      return;
    }
    const pointerFrame = toFrame(getCanvasPoint(event), view);
    const widthPx = draft.widthFt * FEET_TO_METERS * view.pixelsPerMeterX;
    const lengthPx = draft.lengthFt * FEET_TO_METERS * view.pixelsPerMeterY;
    const angle = (normalizeRotation(draft.rotationDeg) * Math.PI) / 180;
    const axisX = { x: Math.cos(angle), y: Math.sin(angle) };
    const axisY = { x: -Math.sin(angle), y: Math.cos(angle) };
    const halfWidth = widthPx / 2;
    const halfLength = lengthPx / 2;

    dragState = {
      mode: hit.type,
      pointerId: event.pointerId,
      startPointerFrame: pointerFrame,
      startCenterFrame: { ...draft.centerPx },
      startWidthPx: widthPx,
      startLengthPx: lengthPx,
      startRotationDeg: draft.rotationDeg
    };

    if (hit.type === "resize") {
      const corner = hit.corner;
      const sign = CORNER_SIGNS[corner];
      const oppositeLocal = { x: -sign.x * halfWidth, y: -sign.y * halfLength };
      const oppositeFrame = {
        x: draft.centerPx.x + axisX.x * oppositeLocal.x + axisY.x * oppositeLocal.y,
        y: draft.centerPx.y + axisX.y * oppositeLocal.x + axisY.y * oppositeLocal.y
      };
      dragState.resizeCorner = corner;
      dragState.oppositeCornerFrame = oppositeFrame;
    } else if (hit.type === "rotate") {
      const dx = pointerFrame.x - draft.centerPx.x;
      const dy = pointerFrame.y - draft.centerPx.y;
      dragState.rotateStartAngle = Math.atan2(dy, dx);
    }
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
    if (dragState.mode === "resize" && dragState.oppositeCornerFrame) {
      const center = {
        x: (pointerFrame.x + dragState.oppositeCornerFrame.x) / 2,
        y: (pointerFrame.y + dragState.oppositeCornerFrame.y) / 2
      };
      const angle = (normalizeRotation(draft.rotationDeg) * Math.PI) / 180;
      const axisX = { x: Math.cos(angle), y: Math.sin(angle) };
      const axisY = { x: -Math.sin(angle), y: Math.cos(angle) };
      const dx = pointerFrame.x - center.x;
      const dy = pointerFrame.y - center.y;
      const localX = dx * axisX.x + dy * axisX.y;
      const localY = dx * axisY.x + dy * axisY.y;
      const minWidthPx = MIN_SIZE_FT * FEET_TO_METERS * view.pixelsPerMeterX;
      const minLengthPx = MIN_SIZE_FT * FEET_TO_METERS * view.pixelsPerMeterY;
      const widthPx = Math.max(minWidthPx, Math.abs(localX) * 2);
      const lengthPx = Math.max(minLengthPx, Math.abs(localY) * 2);
      const widthFt = widthPx / (view.pixelsPerMeterX * FEET_TO_METERS);
      const lengthFt = lengthPx / (view.pixelsPerMeterY * FEET_TO_METERS);
      updateDraft({ centerPx: center, widthFt, lengthFt });
    }
  };

  const endDrag = () => {
    dragState = null;
    canvas.style.cursor = "default";
  };

  const updateCursor = (event: PointerEvent) => {
    if (!draft || dragState) {
      return;
    }
    const view = computeViewport();
    const hit = hitTest(getCanvasPoint(event), view);
    if (!hit) {
      canvas.style.cursor = "default";
      return;
    }
    if (hit.type === "rotate") {
      canvas.style.cursor = "crosshair";
      return;
    }
    if (hit.type === "resize") {
      const corner = hit.corner;
      canvas.style.cursor = corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
      return;
    }
    if (hit.type === "move") {
      canvas.style.cursor = "move";
    }
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!draft || event.button !== 0) {
      return;
    }
    const view = computeViewport();
    const hit = hitTest(getCanvasPoint(event), view);
    if (!hit) {
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    beginDrag(event, hit, view);
    canvas.style.cursor = hit.type === "move" ? "grabbing" : canvas.style.cursor;
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!draft) {
      return;
    }
    if (dragState) {
      updateDrag(event);
      event.preventDefault();
      return;
    }
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
    }
  };

  const normalizeState = (state: StructureEditorState, frame: StructureFrameInfo | null) => {
    const widthFt = Math.max(MIN_SIZE_FT, state.widthFt);
    const lengthFt = Math.max(MIN_SIZE_FT, state.lengthFt);
    const rotationDeg = normalizeRotation(state.rotationDeg);
    const frameWidth = frame?.widthPx ?? canvasSize.width;
    const frameHeight = frame?.heightPx ?? canvasSize.height;
    let center = state.centerPx;
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) {
      center = { x: frameWidth / 2, y: frameHeight / 2 };
    }
    if (state.placeAtCenter) {
      center = { x: frameWidth / 2, y: frameHeight / 2 };
    }
    return {
      centerPx: { x: clamp(center.x, 0, frameWidth), y: clamp(center.y, 0, frameHeight) },
      widthFt,
      lengthFt,
      rotationDeg,
      placeAtCenter: state.placeAtCenter
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
    isOpen = true;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    lastFocus = document.activeElement as HTMLElement | null;
    render();
    updateReadouts();
    syncInputs();
    requestAnimationFrame(() => {
      widthInput.focus();
    });
  };

  const close = () => {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    dragState = null;
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
    document.removeEventListener("keydown", handleKeydown);
  };

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerUp);
  canvas.addEventListener("pointerleave", handlePointerLeave);

  widthInput.addEventListener("input", () => {
    const value = Number.parseFloat(widthInput.value);
    if (Number.isFinite(value)) {
      updateDraft({ widthFt: value });
    }
  });
  lengthInput.addEventListener("input", () => {
    const value = Number.parseFloat(lengthInput.value);
    if (Number.isFinite(value)) {
      updateDraft({ lengthFt: value });
    }
  });
  rotationInput.addEventListener("input", () => {
    const value = Number.parseFloat(rotationInput.value);
    if (Number.isFinite(value)) {
      updateDraft({ rotationDeg: value });
    }
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
    onApply({
      centerPx: { ...draft.centerPx },
      widthFt: draft.widthFt,
      lengthFt: draft.lengthFt,
      rotationDeg: draft.rotationDeg,
      placeAtCenter: draft.placeAtCenter
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
