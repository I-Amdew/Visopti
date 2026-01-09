import { simulateTraffic } from "./sim";
import { TrafficSimProgress, TrafficSimRequest } from "./types";

type TrafficWorkerRequest =
  | TrafficSimRequest
  | {
      type: "run";
      payload: TrafficSimRequest;
    };

type TrafficWorkerControl = { type: "cancel" };

const ctx = self as unknown as {\n  postMessage: (message: unknown) => void;\n  onmessage: ((event: MessageEvent) => void) | null;\n};

let cancelled = false;

ctx.onmessage = (event: MessageEvent<TrafficWorkerRequest | TrafficWorkerControl>) => {
  const data = event.data;
  if (data && "type" in data && data.type === "cancel") {
    cancelled = true;
    return;
  }

  const request = data && "type" in data && data.type === "run" ? data.payload : (data as TrafficSimRequest);
  cancelled = false;

  try {
    const result = simulateTraffic(request, {
      onProgress: (progress: TrafficSimProgress) => {
        if (cancelled) {
          return;
        }
        ctx.postMessage({ type: "progress", ...progress });
      },
      isCancelled: () => cancelled,
    });

    if (!cancelled) {
      ctx.postMessage({ type: "result", trafficByRoadId: result.roadTraffic, meta: result.meta });
    }
  } catch (error) {
    if (!cancelled) {
      ctx.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "Traffic simulation failed.",
      });
    }
  }
};
