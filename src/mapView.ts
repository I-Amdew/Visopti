import { GeoBounds } from "./types";

declare const L: {
  map: (container: HTMLElement, options?: Record<string, unknown>) => any;
  tileLayer: (url: string, options?: Record<string, unknown>) => any;
};

export interface MapView {
  getBounds(): GeoBounds;
  getZoom(): number;
  getSize(): { width: number; height: number };
  setLocked(locked: boolean): void;
}

export function createMapView(container: HTMLElement): MapView {
  const map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
  });

  map.setView([47.6062, -122.3321], 13);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

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
