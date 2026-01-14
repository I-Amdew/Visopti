#!/usr/bin/env node
/* eslint-disable no-console */

const DEFAULT_API = "https://api.open-meteo.com/v1/elevation";
const DEFAULT_LAT = 47.6062;
const DEFAULT_LON = -122.3321;

function readEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function buildPoints(baseLat, baseLon, count, spacingDeg) {
  if (count <= 1) {
    return [{ lat: baseLat, lon: baseLon }];
  }
  const points = [];
  const grid = Math.ceil(Math.sqrt(count));
  const half = (grid - 1) / 2;
  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < grid; col += 1) {
      if (points.length >= count) {
        return points;
      }
      points.push({
        lat: baseLat + (row - half) * spacingDeg,
        lon: baseLon + (col - half) * spacingDeg
      });
    }
  }
  return points;
}

function extractRateLimitHeaders(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower.includes("rate") || lower.includes("limit") || lower.includes("retry-after")) {
      result[key] = value;
    }
  }
  return Object.keys(result).length ? result : null;
}

async function fetchWithTimeout(url, timeoutMs) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch unavailable. Use Node 18+ or polyfill fetch.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function buildElevationUrl(baseUrl, points, apiKey) {
  const url = new URL(baseUrl);
  url.searchParams.set(
    "latitude",
    points.map((point) => point.lat.toFixed(6)).join(",")
  );
  url.searchParams.set(
    "longitude",
    points.map((point) => point.lon.toFixed(6)).join(",")
  );
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
  }
  return url.toString();
}

async function runRampTest(mode, config, points) {
  const latencies = [];
  let requestCount = 0;
  let lastGoodQps = null;
  let rateLimitedAt = null;

  for (let qps = config.rampStartQps; qps <= config.rampMaxQps; qps += config.rampStepQps) {
    const intervalMs = Math.max(1, Math.round(1000 / qps));
    for (let i = 0; i < config.requestsPerStep; i += 1) {
      requestCount += 1;
      const scheduled = Date.now() + i * intervalMs;
      const delay = scheduled - Date.now();
      if (delay > 0) {
        await sleep(delay);
      }
      const url = buildElevationUrl(config.apiBase, points, config.apiKey);
      const start = Date.now();
      let status = 0;
      let headers = null;
      try {
        const { response } = await fetchWithTimeout(url, config.requestTimeoutMs);
        status = response.status;
        headers = extractRateLimitHeaders(response.headers);
      } catch (error) {
        status = error?.name === "AbortError" ? 408 : 0;
      }
      const latencyMs = Date.now() - start;
      if (status >= 200 && status < 500 && status !== 429) {
        latencies.push(latencyMs);
      }
      console.log(
        JSON.stringify({
          ts: nowIso(),
          mode,
          qps,
          request: requestCount,
          status,
          latencyMs,
          rateLimit: headers
        })
      );
      if (status === 429) {
        rateLimitedAt = qps;
        return { latencies, requestCount, lastGoodQps, rateLimitedAt };
      }
    }
    lastGoodQps = qps;
  }

  return { latencies, requestCount, lastGoodQps, rateLimitedAt };
}

async function runBurstTest(mode, config, points) {
  let lastGoodBurst = null;
  for (let size = config.burstStart; size <= config.burstMax; size += config.burstStep) {
    let rateLimited = false;
    let completed = 0;
    while (completed < size && !rateLimited) {
      const batch = Math.min(config.burstConcurrency, size - completed);
      const url = buildElevationUrl(config.apiBase, points, config.apiKey);
      const startBatch = Date.now();
      const results = await Promise.all(
        Array.from({ length: batch }, async () => {
          try {
            const { response } = await fetchWithTimeout(url, config.requestTimeoutMs);
            return {
              status: response.status,
              headers: extractRateLimitHeaders(response.headers),
              latencyMs: Date.now() - startBatch
            };
          } catch (error) {
            return {
              status: error?.name === "AbortError" ? 408 : 0,
              headers: null,
              latencyMs: Date.now() - startBatch
            };
          }
        })
      );
      for (const result of results) {
        completed += 1;
        console.log(
          JSON.stringify({
            ts: nowIso(),
            mode: `${mode}-burst`,
            burstSize: size,
            request: completed,
            status: result.status,
            latencyMs: result.latencyMs,
            rateLimit: result.headers
          })
        );
        if (result.status === 429) {
          rateLimited = true;
          break;
        }
      }
    }
    if (rateLimited) {
      return { lastGoodBurst, rateLimitedAt: size };
    }
    lastGoodBurst = size;
  }
  return { lastGoodBurst, rateLimitedAt: null };
}

