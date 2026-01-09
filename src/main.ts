import { createDrawingManager, ToolMode } from "./drawing";
import { AppSettings, GeoBounds, Shape } from "./types";
import { createGeoReference, GeoMapper } from "./geo";
import {
  computeVisibilityHeatmap,
  computeShadingOverlay,
  sampleCandidatePoints,
  sampleMapGridPoints,
  sampleViewerPoints
} from "./visibility";
import { generateContourSegments } from "./contours";
import { getTileSource, TileSourceId, renderMapFrameImage } from "./mapTiles";
import { createMapView } from "./mapView";
import { fetchElevationGrid } from "./topography";

type MapViewInstance = ReturnType<typeof createMapView>;
type AutosavePayload = {
  bounds: GeoBounds | null;
  basemapId: TileSourceId;
  settings: AppSettings;
  shapes: Shape[];
};

const AUTOSAVE_KEY = "visopti-autosave-v1";

async function init() {
  const canvas = document.getElementById("mainCanvas") as HTMLCanvasElement | null;
  const statusOverlay = document.getElementById("statusOverlay");
  const statusMessage = document.getElementById("statusMessage");
  const warningBanner = document.getElementById("warningBanner");
  const mapContainer = document.getElementById("mapView") as HTMLDivElement | null;
  const mapStatus = document.getElementById("mapStatus");
  const btnLockFrame = document.getElementById("btnLockFrame") as HTMLButtonElement | null;
  const btnLoadTopography = document.getElementById("btnLoadTopography") as HTMLButtonElement | null;
  const basemapStyle = document.getElementById("basemapStyle") as HTMLSelectElement | null;
  if (!canvas || !statusOverlay || !statusMessage) {
    throw new Error("Missing core DOM elements");
  }
  if (!mapContainer || !mapStatus || !btnLockFrame || !btnLoadTopography || !basemapStyle) {
    throw new Error("Map controls missing from DOM");
  }

  const statusOverlayEl = statusOverlay;
  const statusMessageEl = statusMessage;
  const warningBannerEl = warningBanner;
  const mapStatusEl = mapStatus;
  const basemapStyleEl = basemapStyle;

  statusOverlayEl.textContent = "Zoom the map to pick your frame.";
  const mapView = createMapView(mapContainer);
  basemapStyleEl.value = mapView.getTileSourceId();
  basemapStyleEl.addEventListener("change", () => {
    mapView.setTileSourceId(basemapStyleEl.value as TileSourceId);
    scheduleAutosave();
  });

  const placeholderImage = createPlaceholderCanvas(1200, 800);

  const settings = createDefaultSettings();
  let lastPointer: { x: number; y: number } | null = null;
  let pendingInterrupt: () => void = () => {};
  let mapper: GeoMapper | null = null;
  let currentBounds: GeoBounds | null = null;
  let frameLocked = false;
  let autosave: AutosavePayload | null = loadAutosave();
  let autosaveTimer: number | null = null;
  const drawingManager = createDrawingManager({
    canvas,
    image: placeholderImage,
    onShapesChanged: (shapes) => shapeChangeHandler(shapes),
    onPointerMove: (pixel) => updateStatusOverlay(pixel),
    onInteraction: () => pendingInterrupt()
  });


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

  setupTools(drawingManager, () => updateStatusOverlay(null));
  setupSettings(settings, drawingManager, {
    interruptComputations: () => pendingInterrupt(),
    onSettingsChanged: () => scheduleAutosave()
  });
  if (autosave) {
    applySettingsFromImport(autosave.settings, settings);
    refreshSettingInputs(settings);
    applyDisplaySettingsToCanvas(drawingManager, settings);
    mapView.setTileSourceId(autosave.basemapId);
    basemapStyleEl.value = autosave.basemapId;
    if (autosave.bounds) {
      mapView.setBounds(autosave.bounds);
    }
  }
  const actionControls = setupActions(drawingManager, settings, () => mapper, statusMessageEl, {
    onShadingComplete: () => {}
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
    const tileSource = getTileSource(mapView.getTileSourceId());
    try {
      const [mapImage, elevationGrid] = await Promise.all([
        renderMapFrameImage(frame, tileSource),
        fetchElevationGrid(bounds, gridRows, gridCols),
      ]);
      const geo = createGeoReference(bounds, { width: frame.width, height: frame.height });
      mapper = new GeoMapper(geo, elevationGrid);
      const frameChanged = !currentBounds || !boundsApproxEqual(currentBounds, bounds);
      currentBounds = bounds;
      drawingManager.setBaseImage(mapImage, { resetView: true });
      if (frameChanged) {
        drawingManager.clearShapes();
        drawingManager.clearHeatmap();
        drawingManager.setShading(null, Math.max(2, Math.floor(settings.sampleStepPx)));
      }
      drawingManager.setContours(generateContourSegments(mapper, 1));
      actionControls.setTopographyReady(true);
      statusMessageEl.textContent = "Topography loaded.";
      if (
        autosave &&
        autosave.bounds &&
        boundsApproxEqual(autosave.bounds, bounds) &&
        drawingManager.getShapes().length === 0
      ) {
        drawingManager.setShapes(autosave.shapes);
        statusMessageEl.textContent = "Topography loaded (autosave restored).";
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
    }
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
      autosave = {
        bounds: currentBounds,
        basemapId: mapView.getTileSourceId(),
        settings: { ...settings },
        shapes: drawingManager.getShapes()
      };
      saveAutosave(autosave);
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
  hooks?: { onShadingComplete?: () => void }
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
    const data = {
      shapes: drawingManager.getShapes(),
      settings: { ...settings }
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
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
      scheduleAutosave();
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
        scheduleAutosave();
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

function loadAutosave(): AutosavePayload | null {
  const raw = window.localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as AutosavePayload;
    if (!parsed || !parsed.settings || !parsed.shapes) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveAutosave(payload: AutosavePayload): void {
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
