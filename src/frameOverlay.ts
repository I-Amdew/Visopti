import type { GeoBounds, GeoPoint } from "./types";
import { boundsCenter, clampBoundsToCorner, type FrameCorner } from "./frameGeometry";

declare const L: {
  rectangle: (bounds: [[number, number], [number, number]], options?: Record<string, unknown>) => any;
  marker: (latlng: [number, number], options?: Record<string, unknown>) => any;
  divIcon: (options?: Record<string, unknown>) => any;
  layerGroup: (layers?: any[]) => any;
};

type HandleKey = FrameCorner | "center";

export interface FrameOverlayOptions {
  minSideM: number;
  maxSideM: number;
  editable?: boolean;
  visible?: boolean;
  onChange?: (bounds: GeoBounds) => void;
}

export interface FrameOverlay {
  setBounds(bounds: GeoBounds | null, options?: { silent?: boolean }): void;
  getBounds(): GeoBounds | null;
  setEditable(editable: boolean): void;
  setVisible(visible: boolean): void;
  setLimits(minSideM: number, maxSideM: number): void;
  destroy(): void;
}

const OPPOSITE_CORNER: Record<FrameCorner, FrameCorner> = {
  ne: "sw",
  nw: "se",
  se: "nw",
  sw: "ne"
};

