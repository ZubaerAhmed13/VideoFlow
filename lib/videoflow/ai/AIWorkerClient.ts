import { deploymentAssetUrl } from "../base-url";
import { detectAICapability } from "./AICapability";
import { getAIModelBytes } from "./AIModelLoader";
import { DEFAULT_AI_MODEL } from "./AIModelRegistry";
import type { AIProvider, AISettings } from "./types";
import { updateAIDiagnostics } from "./AIDiagnostics";

type Reply = { id: number; ok: boolean; error?: string; provider?: AIProvider; inferenceMs?: number; rgba?: ArrayBuffer };
let worker: Worker | null = null;
let initPromise: Promise<AIProvider> | null = null;
let sequence = 0;
const pending = new Map<number, { resolve: (value: Reply) => void; reject: (reason: unknown) => void }>();
let restartCount = 0;

function ensureWorker(): Worker {
  if (worker) return worker;
  updateAIDiagnostics({ workerState: "starting" });
  worker = new Worker(new URL("../../../workers/ai-inference.worker.ts", import.meta.url), { type: "module", name: "videoflow-ai-inference" });
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.ok) {
      updateAIDiagnostics({ workerState: event.data.rgba ? "idle" : "ready" });
      request.resolve(event.data);
    }
    else request.reject(new Error(event.data.error || "AI worker failed."));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "AI inference worker crashed.");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
    initPromise = null;
    updateAIDiagnostics({ workerState: "crashed" });
  };
  return worker;
}

function request(type: string, payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<Reply> {
  const active = ensureWorker();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    active.postMessage({ id, type, ...payload }, transfer);
  });
}

async function initialize(settings: AISettings): Promise<AIProvider> {
  if (!initPromise) initPromise = (async () => {
    const [model, capability] = await Promise.all([getAIModelBytes(DEFAULT_AI_MODEL), detectAICapability()]);
    if (!model) throw new Error("AI Reconstruction model not installed.");
    const requested = settings.provider === "auto" ? capability.recommendedProvider : settings.provider;
    const providers = requested === "webgpu" && capability.webgpu === "available" ? ["webgpu", "wasm"] : ["wasm"];
    const reply = await request("init", {
      runtimeUrl: deploymentAssetUrl("vendor/onnx/ort.webgpu.bundle.min.mjs"),
      wasmBaseUrl: deploymentAssetUrl("vendor/onnx/"),
      model,
      providers,
      hardwareConcurrency: navigator.hardwareConcurrency || 2,
      imageInput: DEFAULT_AI_MODEL.imageInput,
      maskInput: DEFAULT_AI_MODEL.maskInput,
      outputName: DEFAULT_AI_MODEL.output,
      size: DEFAULT_AI_MODEL.inputWidth,
    }, [model]);
    return reply.provider ?? "wasm";
  })();
  return initPromise;
}

export async function runWorkerInpainting(image: ImageData, mask: Float32Array, settings: AISettings, signal?: AbortSignal): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {
  if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");
  const abort = () => { void resetAIWorker(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const attempt = async () => {
      const provider = await initialize(settings);
      const rgba = new Uint8ClampedArray(image.data);
      const maskCopy = new Float32Array(mask);
      updateAIDiagnostics({ workerState: "inference" });
      const reply = await request("infer", { rgba: rgba.buffer, mask: maskCopy.buffer }, [rgba.buffer, maskCopy.buffer]);
      if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");
      if (!reply.rgba) throw new Error("AI worker returned no image data.");
      return { imageData: new ImageData(new Uint8ClampedArray(reply.rgba), image.width, image.height), provider: reply.provider ?? provider, inferenceMs: reply.inferenceMs ?? 0 };
    };
    try {
      return await attempt();
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      restartCount += 1;
      updateAIDiagnostics({ workerState: "restarting", workerRestarts: restartCount });
      await resetAIWorker();
      return attempt();
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function resetAIWorker(): Promise<void> {
  const active = worker;
  worker = null;
  initPromise = null;
  if (!active) return;
  active.terminate();
  const error = new DOMException("AI worker was cancelled or reset.", "AbortError");
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  updateAIDiagnostics({ workerState: "cancelled" });
}

/** Playwright-only recovery hook. It never exposes model data or executable input. */
export function forceAIWorkerCrashForTest(): void {
  if (typeof navigator === "undefined" || !navigator.webdriver) return;
  const active = worker;
  worker = null;
  initPromise = null;
  active?.terminate();
  const error = new Error("Simulated AI inference worker crash.");
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  restartCount += 1;
  updateAIDiagnostics({ workerState: "crashed", workerRestarts: restartCount });
}

declare global {
  interface Window {
    __videoFlowForceAIWorkerCrashForTest?: () => void;
  }
}

if (typeof window !== "undefined" && navigator.webdriver) {
  window.__videoFlowForceAIWorkerCrashForTest = forceAIWorkerCrashForTest;
}
