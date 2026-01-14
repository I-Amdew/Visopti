import { ElevationGrid } from "./geo";
import { GeoBounds } from "./types";
import { openMeteoRateLimiter } from "./net/openMeteoLimiter";
import { buildElevationCacheKey, topographyCache } from "./topographyCache";
import { buildProgressiveIndexPhases, type SamplingPhase } from "./topographySampling";

const ELEVATION_API = "https://api.open-meteo.com/v1/elevation";
const MAX_BATCH_POINTS = 100;
const MAX_TOTAL_POINTS = 2500;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const RETRYABLE_STATUS = new Set([0, 500, 502, 503, 504]);

const BATCH_QPS_DEFAULT = 2;
const BATCH_QPS_MIN = 0.5;
const BATCH_QPS_MAX = 3;
const STABLE_BATCHES_FOR_INCREASE = 6;
const EXTRA_DELAY_MAX_MS = 1500;
const COARSE_STRIDE_DEFAULT = 4;

const DEBUG_ELEVATION = (() => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem("visopti-debug-elevation") === "1";
    }
  } catch {
    return false;
  }
  return false;
})();

const debugLog = (...args: unknown[]) => {
  if (DEBUG_ELEVATION) {
    console.debug("[elevation]", ...args);
  }
};

export interface ElevationProvider {
  id: string;
  maxBatchPoints: number;
  fetch(points: Array<{ lat: number; lon: number }>, signal?: AbortSignal): Promise<number[]>;
}

class ElevationRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class OpenMeteoProvider implements ElevationProvider {
  readonly id = "open-meteo";
  readonly maxBatchPoints = MAX_BATCH_POINTS;
  private apiBase: string;

  constructor(apiBase = ELEVATION_API) {
    this.apiBase = apiBase;
  }

  async fetch(
    points: Array<{ lat: number; lon: number }>,
    signal?: AbortSignal
  ): Promise<number[]> {
    if (points.length > this.maxBatchPoints) {
      throw new Error(`Elevation batch exceeds ${this.maxBatchPoints} points.`);
    }
    const url = buildElevationUrl(this.apiBase, points);
    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ElevationRequestError(
        "Elevation API unavailable. Check your network and try again.",
        0,
        null
      );
    }
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      throw new ElevationRequestError(
        buildElevationErrorMessage(response.status),
        response.status,
        retryAfterMs
      );
    }
    const payload = (await response.json()) as { elevation?: number[] };
    if (!Array.isArray(payload.elevation)) {
      throw new ElevationRequestError("Elevation API response missing elevation array", 0, null);
    }
    return payload.elevation;
  }
}

export interface ElevationProgress {
  completedPoints: number;
  totalPoints: number;
  phase: SamplingPhase;
  rateLimitedCount: number;
  currentQps: number;
  coverage: number;
  grid: ElevationGrid;
}

export interface FetchElevationOptions {
  rows?: number;
  cols?: number;
  spacingMeters?: number;
  spacingFt?: number;
  onProgress?: (progress: ElevationProgress) => void;
  signal?: AbortSignal;
  provider?: ElevationProvider;
  stride?: number;
}

const elevationRateLimiter = openMeteoRateLimiter;

