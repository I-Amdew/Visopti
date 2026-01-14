import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { boundsSizeMeters } from "../frameGeometry";
import type { ElevationGrid } from "../geo";
import type { GeoBounds, GeoProjector, TrafficFlowDensity } from "../types";
import type { TrafficEdgeTraffic } from "../traffic/types";
import { demandWeightForClass, resolveLaneCounts } from "../traffic/lanes";
import type { WorldModel } from "../world/worldModel";

export type ThreeViewMode = "idle" | "computing" | "interactive";

export interface TrafficFlowData {
  edgeTraffic?: TrafficEdgeTraffic[] | null;
  flowDensity?: TrafficFlowDensity;
}

export interface ThreeView {
  init(containerEl: HTMLElement): boolean;
  setWorldModel(worldModel: WorldModel | null): void;
  setTerrain(elevationGrid: ElevationGrid | null, geoProjector: GeoProjector | null): void;
  setTraffic(flowData: TrafficFlowData | null): void;
  setMode(mode: ThreeViewMode): void;
  dispose(): void;
}

type FrameMeters = { widthM: number; heightM: number };

type TerrainState = {
  grid: ElevationGrid;
  bounds: GeoBounds;
  min: number;
  max: number;
};

type TrafficPath = {
  from: THREE.Vector3;
  to: THREE.Vector3;
  dir: THREE.Vector3;
  lengthM: number;
  yaw: number;
  speedMps: number;
};

type TrafficVehicle = {
  pathIndex: number;
  offset: number;
  speedMps: number;
};

const LANE_WIDTH_M = 3.4;
const ROAD_HEIGHT_OFFSET = 0.08;
const BUILDING_MIN_HEIGHT_M = 3;
const STRUCTURE_BASE_OFFSET = 0.04;
const TREE_BASE_OFFSET = 0.02;
const SIGN_BASE_OFFSET = 0.03;
const TRAFFIC_BASE_OFFSET = 0.08;
const MAX_VEHICLES = 1200;

const DEFAULT_COLORS = {
  terrain: 0x2f6f3f,
  road: 0x2a3138,
  building: 0x6b7280,
  structure: 0x38bdf8,
  tree: 0x22c55e,
  treeTrunk: 0x8b5e3c,
  sign: 0xf59e0b,
  traffic: 0xfbbf24
};

const densityFactorByFlow: Record<TrafficFlowDensity, number> = {
  low: 4,
  medium: 7,
  high: 11
};

