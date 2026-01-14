import { simulateTraffic } from "./sim";
import { TrafficSimProgress, TrafficSimRequest } from "./types";

type TrafficWorkerRun = { type: "run"; payload: TrafficSimRequest; runId: number };
type TrafficWorkerRequest = TrafficSimRequest | TrafficWorkerRun;
type TrafficWorkerControl = { type: "cancel"; runId?: number };

const ctx = self as unknown as {
  postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

let cancelled = false;
let activeRunId = 0;

ctx.onmessage = (event: MessageEvent<TrafficWorkerRequest | TrafficWorkerControl>) => {
  const data = event.data;
  if (data && "type" in data && data.type === "cancel") {
    if (data.runId === undefined || data.runId === activeRunId) {
      cancelled = true;
    }
    return;
  }

  const runRequest = data && "type" in data && data.type === "run" ? data : null;
  const request = runRequest ? runRequest.payload : (data as TrafficSimRequest);
  activeRunId = runRequest?.runId ?? 0;
  cancelled = false;

  try {
    const result = simulateTraffic(request, {
      onProgress: (progress: TrafficSimProgress) => {
        if (cancelled) {
          return;
        }
        ctx.postMessage({ type: "progress", runId: activeRunId, ...progress });
      },
      isCancelled: () => cancelled,
    });

    if (!cancelled) {
      ctx.postMessage({
        type: "result",
        runId: activeRunId,
        trafficByRoadId: result.roadTraffic,
        edgeTraffic: result.edgeTraffic,
        viewerSamples: result.viewerSamples,
        epicenters: result.epicenters,
        meta: result.meta,
      });
    }
  } catch (error) {
    if (!cancelled) {
      ctx.postMessage({
        type: "error",
        runId: activeRunId,
        message: error instanceof Error ? error.message : "Traffic simulation failed.",
      });
    }
  }
};
