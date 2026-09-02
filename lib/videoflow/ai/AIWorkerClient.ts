import { deploymentAssetUrl } from "../base-url";
import { detectAICapability } from "./AICapability";
import { getAIModelBytes } from "./AIModelLoader";
import { DEFAULT_AI_MODEL, modelForInferenceSize } from "./AIModelRegistry";
import type { AIInferencePurpose, AIModelDescriptor, AIProvider, AISettings } from "./types";
import { updateAIDiagnostics } from "./AIDiagnostics";

type WorkerStage =
  | "runtime-import"
  | "runtime-ready"
  | "session-creating"
  | "session-ready"
  | "inference-preparing"
  | "inference-running"
  | "inference-complete";

type Reply = {
  id: number;
  kind?: "result";
  ok: boolean;
  error?: string;
  provider?: AIProvider;
  wasmThreads?: number;
  inferenceMs?: number;
  rgba?: ArrayBuffer;
};
type StageReply = { id: number; kind: "stage"; stage: WorkerStage };
type PendingRequest = {
  resolve: (value: Reply) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  stage: WorkerStage | "queued";
  operation: string;
};

type WorkerPlan = {
  key: string;
  runtimeFile: string;
  providers: AIProvider[];
  maxWasmThreads: number;
};

let worker: Worker | null = null;
let initPromise: Promise<AIProvider> | null = null;
let activePlanKey: string | null = null;
let activeProvider: AIProvider | null = null;
let activeWasmThreads = 1;
let sequence = 0;
const pending = new Map<number, PendingRequest>();
let restartCount = 0;

const WORKER_INIT_TIMEOUT_MS = 45_000;
const WORKER_INTERACTIVE_BUDGET_MS = 165_000;
const WORKER_PRODUCTION_BUDGET_MS = 420_000;
const WORKER_THREADED_PROBE_TIMEOUT_MS = 30_000;
const WORKER_INFERENCE_TIMEOUT_MS = 125_000;
const WORKER_PRODUCTION_INFERENCE_TIMEOUT_MS = 300_000;
const WORKER_MIN_TIMEOUT_SLICE_MS = 1_000;
const WASM_THREAD_PROFILE_KEY = "videoflow.ai.wasm-thread-limit";

function readWasmThreadLimit(): number | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(WASM_THREAD_PROFILE_KEY) === "1" ? 1 : null;
  } catch {
    return null;
  }
}

function persistSingleThreadWasmProfile(): void {
  wasmThreadLimit = 1;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(WASM_THREAD_PROFILE_KEY, "1");
  } catch {
    // Session storage is only an optimization. The in-memory profile remains authoritative.
  }
}

let wasmThreadLimit: number | null = readWasmThreadLimit();

class AIWorkerWatchdogError extends Error {
  readonly operation: string;
  readonly stage: WorkerStage | "queued";
  readonly provider: AIProvider | null;
  readonly wasmThreads: number;

  constructor(
    message: string,
    operation: string,
    stage: WorkerStage | "queued",
    provider: AIProvider | null,
    wasmThreads: number,
  ) {
    super(message);
    this.name = "AIWorkerWatchdogError";
    this.operation = operation;
    this.stage = stage;
    this.provider = provider;
    this.wasmThreads = wasmThreads;
  }
}

function timeoutWithinDeadline(deadline: number, ceilingMs: number, operation: string, budgetMs: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= WORKER_MIN_TIMEOUT_SLICE_MS) {
    throw new AIWorkerWatchdogError(
      `Local AI worker ${operation} exhausted the ${Math.round(budgetMs / 1000)} second ${budgetMs === WORKER_INTERACTIVE_BUDGET_MS ? "interactive" : "production"} budget.`,
      operation,
      "queued",
      activeProvider,
      activeWasmThreads,
    );
  }
  return Math.min(ceilingMs, remaining);
}

