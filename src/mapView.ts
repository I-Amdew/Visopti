import { GeoBounds } from "./types";
import { TileSourceId, TILE_SOURCES, getTileSource } from "./mapTiles";

declare const L: {
  map: (container: HTMLElement, options?: Record<string, unknown>) => any;
  tileLayer: (url: string, options?: Record<string, unknown>) => any;
  rectangle: (
    bounds: [[number, number], [number, number]],
    options?: Record<string, unknown>
  ) => any;
};

export interface MapView {
  getBounds(): GeoBounds;
  getZoom(): number;
  getSize(): { width: number; height: number };
  getLeafletMap(): any;
  getTileSourceId(): TileSourceId;
  setTileSourceId(id: TileSourceId): void;
  setBounds(bounds: GeoBounds, options?: { animate?: boolean; duration?: number }): void;
  setBasemapOpacity(opacity: number): void;
  disableInteractions(): void;
  enableInteractions(): void;
  setLocked(locked: boolean): void;
  setLockedBounds(bounds: GeoBounds | null): void;
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
  let basemapOpacity = 1;
  let lockedBoundsLayer: any | null = null;
  const applyLayerOpacity = (layer: any) => {
    if (layer && typeof layer.setOpacity === "function") {
      layer.setOpacity(basemapOpacity);
    }
  };
  TILE_SOURCES.forEach((source) => {
    const layer = L.tileLayer(source.url, {
      maxZoom: source.maxZoom,
      attribution: source.attribution,
    });
    applyLayerOpacity(layer);
    layers.set(source.id, layer);
  });
  layers.get(activeTileSourceId)?.addTo(map);

  const resizeObserver = new ResizeObserver(() => {
    map.invalidateSize();
  });
  resizeObserver.observe(container);
  const disableInteractions = () => {
    map.dragging.disable();
    map.scrollWheelZoom.disable();
    map.doubleClickZoom.disable();
    map.boxZoom.disable();
    map.keyboard.disable();
    map.touchZoom.disable();
  };
  const enableInteractions = () => {
    map.dragging.enable();
    map.scrollWheelZoom.enable();
    map.doubleClickZoom.enable();
    map.boxZoom.enable();
    map.keyboard.enable();
    map.touchZoom.enable();
  };

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
    getLeafletMap() {
      return map;
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
        applyLayerOpacity(nextLayer);
        nextLayer.addTo(map);
      }
      activeTileSourceId = next.id;
    },
    setBounds(bounds: GeoBounds, options?: { animate?: boolean; duration?: number }) {
      map.fitBounds([
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      ], options);
    },
    setBasemapOpacity(opacity: number) {
      basemapOpacity = Math.min(1, Math.max(0, opacity));
      const activeLayer = layers.get(activeTileSourceId);
      applyLayerOpacity(activeLayer);
    },
    disableInteractions,
    enableInteractions,
    setLockedBounds(bounds: GeoBounds | null) {
      if (!bounds) {
        if (lockedBoundsLayer) {
          map.removeLayer(lockedBoundsLayer);
          lockedBoundsLayer = null;
        }
        return;
      }
      const rectBounds: [[number, number], [number, number]] = [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      ];
      if (!lockedBoundsLayer) {
        lockedBoundsLayer = L.rectangle(rectBounds, {
          color: "#ff2d2d",
          weight: 3,
          opacity: 0.95,
          fill: false,
          interactive: false,
        });
        lockedBoundsLayer.addTo(map);
      } else {
        lockedBoundsLayer.setBounds(rectBounds);
      }
    },
    setLocked(locked: boolean) {
      if (locked) {
        disableInteractions();
        basemapOpacity = Math.min(basemapOpacity, 0.12);
        const activeLayer = layers.get(activeTileSourceId);
        applyLayerOpacity(activeLayer);
      } else {
        enableInteractions();
        basemapOpacity = 1;
        const activeLayer = layers.get(activeTileSourceId);
        applyLayerOpacity(activeLayer);
      }
    },
  };
}
