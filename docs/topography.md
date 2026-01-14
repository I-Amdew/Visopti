# Topography Loading Notes

Key knobs for elevation fetch + partial rendering:

- Rate limiting: `BATCH_QPS_DEFAULT`, `BATCH_QPS_MIN`, `BATCH_QPS_MAX`, and `BATCH_BURST` in `src/topography.ts`.
- Batch sizing: `batchSizeSteps` (100 → 50 → 25) in `src/topography.ts`, reduced on 429s and increased after stable batches.
- Progressive sampling: center-out order with `COARSE_STRIDE_DEFAULT` in `src/topography.ts` (coarse stride before full fill).
- Coverage gating: `TOPO_MIN_COVERAGE_ENABLE` and `TOPO_APPROX_COVERAGE` in `src/main.ts`.
- Cache key rounding: 5 decimal places via `buildElevationCacheKey` in `src/topographyCache.ts`.
