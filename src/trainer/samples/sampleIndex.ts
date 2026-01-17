export type SampleClass =
  | "tree_pine"
  | "tree_deciduous"
  | "dense_cover"
  | "billboard"
  | "stop_sign"
  | "negative";

export type SampleAnnotation =
  | {
      kind: "circle";
      centerPx: { x: number; y: number };
      radiusPx: number;
    }
  | {
      kind: "bbox";
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      kind: "poly";
      points: Array<{ x: number; y: number }>;
    };

export interface SampleRecord {
  id: string;
  class: SampleClass;
  annotations: SampleAnnotation[];
  sourceKey?: string;
  createdAt: number;
  updatedAt: number;
}
