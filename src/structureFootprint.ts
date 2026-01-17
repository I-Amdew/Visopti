import type { ImportedModelRef, StructureParams } from "./types";

export function resolveStructureRotationDeg(structure: StructureParams): number {
  if (structure.mode !== "imported" || !structure.imported) {
    return structure.rotationDeg;
  }
  return normalizeImportedTransform(structure.imported).rotationDeg;
}

export function resolveStructureFootprintPoints(structure: StructureParams): { x: number; y: number }[] {
  const fallback = structure.footprint.points ?? [];
  if (structure.mode !== "imported") {
    return fallback;
  }
  const proxy = structure.imported?.footprintProxy?.points;
  if (!proxy || proxy.length < 3) {
    return fallback;
  }
  return transformImportedFootprint(proxy, structure.imported);
}

export function transformImportedFootprint(
  points: { x: number; y: number }[],
  imported: ImportedModelRef | undefined
): { x: number; y: number }[] {
  if (!imported || points.length === 0) {
    return [];
  }
  const { scale, offset } = normalizeImportedTransform(imported);
  return points.map((point) => ({
    x: (point.x + offset.x) * scale,
    y: (point.y + offset.z) * scale
  }));
}

function normalizeImportedTransform(imported: ImportedModelRef): {
  scale: number;
  rotationDeg: number;
  offset: { x: number; y: number; z: number };
} {
  const scale = Number.isFinite(imported.scale) && imported.scale > 0 ? imported.scale : 1;
  const rotationDeg = Number.isFinite(imported.rotationDeg) ? imported.rotationDeg : 0;
  const offset = imported.offset ?? { x: 0, y: 0, z: 0 };
  return {
    scale,
    rotationDeg,
    offset: {
      x: Number.isFinite(offset.x) ? offset.x : 0,
      y: Number.isFinite(offset.y) ? offset.y : 0,
      z: Number.isFinite(offset.z) ? offset.z : 0
    }
  };
}
