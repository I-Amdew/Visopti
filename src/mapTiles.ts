import { GeoBounds } from "./types";

const TILE_SIZE = 256;

export type TileSourceId = "street" | "satellite";

export interface TileSource {
  id: TileSourceId;
  label: string;
  url: string;
  attribution: string;
  maxZoom: number;
}

export const TILE_SOURCES: TileSource[] = [
  {
    id: "street",
    label: "Street",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  {
    id: "satellite",
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, " +
      "Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
  },
];

export function getTileSource(id: TileSourceId): TileSource {
  return TILE_SOURCES.find((source) => source.id === id) ?? TILE_SOURCES[0];
}

export interface MapFrame {
  bounds: GeoBounds;
  zoom: number;
  width: number;
  height: number;
}

export async function renderMapFrameImage(
  frame: MapFrame,
  tileSource: TileSource
): Promise<HTMLCanvasElement> {
  const { bounds, zoom, width, height } = frame;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for map render");
  }

  const minPixel = projectLatLon(bounds.north, bounds.west, zoom);
  const maxPixel = projectLatLon(bounds.south, bounds.east, zoom);

  const pixelWidth = maxPixel.x - minPixel.x;
  const pixelHeight = maxPixel.y - minPixel.y;
  const scaleX = width / pixelWidth;
  const scaleY = height / pixelHeight;

  const tileRange = getTileRange(minPixel, maxPixel);

  const tilePromises: Promise<TileResult | null>[] = [];
  for (let x = tileRange.minX; x <= tileRange.maxX; x += 1) {
    for (let y = tileRange.minY; y <= tileRange.maxY; y += 1) {
      const url = tileSource.url.replace("{z}", zoom.toString())
        .replace("{x}", x.toString())
        .replace("{y}", y.toString());
      tilePromises.push(
        loadTileImage(url)
          .then((image) => ({ image, x, y }))
          .catch(() => null)
      );
    }
  }

  const tiles = await Promise.all(tilePromises);
  for (const tile of tiles) {
    if (!tile) {
      continue;
    }
    const tileOriginX = tile.x * TILE_SIZE;
    const tileOriginY = tile.y * TILE_SIZE;
    const drawX = (tileOriginX - minPixel.x) * scaleX;
    const drawY = (tileOriginY - minPixel.y) * scaleY;
    const drawWidth = TILE_SIZE * scaleX;
    const drawHeight = TILE_SIZE * scaleY;
    ctx.drawImage(tile.image, drawX, drawY, drawWidth, drawHeight);
  }

  return canvas;
}

type TileResult = { image: HTMLImageElement; x: number; y: number };

type PixelPoint = { x: number; y: number };

function projectLatLon(lat: number, lon: number, zoom: number): PixelPoint {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function getTileRange(minPixel: PixelPoint, maxPixel: PixelPoint) {
  return {
    minX: Math.floor(minPixel.x / TILE_SIZE),
    maxX: Math.floor(maxPixel.x / TILE_SIZE),
    minY: Math.floor(minPixel.y / TILE_SIZE),
    maxY: Math.floor(maxPixel.y / TILE_SIZE),
  };
}

function loadTileImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}
