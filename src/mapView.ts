import { GeoBounds } from "./types";
import { TileSourceId, TILE_SOURCES, getTileSource } from "./mapTiles";

declare const L: {
  map: (container: HTMLElement, options?: Record<string, unknown>) => any;
  tileLayer: (url: string, options?: Record<string, unknown>) => any;
};

export interface MapView {
  getBounds(): GeoBounds;
  getZoom(): number;
  getSize(): { width: number; height: number };
  getTileSourceId(): TileSourceId;
  setTileSourceId(id: TileSourceId): void;
  setBounds(bounds: GeoBounds): void;
  setLocked(locked: boolean): void;
}

export function createMapView(container: HTMLElement): MapView {
  const map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
  });

  map.setView([47.6062, -122.3321], 13);
  requestAnimationFrame(() => {
    map.invalidateSize();
  });

  let activeTileSourceId: TileSourceId = "street";
  const layers = new Map<TileSourceId, any>();
  TILE_SOURCES.forEach((source) => {
    layers.set(
      source.id,
      L.tileLayer(source.url, {
        maxZoom: source.maxZoom,
        attribution: source.attribution,
      })
    );
  });
  layers.get(activeTileSourceId)?.addTo(map);

  const resizeObserver = new ResizeObserver(() => {
    map.invalidateSize();
  });
  resizeObserver.observe(container);

  return {
    getBounds() {
      const bounds = map.getBounds();
      return {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      };
    },
    getZoom() {
      return map.getZoom();
    },
    getSize() {
      const size = map.getSize();
      return { width: size.x, height: size.y };
    },
    getTileSourceId() {
      return activeTileSourceId;
    },
    setTileSourceId(id: TileSourceId) {
      if (activeTileSourceId === id) {
        return;
      }
      const next = getTileSource(id);
      const currentLayer = layers.get(activeTileSourceId);
      const nextLayer = layers.get(next.id);
      if (currentLayer) {
        map.removeLayer(currentLayer);
      }
      if (nextLayer) {
        nextLayer.addTo(map);
      }
      activeTileSourceId = next.id;
    },
    setBounds(bounds: GeoBounds) {
      map.fitBounds([
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      ]);
    },
    setLocked(locked: boolean) {
      if (locked) {
        map.dragging.disable();
        map.scrollWheelZoom.disable();
        map.doubleClickZoom.disable();
        map.boxZoom.disable();
        map.keyboard.disable();
        map.touchZoom.disable();
      } else {
        map.dragging.enable();
        map.scrollWheelZoom.enable();
        map.doubleClickZoom.enable();
        map.boxZoom.enable();
        map.keyboard.enable();
        map.touchZoom.enable();
      }
    },
  };
}
