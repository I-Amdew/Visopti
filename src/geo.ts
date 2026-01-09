import { GeoReference } from "./types";

const FEET_TO_METERS = 0.3048;

export interface ElevationGrid {
  rows: number;
  cols: number;
  latitudes: number[];
  longitudes: number[];
  values: number[][]; // [row][col]
  latAscending: boolean;
  lonAscending: boolean;
  minElevation: number;
  maxElevation: number;
}

export async function loadGeoReference(
  path = "Assets/image_georeference.json"
): Promise<GeoReference> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load georeference JSON: ${response.status}`);
  }
  return response.json();
}

export async function loadElevationGrid(geo: GeoReference): Promise<ElevationGrid> {
  const csvFilename = geo.elevation_data.csv_filename;
  const response = await fetch(`Assets/${csvFilename}`);
  if (!response.ok) {
    throw new Error(`Failed to load elevation CSV: ${response.status}`);
  }
  const text = await response.text();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length <= 1) {
    throw new Error("CSV missing data rows");
  }

  const header = parseCsvLine(lines[0]);
  const normalizedHeader = header.map(normalizeHeaderName);

  const latIndex = findHeaderIndex(normalizedHeader, ["latitude", "lat"]);
  const lonIndex = findHeaderIndex(normalizedHeader, ["longitude", "lon"]);
  const elevationIndex = findHeaderIndex(normalizedHeader, [
    "elevation_m",
    "elevation",
    "elevation (m)",
    "elevation_meters",
    "elev_m",
    "elev (m)",
  ]);
  const elevationFeetIndex = findHeaderIndex(normalizedHeader, [
    "elevation_ft",
    "elevation (ft)",
    "elev_ft",
    "elevation_feet",
  ]);

  if (latIndex === -1 || lonIndex === -1) {
    throw new Error(
      `CSV missing latitude/longitude columns. Saw headers: ${header.join(", ")}`
    );
  }
  if (elevationIndex === -1 && elevationFeetIndex === -1) {
    throw new Error(
      `CSV missing elevation column in metres/feet. Saw headers: ${header.join(", ")}`
    );
  }

  const latSet = new Set<number>();
  const lonSet = new Set<number>();
  const valueMap = new Map<string, number>();

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const lat = parseFloat(cols[latIndex]);
    const lon = parseFloat(cols[lonIndex]);
    const elevMeters =
      elevationIndex !== -1 ? parseFloat(cols[elevationIndex]) : Number.NaN;
    const elevFeet =
      elevationFeetIndex !== -1 ? parseFloat(cols[elevationFeetIndex]) : Number.NaN;
    const elev = Number.isFinite(elevMeters)
      ? elevMeters
      : Number.isFinite(elevFeet)
        ? elevFeet * FEET_TO_METERS
        : Number.NaN;
    if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(elev)) {
      latSet.add(lat);
      lonSet.add(lon);
      valueMap.set(gridKey(lat, lon), elev);
    }
  }

  if (latSet.size === 0 || lonSet.size === 0) {
    throw new Error("CSV missing latitude/longitude rows");
  }

  const latitudesAscending = Array.from(latSet).sort((a, b) => a - b);
  const longitudesAscending = Array.from(lonSet).sort((a, b) => a - b);

  const layout = geo.elevation_data.grid_layout;
  const warnIfMismatch = (expected: number, actual: number, label: string) => {
    if (expected > 0 && expected !== actual) {
      console.warn(
        `[geo] ${label} mismatch: metadata=${expected}, CSV=${actual}. Using CSV count.`
      );
    }
  };
  warnIfMismatch(layout.rows, latitudesAscending.length, "row count");
  warnIfMismatch(layout.cols, longitudesAscending.length, "column count");

  const latitudes = layout.lat_sorted_ascending
    ? latitudesAscending
    : [...latitudesAscending].reverse();
  const longitudes = layout.lon_sorted_ascending
    ? longitudesAscending
    : [...longitudesAscending].reverse();

  const values = latitudes.map((lat) =>
    longitudes.map((lon) => {
      const key = gridKey(lat, lon);
      const val = valueMap.get(key);
      if (typeof val !== "number") {
        throw new Error(`Missing elevation for lat ${lat} lon ${lon}`);
      }
      return val;
    })
  );

  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;
  for (const row of values) {
    for (const val of row) {
      if (val < minElevation) minElevation = val;
      if (val > maxElevation) maxElevation = val;
    }
  }

  return {
    rows: latitudes.length,
    cols: longitudes.length,
    latitudes,
    longitudes,
    values,
    latAscending: layout.lat_sorted_ascending,
    lonAscending: layout.lon_sorted_ascending,
    minElevation,
    maxElevation,
  };
}

export class GeoMapper {
  public readonly grid: ElevationGrid;
  public readonly geo: GeoReference;
  private readonly latRange: number;
  private readonly lonRange: number;
  private latCache: Float64Array | null;
  private lonCache: Float64Array | null;

  constructor(geo: GeoReference, grid: ElevationGrid) {
    this.geo = geo;
    this.grid = grid;
    this.latRange = geo.bounds.lat_max_north - geo.bounds.lat_min_south;
    this.lonRange = geo.bounds.lon_max_east - geo.bounds.lon_min_west;
    this.latCache = null;
    this.lonCache = null;
    this.populatePixelAxisCaches();
  }

  /**
   * Maps image pixels → latitude/longitude using the formulas from image_georeference.json:
   *   lat = lat_max_north - ((y + 0.5) / height_px) * (lat_max_north - lat_min_south)
   *   lon = lon_min_west  + ((x + 0.5) / width_px ) * (lon_max_east  - lon_min_west)
   */
  pixelToLatLon(x: number, y: number): { lat: number; lon: number } {
    const { width_px, height_px } = this.geo.image;
    const hasCached =
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < width_px &&
      y < height_px &&
      this.latCache &&
      this.lonCache;
    if (hasCached) {
      // Cached arrays avoid repeated per-pixel math on high-DPI canvases
      return { lat: this.latCache![y], lon: this.lonCache![x] };
    }
    const { lat_max_north, lat_min_south, lon_min_west, lon_max_east } = this.geo.bounds;
    const fy = (y + 0.5) / height_px;
    const fx = (x + 0.5) / width_px;
    const lat = lat_max_north - fy * (lat_max_north - lat_min_south);
    const lon = lon_min_west + fx * (lon_max_east - lon_min_west);
    return { lat, lon };
  }

  /** Inverse of pixelToLatLon so contour nodes can be projected back to image pixels. */
  latLonToPixel(lat: number, lon: number): { x: number; y: number } {
    const { width_px, height_px } = this.geo.image;
    const { lat_max_north, lat_min_south, lon_min_west, lon_max_east } = this.geo.bounds;
    const fy = (lat_max_north - lat) / (lat_max_north - lat_min_south);
    const fx = (lon - lon_min_west) / (lon_max_east - lon_min_west);
    return {
      x: fx * width_px - 0.5,
      y: fy * height_px - 0.5,
    };
  }

  /**
   * Converts a latitude/longitude into continuous grid coordinates using the grid layout metadata.
   * u = (lat - lat_min_south) / (lat_max_north - lat_min_south)
   * v = (lon - lon_min_west)  / (lon_max_east  - lon_min_west)
   * i = u * (rows - 1), j = v * (cols - 1)
   */
  latLonToGridCoords(lat: number, lon: number): { row: number; col: number } {
    const rows = Math.max(1, this.grid.rows);
    const cols = Math.max(1, this.grid.cols);
    const uRaw = this.latRange === 0 ? 0 : (lat - this.geo.bounds.lat_min_south) / this.latRange;
    const vRaw = this.lonRange === 0 ? 0 : (lon - this.geo.bounds.lon_min_west) / this.lonRange;
    const u = clamp(uRaw, 0, 1);
    const v = clamp(vRaw, 0, 1);
    const rowRatio = this.grid.latAscending ? u : 1 - u;
    const colRatio = this.grid.lonAscending ? v : 1 - v;
    return {
      row: rowRatio * (rows - 1),
      col: colRatio * (cols - 1),
    };
  }

  latLonToElevation(lat: number, lon: number): number {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return 0;
    }
    if (this.grid.rows === 0 || this.grid.cols === 0) {
      return 0;
    }
    const { row, col } = this.latLonToGridCoords(lat, lon);
    const r0 = Math.floor(row);
    const c0 = Math.floor(col);
    const r1 = Math.min(r0 + 1, this.grid.rows - 1);
    const c1 = Math.min(c0 + 1, this.grid.cols - 1);
    const rt = row - r0;
    const ct = col - c0;

    const v00 = this.grid.values[r0][c0];
    const v01 = this.grid.values[r0][c1];
    const v10 = this.grid.values[r1][c0];
    const v11 = this.grid.values[r1][c1];
    const top = lerp(v00, v01, ct);
    const bottom = lerp(v10, v11, ct);
    return lerp(top, bottom, rt);
  }

  pixelToElevation(x: number, y: number): number {
    const { lat, lon } = this.pixelToLatLon(x, y);
    return this.latLonToElevation(lat, lon);
  }

  gridRowToLat(row: number): number {
    const clamped = clamp(Math.round(row), 0, this.grid.rows - 1);
    return this.grid.latitudes[clamped];
  }

  gridColToLon(col: number): number {
    const clamped = clamp(Math.round(col), 0, this.grid.cols - 1);
    return this.grid.longitudes[clamped];
  }

  gridNodeToPixel(row: number, col: number): { x: number; y: number } {
    const lat = this.gridRowToLat(row);
    const lon = this.gridColToLon(col);
    return this.latLonToPixel(lat, lon);
  }

  private populatePixelAxisCaches(): void {
    const { width_px, height_px } = this.geo.image;
    const { lat_max_north, lat_min_south, lon_min_west, lon_max_east } = this.geo.bounds;
    this.latCache = new Float64Array(height_px);
    this.lonCache = new Float64Array(width_px);
    const latRange = lat_max_north - lat_min_south;
    const lonRange = lon_max_east - lon_min_west;
    for (let y = 0; y < height_px; y += 1) {
      const fy = (y + 0.5) / height_px;
      this.latCache[y] = lat_max_north - fy * latRange;
    }
    for (let x = 0; x < width_px; x += 1) {
      const fx = (x + 0.5) / width_px;
      this.lonCache[x] = lon_min_west + fx * lonRange;
    }
  }
}

function gridKey(lat: number, lon: number): string {
  return `${lat.toFixed(8)}|${lon.toFixed(8)}`;
}

function parseCsvLine(line: string): string[] {
  return line.split(",").map((part) => part.replace(/\uFEFF/g, "").trim());
}

function normalizeHeaderName(name: string): string {
  return name.replace(/^\uFEFF/, "").trim().toLowerCase();
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  return headers.findIndex((header) => candidates.includes(header));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
