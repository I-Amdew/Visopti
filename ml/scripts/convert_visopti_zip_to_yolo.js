import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { strFromU8, unzipSync } from "fflate";

const SIGN_BOX_SIZE_FRACTION = 0.06;

const CLASS_ID = new Map([
  ["tree_deciduous", 0],
  ["tree_pine", 1],
  ["billboard", 2],
  ["stop_sign", 3]
]);

const [zipPath, outDir] = process.argv.slice(2);

if (!zipPath || !outDir) {
  console.error(
    "Usage: node ml/scripts/convert_visopti_zip_to_yolo.js <zipPath> <outDir>"
  );
  process.exit(1);
}

const zipBuffer = fs.readFileSync(zipPath);
const entries = unzipSync(new Uint8Array(zipBuffer));
const datasetEntry = findEntry(entries, "dataset.json");

if (!datasetEntry) {
  throw new Error("dataset.json not found in training bundle zip.");
}

const dataset = JSON.parse(strFromU8(datasetEntry));
if (!dataset || typeof dataset !== "object" || !Array.isArray(dataset.samples)) {
  throw new Error("dataset.json is missing a samples array.");
}

const imagesDir = path.join(outDir, "images", "train");
const labelsDir = path.join(outDir, "labels", "train");
fs.mkdirSync(imagesDir, { recursive: true });
fs.mkdirSync(labelsDir, { recursive: true });

let annotationCount = 0;
let skippedAnnotations = 0;

for (const sample of dataset.samples) {
  if (!sample || typeof sample !== "object") {
    continue;
  }
  const imagePath = sample.imagePath;
  if (typeof imagePath !== "string") {
    throw new Error("Sample is missing imagePath.");
  }

  const imageEntry = findEntry(entries, imagePath);
  if (!imageEntry) {
    throw new Error(`Image entry not found in zip: ${imagePath}`);
  }

  const imageName = path.basename(imagePath);
  const imageOutPath = path.join(imagesDir, imageName);
  fs.writeFileSync(imageOutPath, Buffer.from(imageEntry));

  const labelName = `${path.parse(imageName).name}.txt`;
  const labelOutPath = path.join(labelsDir, labelName);
  const annotations = Array.isArray(sample.annotations) ? sample.annotations : [];
  const labelLines = [];

  for (const annotation of annotations) {
    const line = annotationToLine(sample, annotation);
    if (line) {
      labelLines.push(line);
      annotationCount += 1;
    } else {
      skippedAnnotations += 1;
    }
  }

  const labelText = labelLines.length ? `${labelLines.join("\n")}\n` : "";
  fs.writeFileSync(labelOutPath, labelText);
}

console.log(
  `Converted ${dataset.samples.length} samples to YOLO format in ${outDir}.`
);
console.log(`Wrote ${annotationCount} annotations.`);
if (skippedAnnotations > 0) {
  console.warn(`Skipped ${skippedAnnotations} annotations with unknown format.`);
}

function findEntry(entries, targetPath) {
  if (entries[targetPath]) {
    return entries[targetPath];
  }
  const normalizedTarget = targetPath.replace(/^\.\//, "");
  for (const [entryPath, entry] of Object.entries(entries)) {
    const normalizedEntry = entryPath.replace(/^\.\//, "");
    if (normalizedEntry === normalizedTarget || normalizedEntry.endsWith(`/${normalizedTarget}`)) {
      return entry;
    }
  }
  return null;
}

function annotationToLine(sample, annotation) {
  if (!annotation || typeof annotation !== "object") {
    return null;
  }
  const className = annotation.class;
  if (typeof className !== "string") {
    return null;
  }
  const classId = CLASS_ID.get(className);
  if (classId === undefined) {
    return null;
  }

  const sizePx = Number(sample.sizePx);
  const center = annotation.centerPx;
  if (!Number.isFinite(sizePx) || sizePx <= 0) {
    return null;
  }
  if (!center || typeof center !== "object") {
    return null;
  }
  const cx = Number(center.x);
  const cy = Number(center.y);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    return null;
  }

  let boxWidthPx = 0;
  let boxHeightPx = 0;
  if (annotation.kind === "tree") {
    const radiusPx = Number(annotation.radiusPx);
    if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
      return null;
    }
    boxWidthPx = radiusPx * 2;
    boxHeightPx = radiusPx * 2;
  } else if (annotation.kind === "sign") {
    const signBoxPx = sizePx * SIGN_BOX_SIZE_FRACTION;
    if (!Number.isFinite(signBoxPx) || signBoxPx <= 0) {
      return null;
    }
    boxWidthPx = signBoxPx;
    boxHeightPx = signBoxPx;
  } else {
    return null;
  }

  const x = clamp(cx / sizePx, 0, 1);
  const y = clamp(cy / sizePx, 0, 1);
  const w = clamp(boxWidthPx / sizePx, 0, 1);
  const h = clamp(boxHeightPx / sizePx, 0, 1);

  if (w <= 0 || h <= 0) {
    return null;
  }

  return `${classId} ${x.toFixed(6)} ${y.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