export async function fetchElevationGrid(
  bounds: GeoBounds,
  options: FetchElevationOptions
): Promise<ElevationGrid> {
  const provider = options.provider ?? new OpenMeteoProvider();
  const stride = options.stride ?? COARSE_STRIDE_DEFAULT;
  const { rows, cols } = resolveGridSize(bounds, options);
  const { safeRows, safeCols } = clampGridSize(rows, cols);
  const latitudes = linspace(bounds.south, bounds.north, safeRows);
  const longitudes = linspace(bounds.west, bounds.east, safeCols);
  const values: number[][] = Array.from({ length: safeRows }, () =>
    new Array<number>(safeCols).fill(Number.NaN)
  );

  const grid: ElevationGrid = {
    rows: safeRows,
    cols: safeCols,
    latitudes,
    longitudes,
    values,
    latAscending: true,
    lonAscending: true,
    minElevation: 0,
    maxElevation: 0
  };

  const points: { row: number; col: number; lat: number; lon: number }[] = [];
  for (let r = 0; r < safeRows; r += 1) {
    for (let c = 0; c < safeCols; c += 1) {
      points.push({ row: r, col: c, lat: latitudes[r], lon: longitudes[c] });
    }
  }

  const totalPoints = points.length;
  let completedPoints = 0;
  let rateLimitedCount = 0;
  let currentQps = Math.min(BATCH_QPS_DEFAULT, elevationRateLimiter.getQps());
  let batchSize = Math.min(provider.maxBatchPoints, MAX_BATCH_POINTS);
  let extraDelayMs = 0;
  let stableBatches = 0;
  elevationRateLimiter.setQps(currentQps);

  const phases = buildProgressiveIndexPhases(safeRows, safeCols, stride);
  const reportProgress = (phase: SamplingPhase) => {
    options.onProgress?.({
      completedPoints,
      totalPoints,
      phase,
      rateLimitedCount,
      currentQps,
      coverage: totalPoints === 0 ? 0 : completedPoints / totalPoints,
      grid
    });
  };

  reportProgress(phases[0]?.phase ?? "full");

  const setValue = (point: { row: number; col: number }, elevation: number): boolean => {
    if (!Number.isFinite(elevation)) {
      return false;
    }
    if (Number.isFinite(values[point.row][point.col])) {
      return false;
    }
    values[point.row][point.col] = elevation;
    completedPoints += 1;
    return true;
  };

  const applyBatchElevations = (
    batch: Array<{ point: { row: number; col: number; lat: number; lon: number }; key: string }>,
    elevations: number[]
  ) => {
    const cacheEntries: Array<{ key: string; value: number }> = [];
    batch.forEach((item, index) => {
      const elevation = elevations[index];
      if (setValue(item.point, elevation)) {
        cacheEntries.push({ key: item.key, value: elevation });
      }
    });
    if (cacheEntries.length) {
      topographyCache.setMany(cacheEntries);
    }
  };

  const batchSizeSteps = [25, 50, 100].filter((step) => step <= provider.maxBatchPoints);
  const reduceBatchSize = (current: number) => {
    for (let i = batchSizeSteps.length - 1; i >= 0; i -= 1) {
      const step = batchSizeSteps[i];
      if (current > step) {
        return step;
      }
    }
    return Math.max(25, Math.floor(current / 2));
  };
  const increaseBatchSize = (current: number) => {
    for (const step of batchSizeSteps) {
      if (current < step) {
        return step;
      }
    }
    return current;
  };

  const fetchBatch = async (
    batch: Array<{ point: { row: number; col: number; lat: number; lon: number }; key: string }>
  ) => {
    let attempt = 0;
    while (true) {
      if (options.signal?.aborted) {
        throw createAbortError();
      }
      try {
        const elevations = await elevationRateLimiter.schedule(() =>
          provider.fetch(
            batch.map((item) => item.point),
            options.signal
          )
        );
        stableBatches += 1;
        if (stableBatches >= STABLE_BATCHES_FOR_INCREASE) {
          stableBatches = 0;
          const nextQps = Math.min(BATCH_QPS_MAX, currentQps + 0.2);
          if (nextQps > currentQps) {
            currentQps = nextQps;
            elevationRateLimiter.setQps(currentQps);
          }
          const nextBatch = increaseBatchSize(batchSize);
          if (nextBatch !== batchSize) {
            batchSize = nextBatch;
          }
          if (extraDelayMs > 0) {
            extraDelayMs = Math.max(0, extraDelayMs * 0.85 - 50);
          }
        }
        if (extraDelayMs > 0) {
          await sleep(extraDelayMs);
        }
        return elevations;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        if (error instanceof ElevationRequestError && error.status === 429) {
          rateLimitedCount += 1;
          stableBatches = 0;
          currentQps = Math.max(BATCH_QPS_MIN, currentQps * 0.7);
          elevationRateLimiter.setQps(currentQps);
          extraDelayMs = Math.min(EXTRA_DELAY_MAX_MS, Math.max(extraDelayMs * 1.5, 200));
          const nextBatch = reduceBatchSize(batchSize);
          if (nextBatch !== batchSize) {
            batchSize = nextBatch;
          }
          debugLog("Rate limited", {
            retryAfterMs: error.retryAfterMs,
            currentQps,
            batchSize,
            extraDelayMs
          });
          if (error.retryAfterMs && error.retryAfterMs > 0) {
            await sleep(error.retryAfterMs);
          }
          continue;
        }
        const status = error instanceof ElevationRequestError ? error.status : 0;
        if (RETRYABLE_STATUS.has(status) && attempt < MAX_RETRIES) {
          const retryAfterMs =
            error instanceof ElevationRequestError ? error.retryAfterMs : null;
          await sleep(computeBackoffMs(attempt, retryAfterMs));
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  };

  const processPhase = async (phase: SamplingPhase, indices: number[]) => {
    const chunkSize = Math.max(50, batchSize * 2);
    let pending: Array<{ point: { row: number; col: number; lat: number; lon: number }; key: string }> =
      [];

    for (let i = 0; i < indices.length; i += chunkSize) {
      if (options.signal?.aborted) {
        throw createAbortError();
      }
      const slice = indices.slice(i, i + chunkSize);
      const sliceKeys: string[] = [];
      const slicePoints = slice.map((index) => {
        const point = points[index];
        const key = buildElevationCacheKey(provider.id, point.lat, point.lon);
        sliceKeys.push(key);
        return { point, key };
      });
      const cached = topographyCache.getMany(sliceKeys);

      slicePoints.forEach((item) => {
        if (Number.isFinite(values[item.point.row][item.point.col])) {
          return;
        }
        const cachedValue = cached.get(item.key);
        if (cachedValue !== undefined) {
          setValue(item.point, cachedValue);
          return;
        }
        pending.push(item);
      });

      while (pending.length >= batchSize) {
        const batch = pending.splice(0, batchSize);
        const elevations = await fetchBatch(batch);
        applyBatchElevations(batch, elevations);
        reportProgress(phase);
        await yieldToBrowser();
      }

      reportProgress(phase);
      await yieldToBrowser();
    }

    if (pending.length) {
      const elevations = await fetchBatch(pending);
      applyBatchElevations(pending, elevations);
      reportProgress(phase);
      await yieldToBrowser();
    }
  };

  for (const phase of phases) {
    await processPhase(phase.phase, phase.indices);
  }

  const stats = computeGridStats(values);
  grid.minElevation = stats.min;
  grid.maxElevation = stats.max;

  return grid;
}

function resolveGridSize(
  bounds: GeoBounds,
  options: FetchElevationOptions
): { rows: number; cols: number } {
  const rows = options.rows ?? 0;
  const cols = options.cols ?? 0;
  if (rows > 0 && cols > 0) {
    return { rows, cols };
  }
  const spacingMeters =
    options.spacingMeters ??
    (options.spacingFt ? options.spacingFt * 0.3048 : undefined);
  if (!spacingMeters || spacingMeters <= 0) {
    throw new Error("Provide grid rows/cols or a valid spacing.");
  }
  const latMid = (bounds.north + bounds.south) / 2;
  const lonMid = (bounds.east + bounds.west) / 2;
  const widthM = haversineMeters(latMid, bounds.west, latMid, bounds.east);
  const heightM = haversineMeters(bounds.north, lonMid, bounds.south, lonMid);
  const resolvedCols = Math.max(2, Math.round(widthM / spacingMeters) + 1);
  const resolvedRows = Math.max(2, Math.round(heightM / spacingMeters) + 1);
  return { rows: resolvedRows, cols: resolvedCols };
}

function clampGridSize(rows: number, cols: number): { safeRows: number; safeCols: number } {
  let safeRows = Math.max(2, Math.floor(rows));
  let safeCols = Math.max(2, Math.floor(cols));
  if (safeRows * safeCols > MAX_TOTAL_POINTS) {
    const scale = Math.sqrt(MAX_TOTAL_POINTS / (safeRows * safeCols));
    safeRows = Math.max(2, Math.floor(safeRows * scale));
    safeCols = Math.max(2, Math.floor(safeCols * scale));
  }
  while (safeRows * safeCols > MAX_TOTAL_POINTS) {
    if (safeRows >= safeCols && safeRows > 2) {
      safeRows -= 1;
    } else if (safeCols > 2) {
      safeCols -= 1;
    } else {
      break;
    }
  }
  return { safeRows, safeCols };
}

function buildElevationUrl(baseUrl: string, points: Array<{ lat: number; lon: number }>): string {
  const url = new URL(baseUrl);
  url.searchParams.set(
    "latitude",
    points.map((point) => point.lat.toFixed(6)).join(",")
  );
  url.searchParams.set(
    "longitude",
    points.map((point) => point.lon.toFixed(6)).join(",")
  );
  return url.toString();
}

function buildElevationErrorMessage(status: number): string {
  if (status === 429) {
    return "Elevation API rate-limited. Wait a minute and try again.";
  }
  if (status === 504) {
    return "Elevation API timed out. Try again.";
  }
  return `Elevation API failed (${status}).`;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) {
    return null;
  }
  return Math.max(0, dateMs - Date.now());
}

function computeBackoffMs(attempt: number, retryAfterMs: number | null): number {
  const base = RETRY_BASE_MS * 2 ** attempt;
  const jitter = RETRY_BASE_MS * 0.3 * Math.random();
  const retry = retryAfterMs ?? 0;
  return Math.max(base, retry) + jitter;
}

function computeGridStats(values: number[][]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of values) {
    for (const value of row) {
      if (!Number.isFinite(value)) {
        continue;
      }
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 0 };
  }
  return { min, max };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function linspace(start: number, end: number, count: number): number[] {
  if (count <= 1) {
    return [start];
  }
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, idx) => start + idx * step);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || ((error as Error)?.name === "AbortError");
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radius * c;
}
