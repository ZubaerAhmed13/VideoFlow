import type { AIProvider, AISettings } from "./types";
import {
  initializeAIWorker,
  resetAIWorker,
  runWorkerInpainting,
} from "./AIWorkerClient";

export async function initializeAI(settings: AISettings): Promise<{ provider: AIProvider }> {
  return { provider: await initializeAIWorker(settings) };
}

export async function runImageInpainting(
  image: ImageData,
  mask: Float32Array,
  settings: AISettings,
  signal?: AbortSignal,
): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {
  if (signal?.aborted)
    throw new DOMException("AI reconstruction cancelled.", "AbortError");
  if (typeof Worker === "undefined") {
    throw new Error(
      "Local AI reconstruction requires Web Worker support so ONNX inference remains isolated, cancellable, and bounded.",
    );
  }
  // Neural inference intentionally never falls back to the UI thread. A
  // stalled ONNX session must remain terminable by the worker watchdog rather
  // than freezing the editor after the worker has already been killed.
  return runWorkerInpainting(image, mask, settings, signal);
}

export async function resetAISession(): Promise<void> {
  await resetAIWorker();
}
