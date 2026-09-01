import { deploymentAssetUrl } from "../base-url";
import { detectAICapability } from "./AICapability";
import { getAIModelBytes } from "./AIModelLoader";
import { DEFAULT_AI_MODEL } from "./AIModelRegistry";
import type { AIProvider, AISettings } from "./types";
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
  inferenceMs?: number;
  rgba?: ArrayBuffer;
};
type StageReply = { id: number; kind: "stage"; stage: WorkerStage };
type PendingRequest = {
  resolve: (value: Reply) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  stage: WorkerStage | "queued";
};

type WorkerPlan = {
  key: string;
  runtimeFile: string;
  providers: AIProvider[];
};

let worker: Worker | null = null;
let initPromise: Promise<AIProvider> | null = null;
let activePlanKey: string | null = null;
let sequence = 0;
const pending = new Map<number, PendingRequest>();
let restartCount = 0;

const WORKER_INIT_TIMEOUT_MS = 45_000;
const WORKER_INFERENCE_TIMEOUT_MS = 120_000;

class AIWorkerWatchdogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIWorkerWatchdogError";
  }
}

function settlePendingWithError(error: Error): void {
  for (const request of pending.values()) {
    if (request.timer) clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function terminateActiveWorker(active: Worker, error: Error, state: "crashed" | "cancelled"): void {
  active.terminate();
  if (worker === active) {
    worker = null;
    initPromise = null;
    activePlanKey = null;
  }
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
      const request = pending.get(event.data.id);
      if (request) request.stage = event.data.stage;
      updateAIDiagnostics({
        workerState: event.data.stage.startsWith("inference-") ? "inference" : "starting",
      });
      return;
    }
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (request.timer) clearTimeout(request.timer);
    if (event.data.ok) {
      updateAIDiagnostics({ workerState: event.data.rgba ? "idle" : "ready" });
      request.resolve(event.data);
    } else {
      request.reject(new Error(event.data.error || "AI worker failed."));
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
    const pendingRequest: PendingRequest = { resolve, reject, stage: "queued" };
    if (timeoutMs) {
      pendingRequest.timer = setTimeout(() => {
        const current = pending.get(id);
        if (!current) return;
        const error = new AIWorkerWatchdogError(
          `Local AI worker ${type} exceeded the ${Math.round(timeoutMs / 1000)} second safety limit while ${current.stage}.`,
        );
        terminateActiveWorker(active, error, "crashed");
      }, timeoutMs);
    }
    pending.set(id, pendingRequest);
    active.postMessage({ id, type, ...payload }, transfer);
  });
}

async function resolveWorkerPlan(settings: AISettings): Promise<WorkerPlan> {
  const capability = await detectAICapability();
  const requested = settings.provider === "auto" ? capability.recommendedProvider : settings.provider;
  const useWebgpu = requested === "webgpu" && capability.webgpu === "available";
  const providers: AIProvider[] = useWebgpu ? ["webgpu", "wasm"] : ["wasm"];
  const runtimeFile = useWebgpu ? "ort.webgpu.bundle.min.mjs" : "ort.wasm.bundle.min.mjs";
  return { key: `${runtimeFile}:${providers.join(",")}`, runtimeFile, providers };
}

async function initialize(settings: AISettings): Promise<AIProvider> {
  const plan = await resolveWorkerPlan(settings);
  if (initPromise && activePlanKey !== plan.key) await resetAIWorker();
  if (!initPromise) {
    activePlanKey = plan.key;
    const planKey = plan.key;
    initPromise = (async () => {
      const model = await getAIModelBytes(DEFAULT_AI_MODEL);
      if (!model) throw new Error("AI Reconstruction model not installed.");
      const reply = await request("init", {
        runtimeUrl: deploymentAssetUrl(`vendor/onnx/${plan.runtimeFile}`),
        wasmBaseUrl: deploymentAssetUrl("vendor/onnx/"),
        model,
        providers: plan.providers,
        hardwareConcurrency: navigator.hardwareConcurrency || 2,
        imageInput: DEFAULT_AI_MODEL.imageInput,
        maskInput: DEFAULT_AI_MODEL.maskInput,
        outputName: DEFAULT_AI_MODEL.output,
        size: DEFAULT_AI_MODEL.inputWidth,
      }, [model], WORKER_INIT_TIMEOUT_MS);
      return reply.provider ?? "wasm";
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

export async function runWorkerInpainting(
  image: ImageData,
  mask: Float32Array,
  settings: AISettings,
  signal?: AbortSignal,
): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {
  if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");
  const abort = () => { void resetAIWorker(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const attempt = async () => {
      const provider = await initialize(settings);
      const rgba = new Uint8ClampedArray(image.data);
      const maskCopy = new Float32Array(mask);
      updateAIDiagnostics({ workerState: "inference" });
      const reply = await request(
        "infer",
        { rgba: rgba.buffer, mask: maskCopy.buffer },
        [rgba.buffer, maskCopy.buffer],
        WORKER_INFERENCE_TIMEOUT_MS,
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
      await resetAIWorker();
      // A watchdog timeout is evidence that the current neural run did not
      // make forward progress. Retrying the same expensive run would only
      // extend the freeze window, so fail boundedly and let the UI recover.
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