export function createThreeView(): ThreeView {
  let container: HTMLElement | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controls: OrbitControls | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let animationFrame: number | null = null;
  let lastTime = 0;
  let currentMode: ThreeViewMode = "idle";
  let frameBounds: GeoBounds | null = null;
  let frameMeters: FrameMeters | null = null;
  let terrainState: TerrainState | null = null;
  let worldModel: WorldModel | null = null;
  let trafficData: TrafficFlowData | null = null;
  let trafficMesh: THREE.InstancedMesh | null = null;
  let trafficVehicles: TrafficVehicle[] = [];
  let trafficPaths: TrafficPath[] = [];
  let cameraTargets: { overhead: THREE.Vector3; orbit: THREE.Vector3 } | null = null;
  let cameraTween:
    | { start: THREE.Vector3; end: THREE.Vector3; startTime: number; duration: number }
    | null = null;

  const rootGroup = new THREE.Group();
  const terrainGroup = new THREE.Group();
  const roadGroup = new THREE.Group();
  const buildingGroup = new THREE.Group();
  const treeGroup = new THREE.Group();
  const signGroup = new THREE.Group();
  const structureGroup = new THREE.Group();
  const trafficGroup = new THREE.Group();

  const materials = {
    terrain: new THREE.MeshPhongMaterial({
      color: DEFAULT_COLORS.terrain,
      shininess: 12
    }),
    road: new THREE.MeshStandardMaterial({
      color: DEFAULT_COLORS.road,
      roughness: 0.85,
      metalness: 0.05
    }),
    building: new THREE.MeshStandardMaterial({
      color: DEFAULT_COLORS.building,
      roughness: 0.7,
      metalness: 0.05
    }),
    structure: new THREE.MeshStandardMaterial({
      color: DEFAULT_COLORS.structure,
      roughness: 0.4,
      metalness: 0.15
    }),
    tree: new THREE.MeshLambertMaterial({
      color: DEFAULT_COLORS.tree
    }),
    treeTrunk: new THREE.MeshLambertMaterial({
      color: DEFAULT_COLORS.treeTrunk
    }),
    sign: new THREE.MeshStandardMaterial({
      color: DEFAULT_COLORS.sign,
      side: THREE.DoubleSide,
      roughness: 0.4,
      metalness: 0.1
    }),
    traffic: new THREE.MeshBasicMaterial({
      color: DEFAULT_COLORS.traffic,
      transparent: true,
      opacity: 0.85
    })
  };

  const disposeGroup = (group: THREE.Group) => {
    group.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh) {
        child.geometry?.dispose();
      }
    });
    group.clear();
  };

  const disposeTraffic = () => {
    if (trafficMesh) {
      trafficMesh.geometry.dispose();
      trafficGroup.remove(trafficMesh);
    }
    trafficMesh = null;
    trafficVehicles = [];
    trafficPaths = [];
  };

  const clamp = (value: number, min: number, max: number) => {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  };

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const getFrameMeters = (bounds: GeoBounds): FrameMeters => {
    const { widthM, heightM } = boundsSizeMeters(bounds);
    return { widthM, heightM };
  };

  const boundsEqual = (a: GeoBounds, b: GeoBounds) =>
    a.north === b.north && a.south === b.south && a.east === b.east && a.west === b.west;

  const ensureFrameMetrics = (bounds: GeoBounds | null) => {
    if (!bounds) {
      frameBounds = null;
      frameMeters = null;
      cameraTargets = null;
      return;
    }
    if (frameBounds && boundsEqual(frameBounds, bounds)) {
      return;
    }
    frameBounds = bounds;
    frameMeters = getFrameMeters(bounds);
    updateCameraBounds();
  };

  const updateCameraBounds = () => {
    if (!frameMeters || !camera || !controls) {
      return;
    }
    const size = Math.max(frameMeters.widthM, frameMeters.heightM, 10);
    const radius = size * 1.15;
    camera.near = Math.max(0.1, size * 0.01);
    camera.far = size * 8;
    camera.updateProjectionMatrix();
    controls.minDistance = size * 0.35;
    controls.maxDistance = size * 4.5;
    cameraTargets = {
      overhead: new THREE.Vector3(0, radius, 0.001),
      orbit: new THREE.Vector3(radius * 0.65, radius * 0.45, radius * 0.65)
    };
    if (currentMode === "idle") {
      moveCameraInstant(cameraTargets.overhead);
      requestRender();
    }
  };

  const moveCameraInstant = (target: THREE.Vector3) => {
    if (!camera || !controls) {
      return;
    }
    camera.position.copy(target);
    controls.target.set(0, 0, 0);
    controls.update();
  };

  const moveCameraSmooth = (target: THREE.Vector3, durationMs = 650) => {
    if (!camera) {
      return;
    }
    cameraTween = {
      start: camera.position.clone(),
      end: target.clone(),
      startTime: performance.now(),
      duration: durationMs
    };
  };

  const projectLatLon = (
    bounds: GeoBounds,
    meters: FrameMeters,
    lat: number,
    lon: number
  ): { x: number; z: number } | null => {
    const latSpan = bounds.north - bounds.south;
    const lonSpan = bounds.east - bounds.west;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || latSpan === 0 || lonSpan === 0) {
      return null;
    }
    const x = ((lon - bounds.west) / lonSpan - 0.5) * meters.widthM;
    const z = ((lat - bounds.south) / latSpan - 0.5) * meters.heightM;
    return { x, z };
  };

  const sampleElevation = (lat: number, lon: number): number => {
    if (!terrainState) {
      return 0;
    }
    const { grid, bounds, min } = terrainState;
    const latSpan = bounds.north - bounds.south;
    const lonSpan = bounds.east - bounds.west;
    if (latSpan === 0 || lonSpan === 0) {
      return 0;
    }
    const uRaw = (lat - bounds.south) / latSpan;
    const vRaw = (lon - bounds.west) / lonSpan;
    const u = clamp(uRaw, 0, 1);
    const v = clamp(vRaw, 0, 1);
    const rowRatio = grid.latAscending ? u : 1 - u;
    const colRatio = grid.lonAscending ? v : 1 - v;
    const row = rowRatio * (grid.rows - 1);
    const col = colRatio * (grid.cols - 1);
    const r0 = Math.floor(row);
    const c0 = Math.floor(col);
    const r1 = Math.min(r0 + 1, grid.rows - 1);
    const c1 = Math.min(c0 + 1, grid.cols - 1);
    const rt = row - r0;
    const ct = col - c0;
    const v00 = grid.values[r0][c0];
    const v01 = grid.values[r0][c1];
    const v10 = grid.values[r1][c0];
    const v11 = grid.values[r1][c1];
    if (![v00, v01, v10, v11].every((value) => Number.isFinite(value))) {
      return 0;
    }
    const top = lerp(v00, v01, ct);
    const bottom = lerp(v10, v11, ct);
    return lerp(top, bottom, rt) - min;
  };

  const projectLatLonWithHeight = (lat: number, lon: number): THREE.Vector3 | null => {
    if (!frameBounds || !frameMeters) {
      return null;
    }
    const base = projectLatLon(frameBounds, frameMeters, lat, lon);
    if (!base) {
      return null;
    }
    return new THREE.Vector3(base.x, sampleElevation(lat, lon), base.z);
  };

  const buildTerrain = () => {
    disposeGroup(terrainGroup);
    if (!frameBounds || !frameMeters) {
      return;
    }
    if (!terrainState) {
      const geometry = new THREE.PlaneGeometry(frameMeters.widthM, frameMeters.heightM, 1, 1);
      geometry.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geometry, materials.terrain);
      mesh.receiveShadow = false;
      terrainGroup.add(mesh);
      return;
    }
    const { grid, min } = terrainState;
    const rows = Math.max(2, grid.rows);
    const cols = Math.max(2, grid.cols);
    const vertexCount = rows * cols;
    const positions = new Float32Array(vertexCount * 3);
    let offset = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const lat = grid.latitudes[r];
        const lon = grid.longitudes[c];
        const projected = projectLatLon(frameBounds, frameMeters, lat, lon);
        const elevation = grid.values[r]?.[c];
        const y = Number.isFinite(elevation) ? (elevation as number) - min : 0;
        positions[offset] = projected?.x ?? 0;
        positions[offset + 1] = y;
        positions[offset + 2] = projected?.z ?? 0;
        offset += 3;
      }
    }
    const indices: number[] = [];
    for (let r = 0; r < rows - 1; r += 1) {
      for (let c = 0; c < cols - 1; c += 1) {
        const a = r * cols + c;
        const b = r * cols + c + 1;
        const c1 = (r + 1) * cols + c;
        const d = (r + 1) * cols + c + 1;
        indices.push(a, b, c1, b, d, c1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, materials.terrain);
    mesh.receiveShadow = false;
    terrainGroup.add(mesh);
  };

  const simplifyProjectedPolyline = (
    points: THREE.Vector3[],
    maxPoints: number,
    minSpacing: number
  ) => {
    if (points.length <= 2) {
      return points;
    }
    const filtered: THREE.Vector3[] = [points[0]];
    let last = points[0];
    for (let i = 1; i < points.length - 1; i += 1) {
      const point = points[i];
      const dx = point.x - last.x;
      const dz = point.z - last.z;
      if (dx * dx + dz * dz >= minSpacing * minSpacing) {
        filtered.push(point);
        last = point;
      }
    }
    filtered.push(points[points.length - 1]);
    if (filtered.length <= maxPoints) {
      return filtered;
    }
    const step = Math.ceil(filtered.length / maxPoints);
    const sampled: THREE.Vector3[] = [];
    for (let i = 0; i < filtered.length; i += step) {
      sampled.push(filtered[i]);
    }
    if (sampled[sampled.length - 1] !== filtered[filtered.length - 1]) {
      sampled.push(filtered[filtered.length - 1]);
    }
    return sampled;
  };

  const buildRoads = () => {
    disposeGroup(roadGroup);
    if (!worldModel || !frameBounds || !frameMeters) {
      return;
    }
    const vertices: number[] = [];
    const indices: number[] = [];
    let indexOffset = 0;
    worldModel.roads.forEach((road) => {
      const localPoints = road.geometry.points
        .map((point) => projectLatLonWithHeight(point.lat, point.lon))
        .filter((point): point is THREE.Vector3 => !!point);
      if (localPoints.length < 2) {
        return;
      }
      const simplified = simplifyProjectedPolyline(localPoints, 160, 2.5);
      if (simplified.length < 2) {
        return;
      }
      const laneCounts = resolveLaneCounts(road);
      const lanes = Math.max(1, laneCounts.total);
      const classFactor = clamp(demandWeightForClass(road.class), 0.75, 1.4);
      const width = Math.max(2.4, lanes * LANE_WIDTH_M * classFactor);
      for (let i = 0; i < simplified.length - 1; i += 1) {
        const start = simplified[i];
        const end = simplified[i + 1];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq < 0.0001) {
          continue;
        }
        const invLen = 1 / Math.sqrt(lengthSq);
        const nx = -dz * invLen;
        const nz = dx * invLen;
        const half = width / 2;
        const y0 = start.y + ROAD_HEIGHT_OFFSET;
        const y1 = end.y + ROAD_HEIGHT_OFFSET;

        const left0 = { x: start.x + nx * half, y: y0, z: start.z + nz * half };
        const right0 = { x: start.x - nx * half, y: y0, z: start.z - nz * half };
        const left1 = { x: end.x + nx * half, y: y1, z: end.z + nz * half };
        const right1 = { x: end.x - nx * half, y: y1, z: end.z - nz * half };

        vertices.push(
          left0.x,
          left0.y,
          left0.z,
          right0.x,
          right0.y,
          right0.z,
          left1.x,
          left1.y,
          left1.z,
          right1.x,
          right1.y,
          right1.z
        );
        indices.push(
          indexOffset,
          indexOffset + 1,
          indexOffset + 2,
          indexOffset + 1,
          indexOffset + 3,
          indexOffset + 2
        );
        indexOffset += 4;
      }
    });
    if (!vertices.length) {
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, materials.road);
    mesh.receiveShadow = false;
    roadGroup.add(mesh);
  };

  const buildBuildings = () => {
    disposeGroup(buildingGroup);
    const bounds = frameBounds;
    const meters = frameMeters;
    if (!worldModel || !bounds || !meters) {
      return;
    }
    worldModel.buildings.forEach((building) => {
      const footprint = building.footprint
        .map((point) => projectLatLon(bounds, meters, point.lat, point.lon))
        .filter((point): point is { x: number; z: number } => !!point);
      if (footprint.length < 3) {
        return;
      }
      const height = Math.max(BUILDING_MIN_HEIGHT_M, building.height.effectiveHeightMeters || 0);
      if (!Number.isFinite(height) || height <= 0) {
        return;
      }
      const shape = new THREE.Shape();
      shape.moveTo(footprint[0].x, -footprint[0].z);
      for (let i = 1; i < footprint.length; i += 1) {
        shape.lineTo(footprint[i].x, -footprint[i].z);
      }
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: height,
        bevelEnabled: false
      });
      geometry.rotateX(-Math.PI / 2);
      const centerLat =
        building.footprint.reduce((sum, point) => sum + point.lat, 0) / building.footprint.length;
      const centerLon =
        building.footprint.reduce((sum, point) => sum + point.lon, 0) / building.footprint.length;
      const baseY = sampleElevation(centerLat, centerLon) + STRUCTURE_BASE_OFFSET;
      geometry.translate(0, baseY, 0);
      const mesh = new THREE.Mesh(geometry, materials.building);
      buildingGroup.add(mesh);
    });
  };

  const buildStructure = () => {
    disposeGroup(structureGroup);
    const bounds = frameBounds;
    const meters = frameMeters;
    if (!worldModel?.structure || !bounds || !meters) {
      return;
    }
    const footprint = worldModel.structure.footprint
      .map((point) => projectLatLon(bounds, meters, point.lat, point.lon))
      .filter((point): point is { x: number; z: number } => !!point);
    if (footprint.length < 3) {
      return;
    }
    const height = Math.max(1, worldModel.structure.heightMeters);
    const shape = new THREE.Shape();
    shape.moveTo(footprint[0].x, -footprint[0].z);
    for (let i = 1; i < footprint.length; i += 1) {
      shape.lineTo(footprint[i].x, -footprint[i].z);
    }
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false
    });
    geometry.rotateX(-Math.PI / 2);
    const centerLat =
      worldModel.structure.footprint.reduce((sum, point) => sum + point.lat, 0) /
      worldModel.structure.footprint.length;
    const centerLon =
      worldModel.structure.footprint.reduce((sum, point) => sum + point.lon, 0) /
      worldModel.structure.footprint.length;
    const baseY = sampleElevation(centerLat, centerLon) + STRUCTURE_BASE_OFFSET;
    geometry.translate(0, baseY, 0);
    const mesh = new THREE.Mesh(geometry, materials.structure);
    structureGroup.add(mesh);
  };

  const buildTrees = () => {
    disposeGroup(treeGroup);
    if (!worldModel || !frameBounds || !frameMeters) {
      return;
    }
    const pineTrees = worldModel.trees.filter((tree) => tree.type === "pine");
    const deciduousTrees = worldModel.trees.filter((tree) => tree.type === "deciduous");

    if (pineTrees.length) {
      const geometry = new THREE.ConeGeometry(1, 1, 8);
      const mesh = new THREE.InstancedMesh(geometry, materials.tree, pineTrees.length);
      const matrix = new THREE.Matrix4();
      pineTrees.forEach((tree, index) => {
        const position = projectLatLonWithHeight(tree.location.lat, tree.location.lon);
        if (!position) {
          return;
        }
        const height = Math.max(1, tree.heightMeters);
        const radius = Math.max(0.3, tree.baseRadiusMeters);
        const y = position.y + height / 2 + TREE_BASE_OFFSET;
        matrix.compose(
          new THREE.Vector3(position.x, y, position.z),
          new THREE.Quaternion(),
          new THREE.Vector3(radius, height, radius)
        );
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      treeGroup.add(mesh);
    }

    if (deciduousTrees.length) {
      const trunkGeometry = new THREE.CylinderGeometry(0.5, 0.6, 1, 6);
      const canopyGeometry = new THREE.SphereGeometry(0.8, 8, 8);
      const trunkMesh = new THREE.InstancedMesh(
        trunkGeometry,
        materials.treeTrunk,
        deciduousTrees.length
      );
      const canopyMesh = new THREE.InstancedMesh(
        canopyGeometry,
        materials.tree,
        deciduousTrees.length
      );
      const matrix = new THREE.Matrix4();
      deciduousTrees.forEach((tree, index) => {
        const position = projectLatLonWithHeight(tree.location.lat, tree.location.lon);
        if (!position) {
          return;
        }
        const height = Math.max(1, tree.heightMeters);
        const radius = Math.max(0.4, tree.baseRadiusMeters);
        const trunkHeight = height * 0.45;
        const canopyRadius = radius * 1.4;
        const trunkY = position.y + trunkHeight / 2 + TREE_BASE_OFFSET;
        matrix.compose(
          new THREE.Vector3(position.x, trunkY, position.z),
          new THREE.Quaternion(),
          new THREE.Vector3(radius * 0.35, trunkHeight, radius * 0.35)
        );
        trunkMesh.setMatrixAt(index, matrix);
        const canopyY = position.y + trunkHeight + canopyRadius * 0.8 + TREE_BASE_OFFSET;
        matrix.compose(
          new THREE.Vector3(position.x, canopyY, position.z),
          new THREE.Quaternion(),
          new THREE.Vector3(canopyRadius, canopyRadius, canopyRadius)
        );
        canopyMesh.setMatrixAt(index, matrix);
      });
      trunkMesh.instanceMatrix.needsUpdate = true;
      canopyMesh.instanceMatrix.needsUpdate = true;
      treeGroup.add(trunkMesh);
      treeGroup.add(canopyMesh);
    }
  };

  const buildSigns = () => {
    disposeGroup(signGroup);
    if (!worldModel || !frameBounds || !frameMeters) {
      return;
    }
    worldModel.signs.forEach((sign) => {
      const position = projectLatLonWithHeight(sign.location.lat, sign.location.lon);
      if (!position) {
        return;
      }
      const width = Math.max(0.5, sign.widthMeters);
      const height = Math.max(0.5, sign.heightMeters);
      const geometry = new THREE.PlaneGeometry(width, height);
      const mesh = new THREE.Mesh(geometry, materials.sign);
      const yaw = (sign.yawDegrees * Math.PI) / 180;
      mesh.rotation.y = yaw;
      const baseY = position.y + sign.bottomClearanceMeters + height / 2 + SIGN_BASE_OFFSET;
      mesh.position.set(position.x, baseY, position.z);
      signGroup.add(mesh);
    });
  };

  const rebuildWorld = () => {
    if (!scene) {
      return;
    }
    buildRoads();
    buildBuildings();
    buildStructure();
    buildTrees();
    buildSigns();
    requestRender();
  };

  const updateTraffic = (delta: number) => {
    const mesh = trafficMesh;
    if (!mesh || !trafficVehicles.length || !trafficPaths.length) {
      return;
    }
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    trafficVehicles.forEach((vehicle, index) => {
      const path = trafficPaths[vehicle.pathIndex];
      const progress =
        (vehicle.offset + (delta * vehicle.speedMps) / Math.max(1, path.lengthM)) % 1;
      vehicle.offset = progress;
      const x = lerp(path.from.x, path.to.x, progress);
      const z = lerp(path.from.z, path.to.z, progress);
      const y = lerp(path.from.y, path.to.y, progress) + TRAFFIC_BASE_OFFSET;
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), path.yaw);
      matrix.compose(new THREE.Vector3(x, y, z), rotation, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };

  const buildTraffic = () => {
    disposeTraffic();
    if (!trafficData?.edgeTraffic || !frameBounds || !frameMeters) {
      return;
    }
    const edgeTraffic = trafficData.edgeTraffic;
    if (!edgeTraffic || edgeTraffic.length === 0) {
      return;
    }
    const maxFlow = edgeTraffic.reduce((max, edge) => Math.max(max, edge.flow || 0), 0);
    if (maxFlow <= 0) {
      return;
    }
    const densityFactor = densityFactorByFlow[trafficData.flowDensity ?? "medium"];
    const edgeCounts = edgeTraffic.map((edge) => {
      if (edge.flow <= 0) {
        return 0;
      }
      const lengthFactor = clamp(edge.lengthM / 60, 0.6, 6);
      const normalized = edge.flow / maxFlow;
      return normalized * lengthFactor * densityFactor;
    });
    let counts = edgeCounts.map((value, index) =>
      edgeTraffic[index].flow > 0 ? Math.max(1, Math.round(value)) : 0
    );
    let total = counts.reduce((sum, value) => sum + value, 0);
    if (total > MAX_VEHICLES) {
      const scale = MAX_VEHICLES / total;
      counts = counts.map((value, index) =>
        edgeTraffic[index].flow > 0 ? Math.max(1, Math.round(value * scale)) : 0
      );
      total = counts.reduce((sum, value) => sum + value, 0);
    }
    if (total <= 0) {
      return;
    }

    const coneGeometry = new THREE.ConeGeometry(0.6, 2.2, 6);
    coneGeometry.rotateX(-Math.PI / 2);
    trafficMesh = new THREE.InstancedMesh(coneGeometry, materials.traffic, total);
    trafficMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    trafficGroup.add(trafficMesh);

    const vehicles: TrafficVehicle[] = [];
    const paths: TrafficPath[] = [];
    edgeTraffic.forEach((edge, edgeIndex) => {
      const count = counts[edgeIndex];
      if (count <= 0) {
        return;
      }
      const from = projectLatLonWithHeight(edge.from.lat, edge.from.lon);
      const to = projectLatLonWithHeight(edge.to.lat, edge.to.lon);
      if (!from || !to) {
        return;
      }
      const dir = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
      const length = Math.max(1, dir.length());
      dir.normalize();
      const yaw = Math.atan2(dir.x, dir.z);
      const speed = Number.isFinite(edge.speedMps) ? (edge.speedMps as number) : 12;
      const pathIndex = paths.length;
      paths.push({
        from,
        to,
        dir,
        lengthM: Number.isFinite(edge.lengthM) ? edge.lengthM : length,
        yaw,
        speedMps: speed
      });
      for (let i = 0; i < count; i += 1) {
        vehicles.push({
          pathIndex,
          offset: Math.random(),
          speedMps: speed
        });
      }
    });
    trafficPaths = paths;
    trafficVehicles = vehicles;
  };

  const requestRender = () => {
    if (animationFrame !== null) {
      return;
    }
    if (currentMode === "idle") {
      renderFrame(0);
    } else {
      startLoop();
    }
  };

  const renderFrame = (delta: number) => {
    if (!scene || !camera || !controls || !renderer) {
      return;
    }
    if (cameraTween) {
      const now = performance.now();
      const elapsed = now - cameraTween.startTime;
      const t = clamp(elapsed / cameraTween.duration, 0, 1);
      camera.position.lerpVectors(cameraTween.start, cameraTween.end, t);
      if (t >= 1) {
        cameraTween = null;
      }
    }
    updateTraffic(delta);
    controls.update();
    renderer.render(scene, camera);
  };

  const tick = (time: number) => {
    if (animationFrame === null) {
      return;
    }
    const delta = Math.min(0.05, (time - lastTime) / 1000);
    lastTime = time;
    renderFrame(delta);
    if (currentMode !== "idle") {
      animationFrame = requestAnimationFrame(tick);
    } else {
      animationFrame = null;
    }
  };

  const startLoop = () => {
    if (animationFrame !== null) {
      return;
    }
    lastTime = performance.now();
    animationFrame = requestAnimationFrame(tick);
  };

  const stopLoop = () => {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  };

  return {
    init(containerEl) {
      if (renderer) {
        return true;
      }
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch (err) {
        console.error(err);
        return false;
      }
      container = containerEl;
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(containerEl.clientWidth || 1, containerEl.clientHeight || 1);
      containerEl.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0f141a);
      camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.autoRotateSpeed = 0.6;
      controls.maxPolarAngle = Math.PI / 2.02;
      controls.target.set(0, 0, 0);
      controls.update();
      if (frameBounds) {
        updateCameraBounds();
      }

      const ambient = new THREE.AmbientLight(0xffffff, 0.55);
      const sun = new THREE.DirectionalLight(0xffffff, 0.75);
      sun.position.set(1, 1.2, 0.6);
      const hemi = new THREE.HemisphereLight(0x8fb7ff, 0x20242b, 0.35);
      scene.add(ambient, sun, hemi);

      rootGroup.add(terrainGroup, roadGroup, buildingGroup, treeGroup, signGroup, structureGroup, trafficGroup);
      scene.add(rootGroup);

      resizeObserver = new ResizeObserver(() => {
        if (!renderer || !camera || !container) {
          return;
        }
        const width = Math.max(1, container.clientWidth);
        const height = Math.max(1, container.clientHeight);
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        requestRender();
      });
      resizeObserver.observe(containerEl);
      requestRender();
      return true;
    },
    setWorldModel(nextWorldModel) {
      worldModel = nextWorldModel;
      ensureFrameMetrics(nextWorldModel?.frame?.bounds ?? frameBounds);
      rebuildWorld();
      buildTraffic();
    },
    setTerrain(elevationGrid, geoProjector) {
      if (!elevationGrid || !geoProjector) {
        if (geoProjector) {
          ensureFrameMetrics(geoProjector.bounds);
        }
        terrainState = null;
        buildTerrain();
        rebuildWorld();
        buildTraffic();
        return;
      }
      const bounds = geoProjector.bounds;
      ensureFrameMetrics(bounds);
      let min = Infinity;
      let max = -Infinity;
      for (const row of elevationGrid.values) {
        for (const value of row) {
          if (!Number.isFinite(value)) {
            continue;
          }
          min = Math.min(min, value as number);
          max = Math.max(max, value as number);
        }
      }
      if (!Number.isFinite(min)) {
        min = 0;
      }
      if (!Number.isFinite(max)) {
        max = min;
      }
      terrainState = { grid: elevationGrid, bounds, min, max };
      buildTerrain();
      rebuildWorld();
      buildTraffic();
    },
    setTraffic(flowData) {
      trafficData = flowData;
      buildTraffic();
      requestRender();
    },
    setMode(mode) {
      const prevMode = currentMode;
      if (prevMode === mode) {
        return;
      }
      currentMode = mode;
      if (!controls) {
        return;
      }
      const interactive = mode === "interactive";
      controls.enableRotate = interactive;
      controls.enablePan = interactive;
      controls.enableZoom = interactive;
      controls.autoRotate = mode === "computing";
      if (mode === "idle") {
        stopLoop();
        if (cameraTargets) {
          moveCameraInstant(cameraTargets.overhead);
        }
        requestRender();
        return;
      }
      if (mode === "computing" && cameraTargets) {
        moveCameraSmooth(cameraTargets.orbit);
      }
      if (mode === "interactive" && prevMode === "idle" && cameraTargets) {
        moveCameraSmooth(cameraTargets.orbit, 450);
      }
      startLoop();
    },
    dispose() {
      stopLoop();
      disposeGroup(terrainGroup);
      disposeGroup(roadGroup);
      disposeGroup(buildingGroup);
    disposeGroup(treeGroup);
    disposeGroup(signGroup);
    disposeGroup(structureGroup);
    disposeTraffic();
    Object.values(materials).forEach((material) => material.dispose());
      resizeObserver?.disconnect();
      resizeObserver = null;
      controls?.dispose();
      controls = null;
      renderer?.dispose();
      if (renderer && renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
      renderer = null;
      scene = null;
      camera = null;
      container = null;
    }
  };
}
