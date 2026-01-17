import { promises as fs } from "fs";
import { resolve } from "path";
import { defineConfig, type ViteDevServer } from "vite";

const includeTrainer = process.env.VITE_INCLUDE_TRAINER === "1";
const enableTrainerSync = true;

const DATASET_ROOT = resolve(__dirname, "ml/datasets/active");
const MANIFEST_PATH = resolve(DATASET_ROOT, "manifest.json");
const DATASET_PATH = resolve(DATASET_ROOT, "dataset.json");
const IMAGES_DIR = resolve(DATASET_ROOT, "images");
const LABELS_DIR = resolve(DATASET_ROOT, "labels");

export default defineConfig({
  root: ".",
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        ...(includeTrainer ? { trainer: resolve(__dirname, "trainer.html") } : {})
      }
    }
  },
  server: {
    port: 5173,
    open: true,
    strictPort: false,
    hmr: {
      host: "localhost",
      protocol: "ws"
    },
    configureServer(server: ViteDevServer) {
      if (!enableTrainerSync) {
        return;
      }
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__trainer/sync/")) {
          next();
          return;
        }

        if (!isTrainerSyncAuthorized(req)) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Trainer sync not authorized." }));
          return;
        }

        try {
          if (req.method === "GET" && req.url.startsWith("/__trainer/sync/status")) {
            const manifest = await readJsonFile(MANIFEST_PATH);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(manifest ?? {}));
            return;
          }

          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end();
            return;
          }

          if (req.url.startsWith("/__trainer/sync/manifest")) {
            const payload = await readJsonBody(req);
            await ensureDir(DATASET_ROOT);
            await fs.writeFile(MANIFEST_PATH, JSON.stringify(payload ?? {}, null, 2));
            res.statusCode = 200;
            res.end();
            return;
          }

          if (req.url.startsWith("/__trainer/sync/dataset")) {
            const payload = await readJsonBody(req);
            const safeDataset = buildSafeDataset(payload);
            await ensureDir(DATASET_ROOT);
            await fs.writeFile(DATASET_PATH, JSON.stringify(safeDataset, null, 2));
            res.statusCode = 200;
            res.end();
            return;
          }

          if (req.url.startsWith("/__trainer/sync/sample")) {
            const payload = await readJsonBody(req);
            const sampleId = typeof payload?.sampleId === "string" ? payload.sampleId.trim() : "";
            if (!sampleId || typeof payload?.pngBase64 !== "string") {
              res.statusCode = 400;
              res.end();
              return;
            }
            const pngBuffer = Buffer.from(payload.pngBase64, "base64");
            await ensureDir(IMAGES_DIR);
            await ensureDir(LABELS_DIR);
            await fs.writeFile(resolve(IMAGES_DIR, `${sampleId}.png`), pngBuffer);
            await fs.writeFile(
              resolve(LABELS_DIR, `${sampleId}.json`),
              JSON.stringify(payload.labelJson ?? {}, null, 2)
            );
            res.statusCode = 200;
            res.end();
            return;
          }

          res.statusCode = 404;
          res.end();
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
    }
  }
});

function isTrainerSyncAuthorized(req: { headers?: Record<string, string | string[] | undefined> }): boolean {
  const headers = req.headers ?? {};
  const trainerHeader = headers["x-visopti-trainer"];
  const tokenHeader = headers["x-visopti-trainer-token"];
  const hasTrainerHeader = Array.isArray(trainerHeader)
    ? trainerHeader.includes("1")
    : trainerHeader === "1";
  const hasTokenHeader = Array.isArray(tokenHeader)
    ? tokenHeader.includes("1")
    : tokenHeader === "1";
  const referer = Array.isArray(headers.referer) ? headers.referer[0] : headers.referer;
  const hasTrainerReferrer = hasTrainerQueryParam(referer);
  return hasTrainerHeader && (hasTokenHeader || hasTrainerReferrer);
}

function hasTrainerQueryParam(referer: string | undefined): boolean {
  if (!referer) {
    return false;
  }
  try {
    const url = new URL(referer);
    return url.searchParams.get("trainer") === "1";
  } catch {
    return false;
  }
}

async function readJsonBody(req: { on: (event: string, cb: (chunk?: Buffer) => void) => void }) {
  const body = await readBody(req);
  if (!body) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function readBody(req: { on: (event: string, cb: (chunk?: Buffer) => void) => void }) {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", () => resolve(""));
  });
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

function buildSafeDataset(payload: any) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const safe: Record<string, unknown> = {};
  if (typeof payload.version === "number") {
    safe.version = payload.version;
  }
  if (payload.imagery && typeof payload.imagery === "object") {
    const imagery: Record<string, unknown> = {};
    if (typeof payload.imagery.providerId === "string") {
      imagery.providerId = payload.imagery.providerId;
    }
    if (typeof payload.imagery.zoom === "number") {
      imagery.zoom = payload.imagery.zoom;
    }
    safe.imagery = imagery;
  }
  if (payload.trainingConfig && typeof payload.trainingConfig === "object") {
    safe.trainingConfig = payload.trainingConfig;
  }
  if (Array.isArray(payload.samples)) {
    safe.samples = payload.samples;
  }
  if (payload.reviews && typeof payload.reviews === "object") {
    safe.reviews = payload.reviews;
  }
  if (payload.metadata && typeof payload.metadata === "object") {
    safe.metadata = payload.metadata;
  }
  return safe;
}