export function createFrameOverlay(map: any, options: FrameOverlayOptions): FrameOverlay {
  let bounds: GeoBounds | null = null;
  let editable = options.editable ?? true;
  let visible = options.visible ?? true;
  let minSideM = options.minSideM;
  let maxSideM = options.maxSideM;
  let rect: any | null = null;
  const handles = new Map<HandleKey, any>();
  const group = L.layerGroup();
  let attached = false;
  let syncing = false;
  let dragCorner: FrameCorner | null = null;
  let dragAnchor: GeoPoint | null = null;
  let dragStart: { bounds: GeoBounds; center: GeoPoint } | null = null;

  const attach = () => {
    if (attached) return;
    group.addTo(map);
    attached = true;
  };

  const detach = () => {
    if (!attached) return;
    map.removeLayer(group);
    attached = false;
  };

  const emitChange = () => {
    if (bounds) {
      options.onChange?.(bounds);
    }
  };

  const toBoundsTuple = (next: GeoBounds): [[number, number], [number, number]] => [
    [next.south, next.west],
    [next.north, next.east]
  ];

  const ensureRect = () => {
    if (rect) return;
    rect = L.rectangle(
      [
        [0, 0],
        [0, 0]
      ],
      {
        color: "#3bb2ff",
        weight: 2,
        opacity: 0.9,
        fillColor: "#3bb2ff",
        fillOpacity: 0.12,
        interactive: false
      }
    );
    group.addLayer(rect);
  };

  const handleIcon = (key: HandleKey) =>
    L.divIcon({
      className: `frame-handle frame-handle-${key}`,
      iconSize: key === "center" ? [14, 14] : [12, 12],
      iconAnchor: key === "center" ? [7, 7] : [6, 6]
    });

  const ensureHandles = () => {
    if (handles.size > 0) return;
    (["ne", "nw", "se", "sw"] as FrameCorner[]).forEach((corner) => {
      const marker = L.marker([0, 0], {
        draggable: true,
        icon: handleIcon(corner),
        keyboard: false,
        zIndexOffset: 1000
      });
      marker.on("dragstart", () => {
        if (!bounds || syncing) return;
        dragCorner = corner;
        dragAnchor = getCorner(bounds, OPPOSITE_CORNER[corner]);
      });
      marker.on("drag", () => {
        if (!bounds || syncing || !dragCorner || !dragAnchor) return;
        const moving = toPoint(marker.getLatLng());
        const nextBounds = clampBoundsToCorner(dragAnchor, dragCorner, moving, minSideM, maxSideM);
        applyBounds(nextBounds, { silent: true, activeHandle: corner });
        emitChange();
      });
      marker.on("dragend", () => {
        dragCorner = null;
        dragAnchor = null;
      });
      handles.set(corner, marker);
      group.addLayer(marker);
    });

    const centerMarker = L.marker([0, 0], {
      draggable: true,
      icon: handleIcon("center"),
      keyboard: false,
      zIndexOffset: 900
    });
    centerMarker.on("dragstart", () => {
      if (!bounds || syncing) return;
      dragStart = { bounds, center: boundsCenter(bounds) };
    });
    centerMarker.on("drag", () => {
      if (!dragStart || syncing) return;
      const nextCenter = toPoint(centerMarker.getLatLng());
      const deltaLat = nextCenter.lat - dragStart.center.lat;
      const deltaLon = nextCenter.lon - dragStart.center.lon;
      const nextBounds: GeoBounds = {
        north: dragStart.bounds.north + deltaLat,
        south: dragStart.bounds.south + deltaLat,
        east: dragStart.bounds.east + deltaLon,
        west: dragStart.bounds.west + deltaLon
      };
      applyBounds(nextBounds, { silent: true, activeHandle: "center" });
      emitChange();
    });
    centerMarker.on("dragend", () => {
      dragStart = null;
    });
    handles.set("center", centerMarker);
    group.addLayer(centerMarker);
  };

  const syncHandleVisibility = () => {
    handles.forEach((marker) => {
      if (editable) {
        marker.dragging?.enable();
      } else {
        marker.dragging?.disable();
      }
      marker.setOpacity(editable ? 1 : 0);
      const element = marker.getElement();
      if (element) {
        element.classList.toggle("frame-handle-hidden", !editable);
      }
    });
  };

  const updateHandles = (next: GeoBounds, activeHandle?: HandleKey) => {
    const corners = getCorners(next);
    handles.forEach((marker, key) => {
      if (key === "center") {
        if (activeHandle === "center") {
          return;
        }
        const center = boundsCenter(next);
        marker.setLatLng([center.lat, center.lon]);
        return;
      }
      if (activeHandle === key) {
        const corner = corners[key];
        const current = toPoint(marker.getLatLng());
        if (Math.abs(current.lat - corner.lat) < 1e-10 && Math.abs(current.lon - corner.lon) < 1e-10) {
          return;
        }
      }
      const corner = corners[key as FrameCorner];
      marker.setLatLng([corner.lat, corner.lon]);
    });
  };

  const applyBounds = (
    next: GeoBounds,
    opts?: { silent?: boolean; activeHandle?: HandleKey }
  ) => {
    bounds = next;
    ensureRect();
    ensureHandles();
    if (visible) {
      attach();
    }
    syncing = true;
    rect?.setBounds(toBoundsTuple(next));
    updateHandles(next, opts?.activeHandle);
    syncing = false;
    syncHandleVisibility();
    if (!opts?.silent) {
      emitChange();
    }
  };

  const clearLayers = () => {
    if (rect) {
      group.removeLayer(rect);
      rect = null;
    }
    handles.forEach((marker) => group.removeLayer(marker));
    handles.clear();
  };

  const setBounds = (next: GeoBounds | null, opts?: { silent?: boolean }) => {
    if (!next) {
      bounds = null;
      clearLayers();
      detach();
      return;
    }
    applyBounds(next, opts);
  };

  const setEditable = (nextEditable: boolean) => {
    editable = nextEditable;
    syncHandleVisibility();
  };

  const setVisible = (nextVisible: boolean) => {
    visible = nextVisible;
    if (!bounds) {
      detach();
      return;
    }
    if (visible) {
      attach();
      syncHandleVisibility();
    } else {
      detach();
    }
  };

  const setLimits = (nextMinSideM: number, nextMaxSideM: number) => {
    minSideM = nextMinSideM;
    maxSideM = nextMaxSideM;
  };

  const destroy = () => {
    clearLayers();
    detach();
  };

  return {
    setBounds,
    getBounds() {
      return bounds ? { ...bounds } : null;
    },
    setEditable,
    setVisible,
    setLimits,
    destroy
  };
}

function getCorners(bounds: GeoBounds): Record<FrameCorner, GeoPoint> {
  return {
    ne: { lat: bounds.north, lon: bounds.east },
    nw: { lat: bounds.north, lon: bounds.west },
    se: { lat: bounds.south, lon: bounds.east },
    sw: { lat: bounds.south, lon: bounds.west }
  };
}

function getCorner(bounds: GeoBounds, corner: FrameCorner): GeoPoint {
  return getCorners(bounds)[corner];
}

function toPoint(latLng: { lat: number; lng?: number; lon?: number }): GeoPoint {
  return {
    lat: latLng.lat,
    lon: latLng.lng ?? latLng.lon ?? 0
  };
}
