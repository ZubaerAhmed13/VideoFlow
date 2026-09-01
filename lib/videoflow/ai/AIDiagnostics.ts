import type { AIProvider } from "./types";

export interface AIDiagnosticsSnapshot {
  runtime: "local-onnxruntime-web";
  model: string;
  modelVersion: string;
  provider: AIProvider | "not-initialized";
  inferenceROI: string;
  temporalWindow: number;
  temporalContext: string;
  tileCount: number;
  recentInferenceMs: number | null;
  workerState: "idle" | "starting" | "ready" | "inference" | "restarting" | "crashed" | "cancelled";
  workerRestarts: number;
  intermediate: "png-lossless" | "jpeg-fallback" | "not-run";
}

let snapshot: AIDiagnosticsSnapshot = {
  runtime: "local-onnxruntime-web",
  model: "LaMa Dynamic INT8",
  modelVersion: "g-ronimo-dynamic",
  provider: "not-initialized",
  inferenceROI: "not run",
  temporalWindow: 0,
  temporalContext: "not run",
  tileCount: 0,
  recentInferenceMs: null,
  workerState: "idle",
  workerRestarts: 0,
  intermediate: "not-run",
};

export function updateAIDiagnostics(patch: Partial<AIDiagnosticsSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
}

export function getAIDiagnosticsSnapshot(): AIDiagnosticsSnapshot {
  return { ...snapshot };
}
