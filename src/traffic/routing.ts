import { Graph, GraphEdge } from "./graph";

export interface Path {
  edges: GraphEdge[];
  totalWeight: number;
}

export interface TopKOptions {
  penaltyFactor?: number;
  maxAttempts?: number;
}

export function shortestPath(
  graph: Graph,
  startId: string,
  endId: string,
  weightFn?: (edge: GraphEdge) => number
): Path | null {
  if (!graph.nodes.has(startId) || !graph.nodes.has(endId)) {
    return null;
  }
  const distances = new Map<string, number>();
  const prevEdge = new Map<string, GraphEdge>();
  const heap = new MinHeap();
  distances.set(startId, 0);
  heap.push({ nodeId: startId, dist: 0 });

  while (!heap.isEmpty()) {
    const current = heap.pop();
    if (!current) {
      break;
    }
    const bestDist = distances.get(current.nodeId);
    if (bestDist === undefined || current.dist > bestDist) {
      continue;
    }
    if (current.nodeId === endId) {
      break;
    }
    const neighbors = graph.adjacency.get(current.nodeId);
    if (!neighbors) {
      continue;
    }
    for (const edge of neighbors) {
      const weight = weightFn ? weightFn(edge) : edge.weight;
      if (!Number.isFinite(weight)) {
        continue;
      }
      const nextDist = current.dist + weight;
      const prevDist = distances.get(edge.to);
      if (prevDist === undefined || nextDist < prevDist) {
        distances.set(edge.to, nextDist);
        prevEdge.set(edge.to, edge);
        heap.push({ nodeId: edge.to, dist: nextDist });
      }
    }
  }

  const totalWeight = distances.get(endId);
  if (totalWeight === undefined) {
    return null;
  }
  const edges: GraphEdge[] = [];
  let current = endId;
  while (current !== startId) {
    const edge = prevEdge.get(current);
    if (!edge) {
      return null;
    }
    edges.push(edge);
    current = edge.from;
  }
  edges.reverse();
  return { edges, totalWeight };
}

export function findTopKPaths(
  graph: Graph,
  startId: string,
  endId: string,
  k: number,
  options: TopKOptions = {}
): Path[] {
  if (k <= 0) {
    return [];
  }
  const penaltyFactor = options.penaltyFactor ?? 0.35;
  const maxAttempts = options.maxAttempts ?? Math.max(k * 4, k + 2);
  const penalty = new Map<string, number>();
  const signatures = new Set<string>();
  const paths: Path[] = [];

  for (let attempt = 0; attempt < maxAttempts && paths.length < k; attempt += 1) {
    const path = shortestPath(graph, startId, endId, (edge) => {
      const p = penalty.get(edge.id) ?? 0;
      return edge.weight * (1 + penaltyFactor * p);
    });
    if (!path) {
      break;
    }
    const signature = path.edges.map((edge) => edge.id).join("|");
    if (signatures.has(signature)) {
      for (const edge of path.edges) {
        penalty.set(edge.id, (penalty.get(edge.id) ?? 0) + 0.5);
      }
      continue;
    }
    signatures.add(signature);
    paths.push(path);
    for (const edge of path.edges) {
      penalty.set(edge.id, (penalty.get(edge.id) ?? 0) + 1);
    }
  }

  return paths;
}

interface HeapItem {
  nodeId: string;
  dist: number;
}

class MinHeap {
  private data: HeapItem[] = [];

  isEmpty(): boolean {
    return this.data.length === 0;
  }

  push(item: HeapItem): void {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapItem | null {
    if (this.data.length === 0) {
      return null;
    }
    const root = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0 && last) {
      this.data[0] = last;
      this.bubbleDown(0);
    }
    return root;
  }

  private bubbleUp(index: number): void {
    let idx = index;
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this.data[parent].dist <= this.data[idx].dist) {
        break;
      }
      [this.data[parent], this.data[idx]] = [this.data[idx], this.data[parent]];
      idx = parent;
    }
  }

  private bubbleDown(index: number): void {
    let idx = index;
    const length = this.data.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = idx * 2 + 2;
      let smallest = idx;
      if (left < length && this.data[left].dist < this.data[smallest].dist) {
        smallest = left;
      }
      if (right < length && this.data[right].dist < this.data[smallest].dist) {
        smallest = right;
      }
      if (smallest === idx) {
        break;
      }
      [this.data[smallest], this.data[idx]] = [this.data[idx], this.data[smallest]];
      idx = smallest;
    }
  }
}
