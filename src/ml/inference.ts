import type { GeoProjector } from "../types";
import type { LabelObject } from "./labels";

export type MlRuntime = "onnx" | "tfjs";

export interface Predictions {
  objects: Array<LabelObject & { confidence?: number }>;
}

export interface DetectorConfig {
  runtime: MlRuntime;
  modelUrl: string;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  runtime: "onnx",
  modelUrl: "/models/tree-sign.onnx"
};

export interface TreeSignDetector {
  detect(
    image: HTMLCanvasElement | HTMLImageElement | ImageData,
    geoProjector: GeoProjector
  ): Promise<Predictions>;
}

export class EmptyTreeSignDetector implements TreeSignDetector {
  readonly config: DetectorConfig;

  constructor(config: DetectorConfig) {
    this.config = config;
  }

  async detect(): Promise<Predictions> {
    return { objects: [] };
  }
}

export function createTreeSignDetector(
  config: Partial<DetectorConfig> = {}
): TreeSignDetector {
  return new EmptyTreeSignDetector({ ...DEFAULT_DETECTOR_CONFIG, ...config });
}
