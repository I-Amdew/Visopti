export type WorkflowMode =
  | "explore"
  | "frame_draft"
  | "frame_locked"
  | "traffic_running"
  | "analysis_ready";

export interface WorkflowState {
  mode: WorkflowMode;
}

type WorkflowListener = (state: WorkflowState) => void;

const state: WorkflowState = {
  mode: "explore"
};

const listeners = new Set<WorkflowListener>();

function notify() {
  const snapshot = { ...state };
  listeners.forEach((listener) => listener(snapshot));
}

export function getState(): WorkflowState {
  return { ...state };
}

export function setMode(mode: WorkflowMode) {
  if (state.mode === mode) {
    return;
  }
  state.mode = mode;
  notify();
}

export function subscribe(listener: WorkflowListener) {
  listeners.add(listener);
  listener({ ...state });
  return () => {
    listeners.delete(listener);
  };
}
