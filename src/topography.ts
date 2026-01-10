import { ElevationGrid } from "./geo";
import { GeoBounds } from "./types";

const ELEVATION_API = "https://api.open-meteo.com/v1/elevation";
const MAX_BATCH_POINTS = 100;
const MAX_TOTAL_POINTS = 2500;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const BATCH_DELAY_MS = 40;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function fetchElevationGrid(
  bounds: GeoBounds,
  rows: number,
  cols: number
): Promise<ElevationGrid> {
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
  const latitudes = linspace(bounds.south, bounds.north, safeRows);
  const longitudes = linspace(bounds.west, bounds.east, safeCols);

  const values: number[][] = Array.from({ length: safeRows }, () =>
    new Array<number>(safeCols).fill(0)
  );

  const points: { row: number; col: number; lat: number; lon: number }[] = [];
  for (let r = 0; r < safeRows; r += 1) {
    for (let c = 0; c < safeCols; c += 1) {
      points.push({ row: r, col: c, lat: latitudes[r], lon: longitudes[c] });
    }
  }

  for (let start = 0; start < points.length; start += MAX_BATCH_POINTS) {
    const batch = points.slice(start, start + MAX_BATCH_POINTS);
    const latParam = batch.map((point) => point.lat.toFixed(6)).join(",");
    const lonParam = batch.map((point) => point.lon.toFixed(6)).join(",");
    const url = `${ELEVATION_API}?latitude=${latParam}&longitude=${lonParam}`;
    const payload = await fetchElevationBatch(url);
    if (!Array.isArray(payload.elevation)) {
      throw new Error("Elevation API response missing elevation array");
    }
    const elevations = payload.elevation;
    batch.forEach((point, index) => {
      const elevation = elevations[index];
      values[point.row][point.col] =
        typeof elevation === "number" && Number.isFinite(elevation) ? elevation : 0;
    });
    if (BATCH_DELAY_MS > 0 && start + MAX_BATCH_POINTS < points.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;
  for (const row of values) {
    for (const val of row) {
      if (val < minElevation) minElevation = val;
      if (val > maxElevation) maxElevation = val;
    }
  }

  return {
    rows: safeRows,
    cols: safeCols,
    latitudes,
    longitudes,
    values,
    latAscending: true,
    lonAscending: true,
    minElevation,
    maxElevation,
  };
}

async function fetchElevationBatch(url: string): Promise<{ elevation?: number[] }> {
  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        await sleep(computeBackoffMs(attempt, null));
        attempt += 1;
        continue;
      }
      throw new Error("Elevation API unavailable. Check your network and try again.");
    }
    if (response.ok) {
      return (await response.json()) as { elevation?: number[] };
    }
    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
      await sleep(computeBackoffMs(attempt, retryAfterMs));
      attempt += 1;
      continue;
    }
    throw new Error(buildElevationErrorMessage(response.status));
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function linspace(start: number, end: number, count: number): number[] {
  if (count <= 1) {
    return [start];
  }
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, idx) => start + idx * step);
}
