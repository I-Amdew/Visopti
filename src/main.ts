import { createDrawingManager, ToolMode } from "./drawing";
import { AppSettings, Shape } from "./types";
import { GeoMapper, loadElevationGrid, loadGeoReference } from "./geo";
import {
  computeVisibilityHeatmap,
  computeShadingOverlay,
  sampleCandidatePoints,
  sampleMapGridPoints,
  sampleViewerPoints
} from "./visibility";
import { generateContourSegments } from "./contours";
import { loadGoogleApiScript } from "./googleScripts";

async function init() {
  const canvas = document.getElementById("mainCanvas") as HTMLCanvasElement | null;
  const statusOverlay = document.getElementById("statusOverlay");
  const statusMessage = document.getElementById("statusMessage");
  const warningBanner = document.getElementById("warningBanner");
  if (!canvas || !statusOverlay || !statusMessage) {
    throw new Error("Missing core DOM elements");
  }

  const statusOverlayEl = statusOverlay;
  const statusMessageEl = statusMessage;

  statusOverlayEl.textContent = "Loading assets…";

  const googleScriptsLoad = loadGoogleApiScript();

  const geo = await loadGeoReference();
  const grid = await loadElevationGrid(geo);
  const mapper = new GeoMapper(geo, grid);
  const baseImage = await loadImage(`Assets/${mapper.geo.image.filename}`);
  const contourSegments = generateContourSegments(mapper, 1);

  canvas.width = mapper.geo.image.width_px;
  canvas.height = mapper.geo.image.height_px;

  const settings = createDefaultSettings();
  let lastPointer: { x: number; y: number } | null = null;
  let pendingInterrupt: () => void = () => {};
  const drawingManager = createDrawingManager({
    canvas,
    image: baseImage,
    onShapesChanged: (shapes) => shapeChangeHandler(shapes),
    onPointerMove: (pixel) => updateStatusOverlay(pixel),
    onInteraction: () => pendingInterrupt()
  });


  function updateStatusOverlay(pixel: { x: number; y: number } | null) {
    const toolName = friendlyToolName(drawingManager.getTool());
    let text = `Tool: ${toolName}`;
    if (pixel) {
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
    pendingInterrupt();
  }

  setupTools(drawingManager, () => updateStatusOverlay(null));
  setupSettings(settings, drawingManager, {
    interruptComputations: () => pendingInterrupt()
  });
  const actionControls = setupActions(drawingManager, settings, mapper, statusMessageEl, {
    onShadingComplete: () => {}
  });
  setupDebugProbe(canvas, mapper, () => lastPointer);
  pendingInterrupt = () => {
    actionControls.cancelHeatmap();
  };
  drawingManager.setContours(contourSegments);
  drawingManager.setContourOpacity(settings.opacity.contours);
  drawingManager.setShowContours(settings.overlays.showContours);

  updateStatusOverlay(null);

  googleScriptsLoad.then((result) => {
    if (!result.ok && warningBanner) {
      warningBanner.textContent =
        "Google scripts failed to load; browser or network privacy settings may be blocking them. Google-powered features will be disabled.";
      warningBanner.classList.remove("hidden");
    }
  });
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
  hooks?: { interruptComputations?: () => void }
) {
  const truckHeight = document.getElementById("truckHeight") as HTMLInputElement | null;
  const truckLength = document.getElementById("truckLength") as HTMLInputElement | null;
  const truckWidth = document.getElementById("truckWidth") as HTMLInputElement | null;
  const viewerHeight = document.getElementById("viewerHeight") as HTMLInputElement | null;
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
    !truckHeight ||
    !truckLength ||
    !truckWidth ||
    !viewerHeight ||
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
    settings.truckHeightFt = ensureNumber(truckHeight, settings.truckHeightFt);
    settings.truckLengthFt = ensureNumber(truckLength, settings.truckLengthFt);
    settings.truckWidthFt = ensureNumber(truckWidth, settings.truckWidthFt);
    settings.viewerHeightFt = ensureNumber(viewerHeight, settings.viewerHeightFt);
    settings.sampleStepPx = Math.max(1, ensureNumber(sampleStep, settings.sampleStepPx));
    hooks?.interruptComputations?.();
  };

  [truckHeight, truckLength, truckWidth, viewerHeight, sampleStep].forEach((input) => {
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
  mapper: GeoMapper,
  statusMessage: HTMLElement,
  hooks?: { onShadingComplete?: () => void }
): { cancelHeatmap: () => void } {
  let heatmapComputeToken = 0;
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
    btnCompute.disabled = false;
  };

  btnCompute.addEventListener("click", async () => {
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
          btnCompute.disabled = false;
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
          btnCompute.disabled = false;
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
          btnCompute.disabled = false;
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
      btnCompute.disabled = false;
    }
  });

  btnComputeShade.addEventListener("click", async () => {
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
          btnComputeShade.disabled = false;
          return;
        }
        const step = shadingSteps[i];
        const tempSettings = withSampleResolution(settings, step);
        const viewers = sampleViewerPoints(shapes, tempSettings, mapper);
        if (viewers.length === 0) {
          drawingManager.setShading(null, step);
          statusMessage.textContent = "Need at least one viewer zone to compute blindspots.";
          hideProgress();
          btnComputeShade.disabled = false;
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
          btnComputeShade.disabled = false;
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
      btnComputeShade.disabled = false;
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
    const data = {
      shapes: drawingManager.getShapes(),
      settings: { ...settings }
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "food-truck-visibility.json";
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
      if (Array.isArray(parsed.shapes)) {
        drawingManager.setShapes(parsed.shapes as Shape[]);
        drawingManager.clearHeatmap();
      }
      if (parsed.settings) {
        applySettingsFromImport(parsed.settings as Partial<AppSettings>, settings);
        refreshSettingInputs(settings);
        applyDisplaySettingsToCanvas(drawingManager, settings);
      }
      statusMessage.textContent = "Project imported.";
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
    a.download = "food-truck-shapes.json";
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
      } else {
        statusMessage.textContent = "Invalid shapes JSON.";
      }
    } catch (err) {
      statusMessage.textContent = `Shapes import failed: ${(err as Error).message}`;
    } finally {
      importShapesInput.value = "";
    }
  });

  return { cancelHeatmap };
}

function setupDebugProbe(
  canvas: HTMLCanvasElement,
  mapper: GeoMapper,
  getPointer: () => { x: number; y: number } | null
) {
  const METERS_TO_FEET = 3.280839895013123;
  canvas.addEventListener("click", () => {
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
  if (typeof source.truckHeightFt === "number") target.truckHeightFt = source.truckHeightFt;
  if (typeof source.truckLengthFt === "number") target.truckLengthFt = source.truckLengthFt;
  if (typeof source.truckWidthFt === "number") target.truckWidthFt = source.truckWidthFt;
  if (typeof source.viewerHeightFt === "number") target.viewerHeightFt = source.viewerHeightFt;
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
    truckHeight: settings.truckHeightFt.toString(),
    truckLength: settings.truckLengthFt.toString(),
    truckWidth: settings.truckWidthFt.toString(),
    viewerHeight: settings.viewerHeightFt.toString(),
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

function createDefaultSettings(): AppSettings {
  return {
    truckHeightFt: 6,
    truckLengthFt: 20,
    truckWidthFt: 8,
    viewerHeightFt: 6,
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function delayFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
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
