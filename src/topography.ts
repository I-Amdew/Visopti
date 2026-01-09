import { ElevationGrid } from "./geo";
import { GeoBounds } from "./types";

const ELEVATION_API = "https://api.open-meteo.com/v1/elevation";
const MAX_BATCH_POINTS = 100;

export async function fetchElevationGrid(
  bounds: GeoBounds,
  rows: number,
  cols: number
): Promise<ElevationGrid> {
  const safeRows = Math.max(2, Math.floor(rows));
  const safeCols = Math.max(2, Math.floor(cols));
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
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Elevation API failed (${response.status})`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload.elevation)) {
      throw new Error("Elevation API response missing elevation array");
    }
    batch.forEach((point, index) => {
      const elevation = payload.elevation[index];
      values[point.row][point.col] =
        typeof elevation === "number" && Number.isFinite(elevation) ? elevation : 0;
    });
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

function linspace(start: number, end: number, count: number): number[] {
  if (count <= 1) {
    return [start];
  }
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, idx) => start + idx * step);
}