function settlePendingWithError(error: Error): void {
  for (const request of pending.values()) {
    if (request.timer) clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function clearActiveWorkerState(active: Worker): void {
  if (worker !== active) return;
  worker = null;
  initPromise = null;
  activePlanKey = null;
  activeProvider = null;
  activeWasmThreads = 1;
}

function terminateActiveWorker(active: Worker, error: Error, state: "crashed" | "cancelled"): void {
  active.terminate();
  clearActiveWorkerState(active);
  settlePendingWithError(error);
  updateAIDiagnostics({ workerState: state });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  updateAIDiagnostics({ workerState: "starting" });
  const active = new Worker(new URL("../../../workers/ai-inference.worker.ts", import.meta.url), {
    type: "module",
    name: "videoflow-ai-inference",
  });
  worker = active;
  active.onmessage = (event: MessageEvent<Reply | StageReply>) => {
    if (event.data.kind === "stage") {
      const requestEntry = pending.get(event.data.id);
      if (requestEntry) requestEntry.stage = event.data.stage;
      updateAIDiagnostics({
        workerState: event.data.stage.startsWith("inference-") ? "inference" : "starting",
      });
      return;
    }
    const requestEntry = pending.get(event.data.id);
    if (!requestEntry) return;
    pending.delete(event.data.id);
    if (requestEntry.timer) clearTimeout(requestEntry.timer);
    if (event.data.ok) {
      if (event.data.provider) activeProvider = event.data.provider;
      if (typeof event.data.wasmThreads === "number") activeWasmThreads = event.data.wasmThreads;
      updateAIDiagnostics({ workerState: event.data.rgba ? "idle" : "ready" });
      requestEntry.resolve(event.data);
    } else {
      requestEntry.reject(new Error(event.data.error || "AI worker failed."));
    }
  };
  active.onerror = (event) => {
    terminateActiveWorker(active, new Error(event.message || "AI inference worker crashed."), "crashed");
  };
  return active;
}

function request(
  type: string,
  payload: Record<string, unknown>,
  transfer: Transferable[] = [],
  timeoutMs?: number,
): Promise<Reply> {
  const active = ensureWorker();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const pendingRequest: PendingRequest = { resolve, reject, stage: "queued", operation: type };
    if (timeoutMs) {
      pendingRequest.timer = setTimeout(() => {
        const current = pending.get(id);
        if (!current) return;
        const error = new AIWorkerWatchdogError(
          `Local AI worker ${type} exceeded the ${Math.round(timeoutMs / 1000)} second safety limit while ${current.stage}.`,
          current.operation,
          current.stage,
          activeProvider,
          activeWasmThreads,
        );
        terminateActiveWorker(active, error, "crashed");
      }, timeoutMs);
    }
    pending.set(id, pendingRequest);
    active.postMessage({ id, type, ...payload }, transfer);
  });
}

async function resolveWorkerPlan(settings: AISettings, descriptor: AIModelDescriptor): Promise<WorkerPlan> {
  const capability = await detectAICapability();
  const requested = settings.provider === "auto" ? capability.recommendedProvider : settings.provider;
  const useWebgpu = requested === "webgpu" && capability.webgpu === "available";
  const providers: AIProvider[] = useWebgpu ? ["webgpu", "wasm"] : ["wasm"];
  const runtimeFile = useWebgpu ? "ort.webgpu.bundle.min.mjs" : "ort.wasm.bundle.min.mjs";
  const hardwareThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
  const maxWasmThreads = wasmThreadLimit ?? hardwareThreads;
  return {
    key: `${descriptor.id}:${runtimeFile}:${providers.join(",")}:threads-${maxWasmThreads}`,
    runtimeFile,
    providers,
    maxWasmThreads,
  };
}

async function initialize(settings: AISettings, descriptor: AIModelDescriptor = DEFAULT_AI_MODEL, timeoutMs = WORKER_INIT_TIMEOUT_MS): Promise<AIProvider> {
  const plan = await resolveWorkerPlan(settings, descriptor);
  if (initPromise && activePlanKey !== plan.key) await resetAIWorker();
  if (!initPromise) {
    activePlanKey = plan.key;
    const planKey = plan.key;
    initPromise = (async () => {
      const model = await getAIModelBytes(descriptor);
      if (!model) throw new Error("AI Reconstruction model not installed.");
      const reply = await request("init", {
        runtimeUrl: deploymentAssetUrl(`vendor/onnx/${plan.runtimeFile}`),
        wasmBaseUrl: deploymentAssetUrl("vendor/onnx/"),
        model,
        providers: plan.providers,
        hardwareConcurrency: navigator.hardwareConcurrency || 2,
        maxWasmThreads: plan.maxWasmThreads,
        imageInput: descriptor.imageInput,
        maskInput: descriptor.maskInput,
        outputName: descriptor.output,
      }, [model], Math.min(WORKER_INIT_TIMEOUT_MS, timeoutMs));
      activeProvider = reply.provider ?? "wasm";
      activeWasmThreads = reply.wasmThreads ?? 1;
      return activeProvider;
    })().catch((error): never => {
      if (activePlanKey === planKey) {
        initPromise = null;
        activePlanKey = null;
      }
      throw error;
    });
  }
  return initPromise;
}