async function main() {
  const config = {
    apiBase: process.env.ELEVATION_API?.trim() || DEFAULT_API,
    apiKey: process.env.ELEVATION_API_KEY?.trim() || "",
    baseLat: readEnvNumber("ELEVATION_TEST_LAT", DEFAULT_LAT),
    baseLon: readEnvNumber("ELEVATION_TEST_LON", DEFAULT_LON),
    pointSpacingDeg: readEnvNumber("ELEVATION_TEST_SPACING_DEG", 0.001),
    batchSize: readEnvInt("ELEVATION_TEST_BATCH_SIZE", 100),
    rampStartQps: readEnvNumber("ELEVATION_TEST_RAMP_START_QPS", 1),
    rampStepQps: readEnvNumber("ELEVATION_TEST_RAMP_STEP_QPS", 1),
    rampMaxQps: readEnvNumber("ELEVATION_TEST_RAMP_MAX_QPS", 12),
    requestsPerStep: readEnvInt("ELEVATION_TEST_REQUESTS_PER_STEP", 10),
    burstStart: readEnvInt("ELEVATION_TEST_BURST_START", 10),
    burstStep: readEnvInt("ELEVATION_TEST_BURST_STEP", 10),
    burstMax: readEnvInt("ELEVATION_TEST_BURST_MAX", 60),
    burstConcurrency: readEnvInt("ELEVATION_TEST_BURST_CONCURRENCY", 4),
    requestTimeoutMs: readEnvInt("ELEVATION_TEST_TIMEOUT_MS", 10000)
  };

  console.log(
    JSON.stringify({
      ts: nowIso(),
      event: "config",
      apiBase: config.apiBase,
      batchSize: config.batchSize,
      ramp: {
        startQps: config.rampStartQps,
        stepQps: config.rampStepQps,
        maxQps: config.rampMaxQps,
        requestsPerStep: config.requestsPerStep
      },
      burst: {
        start: config.burstStart,
        step: config.burstStep,
        max: config.burstMax,
        concurrency: config.burstConcurrency
      }
    })
  );

  const singlePoints = buildPoints(config.baseLat, config.baseLon, 1, config.pointSpacingDeg);
  const batchPoints = buildPoints(
    config.baseLat,
    config.baseLon,
    config.batchSize,
    config.pointSpacingDeg
  );

  console.log(JSON.stringify({ ts: nowIso(), event: "ramp-start", mode: "single" }));
  const singleRamp = await runRampTest("single", config, singlePoints);
  const singleMedian = median(singleRamp.latencies);
  console.log(
    JSON.stringify({
      ts: nowIso(),
      event: "ramp-summary",
      mode: "single",
      lastGoodQps: singleRamp.lastGoodQps,
      rateLimitedAt: singleRamp.rateLimitedAt,
      medianLatencyMs: singleMedian
    })
  );

  console.log(JSON.stringify({ ts: nowIso(), event: "ramp-start", mode: "batch" }));
  const batchRamp = await runRampTest("batch", config, batchPoints);
  const batchMedian = median(batchRamp.latencies);
  console.log(
    JSON.stringify({
      ts: nowIso(),
      event: "ramp-summary",
      mode: "batch",
      lastGoodQps: batchRamp.lastGoodQps,
      rateLimitedAt: batchRamp.rateLimitedAt,
      medianLatencyMs: batchMedian
    })
  );

  console.log(JSON.stringify({ ts: nowIso(), event: "burst-start", mode: "single" }));
  const singleBurst = await runBurstTest("single", config, singlePoints);
  console.log(
    JSON.stringify({
      ts: nowIso(),
      event: "burst-summary",
      mode: "single",
      lastGoodBurst: singleBurst.lastGoodBurst,
      rateLimitedAt: singleBurst.rateLimitedAt
    })
  );

  console.log(JSON.stringify({ ts: nowIso(), event: "burst-start", mode: "batch" }));
  const batchBurst = await runBurstTest("batch", config, batchPoints);
  console.log(
    JSON.stringify({
      ts: nowIso(),
      event: "burst-summary",
      mode: "batch",
      lastGoodBurst: batchBurst.lastGoodBurst,
      rateLimitedAt: batchBurst.rateLimitedAt
    })
  );

  const safeQpsSingle = singleRamp.lastGoodQps ?? 0;
  const safeQpsBatch = batchRamp.lastGoodQps ?? 0;
  const safeBurstSingle = singleBurst.lastGoodBurst ?? 0;
  const safeBurstBatch = batchBurst.lastGoodBurst ?? 0;

  console.log(
    JSON.stringify({
      ts: nowIso(),
      event: "summary",
      safeQpsEstimate: { single: safeQpsSingle, batch: safeQpsBatch },
      maxBurstEstimate: { single: safeBurstSingle, batch: safeBurstBatch }
    })
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ ts: nowIso(), event: "fatal", message: error.message }));
  process.exit(1);
});
