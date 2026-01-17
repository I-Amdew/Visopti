import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { ImportedModelRef } from "../types";

export type ModelFormat = ImportedModelRef["format"];

const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();
const stlLoader = new STLLoader();

export async function loadModelFromBuffer(
  data: ArrayBuffer,
  format: ModelFormat
): Promise<THREE.Object3D | null> {
  if (format === "glb") {
    return parseGltf(data);
  }
  if (format === "gltf") {
    const text = new TextDecoder().decode(data);
    return parseGltf(text);
  }
  if (format === "obj") {
    const text = new TextDecoder().decode(data);
    try {
      return objLoader.parse(text);
    } catch {
      return null;
    }
  }
  if (format === "stl") {
    try {
      const geometry = stlLoader.parse(data);
      const material = new THREE.MeshStandardMaterial({
        color: 0x93c5fd,
        roughness: 0.4,
        metalness: 0.1
      });
      return new THREE.Mesh(geometry, material);
    } catch {
      return null;
    }
  }
  return null;
}

export function buildFootprintProxy(object: THREE.Object3D): { points: { x: number; y: number }[] } | null {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    return null;
  }
  const { min, max } = box;
  if (![min.x, max.x, min.z, max.z].every(Number.isFinite)) {
    return null;
  }
  return {
    points: [
      { x: min.x, y: min.z },
      { x: max.x, y: min.z },
      { x: max.x, y: max.z },
      { x: min.x, y: max.z }
    ]
  };
}

function parseGltf(data: ArrayBuffer | string): Promise<THREE.Object3D | null> {
  return new Promise((resolve) => {
    gltfLoader.parse(
      data,
      "",
      (gltf) => {
        resolve(gltf.scene ?? gltf.scenes?.[0] ?? null);
      },
      () => resolve(null)
    );
  });
}