export async function initializeAIWorker(settings: AISettings): Promise<AIProvider> {
  return initialize(settings);
}

function shouldDowngradeThreadedWasm(error: unknown): error is AIWorkerWatchdogError {
  return error instanceof AIWorkerWatchdogError
    && error.operation === "infer"
    && error.stage === "inference-running"
    && error.provider === "wasm"
    && error.wasmThreads > 1;
}

export async function runWorkerInpainting(
  image: ImageData,
  mask: Float32Array,
  settings: AISettings,
  signal?: AbortSignal,
  purpose: AIInferencePurpose = "production",
): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {
  if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");
  const inferenceSize = image.width;
  if (image.width !== image.height || (inferenceSize !== 256 && inferenceSize !== 512)) {
    throw new Error(`Local AI inference requires a square 256x256 or 512x512 prepared ROI; received ${image.width}x${image.height}.`);
  }
  if (mask.length !== inferenceSize * inferenceSize) {
    throw new Error(`Local AI mask size does not match the prepared ${inferenceSize}x${inferenceSize} ROI.`);
  }
  const modelDescriptor = modelForInferenceSize(inferenceSize);
  const budgetMs = purpose === "interactive" ? WORKER_INTERACTIVE_BUDGET_MS : WORKER_PRODUCTION_BUDGET_MS;
  const deadline = performance.now() + budgetMs;
  updateAIDiagnostics({ model: modelDescriptor.name, modelVersion: modelDescriptor.version });
  const abort = () => { void resetAIWorker(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const attempt = async () => {
      const provider = await initialize(
        settings,
        modelDescriptor,
        timeoutWithinDeadline(deadline, WORKER_INIT_TIMEOUT_MS, "init", budgetMs),
      );
      const rgba = new Uint8ClampedArray(image.data);
      const maskCopy = new Float32Array(mask);
      updateAIDiagnostics({ workerState: "inference" });
      const reliableInferenceCeiling = purpose === "interactive"
        ? WORKER_INFERENCE_TIMEOUT_MS
        : WORKER_PRODUCTION_INFERENCE_TIMEOUT_MS;
      const timeoutCeiling = provider === "wasm" && activeWasmThreads > 1
        ? WORKER_THREADED_PROBE_TIMEOUT_MS
        : reliableInferenceCeiling;
      const timeoutMs = timeoutWithinDeadline(deadline, timeoutCeiling, "infer", budgetMs);
      const reply = await request(
        "infer",
        { rgba: rgba.buffer, mask: maskCopy.buffer, size: inferenceSize },
        [rgba.buffer, maskCopy.buffer],
        timeoutMs,
      );
      if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");
      if (!reply.rgba) throw new Error("AI worker returned no image data.");
      return {
        imageData: new ImageData(new Uint8ClampedArray(reply.rgba), image.width, image.height),
        provider: reply.provider ?? provider,
        inferenceMs: reply.inferenceMs ?? 0,
      };
    };

    try {
      return await attempt();
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      restartCount += 1;
      updateAIDiagnostics({ workerState: "restarting", workerRestarts: restartCount });

      if (shouldDowngradeThreadedWasm(error)) {
        // Some otherwise capable environments regress or deadlock inside ORT's
        // pthread execution path. A real timed-out neural run is stronger
        // evidence than user-agent heuristics, so pin this tab to a fresh
        // single-thread WASM worker and retry the same inference exactly once.
        // The short viability probe deliberately reserves the majority of the
        // interactive deadline for that reliable fallback.
        persistSingleThreadWasmProfile();
        await resetAIWorker();
        return attempt();
      }

      await resetAIWorker();
      // A watchdog on init, WebGPU, or already-single-thread WASM means there
      // is no safer execution profile left to try. Fail boundedly so the UI
      // remains responsive instead of migrating inference onto the main thread.
      if (error instanceof AIWorkerWatchdogError) throw error;
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
  activePlanKey = null;
  activeProvider = null;
  activeWasmThreads = 1;
  if (!active) return;
  active.terminate();
  settlePendingWithError(new DOMException("AI worker was cancelled or reset.", "AbortError"));
  updateAIDiagnostics({ workerState: "cancelled" });
}

/** Playwright-only recovery hook. It never exposes model data or executable input. */
export function forceAIWorkerCrashForTest(): void {
  if (typeof navigator === "undefined" || !navigator.webdriver) return;
  const active = worker;
  worker = null;
  initPromise = null;
  activePlanKey = null;
  activeProvider = null;
  activeWasmThreads = 1;
  active?.terminate();
  settlePendingWithError(new Error("Simulated AI inference worker crash."));
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
