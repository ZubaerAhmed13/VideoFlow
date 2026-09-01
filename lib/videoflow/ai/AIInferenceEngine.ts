import { detectAICapability } from "./AICapability";
import { getAIModelBytes } from "./AIModelLoader";
import { DEFAULT_AI_MODEL } from "./AIModelRegistry";
import type { AIProvider, AISettings } from "./types";
import { runWorkerInpainting, resetAIWorker } from "./AIWorkerClient";
import { deploymentAssetUrl } from "../base-url";

type OrtTensor = { data: Float32Array | Uint8Array; dims: readonly number[] };
type OrtRuntime = {
  env?: { wasm?: { numThreads?: number; wasmPaths?: string } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(model: ArrayBuffer, options: { executionProviders: string[] }): Promise<{ inputNames?: string[]; outputNames?: string[]; run(feeds: Record<string, OrtTensor>): Promise<Record<string, { data: Float32Array | Uint8Array }>>; release?(): Promise<void> | void }> };
};

type RuntimeFlavor = "webgpu" | "wasm";
type ExecutionPlan = { flavor: RuntimeFlavor; providers: AIProvider[] };
type ResolvedSession = {
  runtime: OrtRuntime;
  session: Awaited<ReturnType<OrtRuntime["InferenceSession"]["create"]>>;
  provider: AIProvider;
  flavor: RuntimeFlavor;
};

const runtimePromises: Partial<Record<RuntimeFlavor, Promise<OrtRuntime>>> = {};
let sessionPromise: Promise<ResolvedSession> | null = null;
let sessionFlavor: RuntimeFlavor | null = null;

function runtimeFile(flavor: RuntimeFlavor): string {
  return flavor === "webgpu" ? "ort.webgpu.bundle.min.mjs" : "ort.wasm.bundle.min.mjs";
}

async function loadRuntime(flavor: RuntimeFlavor): Promise<OrtRuntime> {
  if (!runtimePromises[flavor]) {
    runtimePromises[flavor] = (import(/* @vite-ignore */ deploymentAssetUrl(`vendor/onnx/${runtimeFile(flavor)}`)) as Promise<OrtRuntime>)
      .then((runtime) => {
        // ONNX Runtime otherwise derives its companion .mjs/.wasm URLs from
        // the generated application chunk. On a nested SPA host that request
        // can resolve to index.html, which then fails WASM magic validation.
        if (runtime.env?.wasm) runtime.env.wasm.wasmPaths = deploymentAssetUrl("vendor/onnx/");
        return runtime;
      });
  }
  return runtimePromises[flavor]!;
}

async function executionPlan(settings: AISettings): Promise<ExecutionPlan> {
  const capability = await detectAICapability();
  const requested = settings.provider === "auto" ? capability.recommendedProvider : settings.provider;
  const useWebgpu = requested === "webgpu" && capability.webgpu === "available";
  const providers: AIProvider[] = useWebgpu ? ["webgpu", "wasm"] : ["wasm"];
  return {
    flavor: useWebgpu ? "webgpu" : "wasm",
    providers,
  };
}

async function createSession(plan: ExecutionPlan): Promise<ResolvedSession> {
  const [runtime, model] = await Promise.all([loadRuntime(plan.flavor), getAIModelBytes(DEFAULT_AI_MODEL)]);
  if (!model) throw new Error("AI Reconstruction model not installed.");
  if (runtime.env?.wasm) {
    runtime.env.wasm.numThreads = globalThis.crossOriginIsolated
      ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2))
      : 1;
  }

  const primaryProvider: AIProvider = plan.providers[0] ?? "wasm";
  try {
    const session = await runtime.InferenceSession.create(model, { executionProviders: plan.providers });
    return { runtime, session, provider: primaryProvider, flavor: plan.flavor };
  } catch (error) {
    if (primaryProvider !== "webgpu") throw error;
    const session = await runtime.InferenceSession.create(model, { executionProviders: ["wasm"] });
    return { runtime, session, provider: "wasm", flavor: plan.flavor };
  }
}

async function getResolvedSession(settings: AISettings): Promise<ResolvedSession> {
  const plan = await executionPlan(settings);
  if (!sessionPromise || sessionFlavor !== plan.flavor) {
    const previousPromise = sessionPromise;
    if (previousPromise) {
      const previous = await previousPromise.catch(() => null);
      await previous?.session.release?.();
    }

    sessionFlavor = plan.flavor;
    const nextSession = createSession(plan).catch((error): never => {
      if (sessionPromise === nextSession) {
        sessionPromise = null;
        sessionFlavor = null;
      }
      throw error;
    });
    sessionPromise = nextSession;
  }

  const activeSession = sessionPromise;
  if (activeSession === null) throw new Error("AI session initialization did not start.");
  return activeSession;
}

export async function initializeAI(settings: AISettings): Promise<{ provider: AIProvider }> {
  const resolved = await getResolvedSession(settings);
  return { provider: resolved.provider };
}

async function runImageInpaintingMainThread(image: ImageData, mask: Float32Array, settings: AISettings): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {
  const resolved = await getResolvedSession(settings);
  const runtime = resolved.runtime;
  const size = DEFAULT_AI_MODEL.inputWidth;
  if (image.width !== size || image.height !== size) throw new Error(`AI input must be ${size}×${size}.`);
  const pixels = size * size;
  const inputNames = resolved.session.inputNames ?? [DEFAULT_AI_MODEL.imageInput];
  const feeds: Record<string, OrtTensor> = {};
  if (inputNames.length === 1) {
    const packed = new Float32Array(4 * pixels);
    for (let i = 0; i < pixels; i += 1) {
      const hole = Math.max(0, Math.min(1, mask[i]));
      packed[i] = (image.data[i * 4] / 255) * (1 - hole);
      packed[pixels + i] = (image.data[i * 4 + 1] / 255) * (1 - hole);
      packed[pixels * 2 + i] = (image.data[i * 4 + 2] / 255) * (1 - hole);
      packed[pixels * 3 + i] = hole;
    }
    feeds[inputNames[0]] = new runtime.Tensor("float32", packed, [1, 4, size, size]);
  } else {
    const rgb = new Float32Array(3 * pixels);
    for (let i = 0; i < pixels; i += 1) {
      rgb[i] = image.data[i * 4] / 255;
      rgb[pixels + i] = image.data[i * 4 + 1] / 255;
      rgb[pixels * 2 + i] = image.data[i * 4 + 2] / 255;
    }
    feeds[inputNames[0] ?? DEFAULT_AI_MODEL.imageInput] = new runtime.Tensor("float32", rgb, [1, 3, size, size]);
    feeds[inputNames[1] ?? DEFAULT_AI_MODEL.maskInput] = new runtime.Tensor("float32", mask, [1, 1, size, size]);
  }
  const start = performance.now();
  const output = await resolved.session.run(feeds);
  const elapsed = performance.now() - start;
  const values = output[resolved.session.outputNames?.[0] ?? DEFAULT_AI_MODEL.output]?.data ?? Object.values(output)[0]?.data;
  if (!values) throw new Error("AI model returned no output tensor.");
  const result = new ImageData(size, size);
  for (let i = 0; i < size * size; i += 1) {
    const r = Number(values[i]), g = Number(values[size * size + i]), b = Number(values[size * size * 2 + i]);
    const scale = Math.max(r, g, b) <= 1.5 ? 255 : 1;
    result.data[i * 4] = Math.max(0, Math.min(255, r * scale));
    result.data[i * 4 + 1] = Math.max(0, Math.min(255, g * scale));
    result.data[i * 4 + 2] = Math.max(0, Math.min(255, b * scale));
    result.data[i * 4 + 3] = 255;
  }
  return { imageData: result, provider: resolved.provider, inferenceMs: elapsed };
}

export async function runImageInpainting(image: ImageData, mask: Float32Array, settings: AISettings, signal?: AbortSignal): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {
  if (typeof Worker !== "undefined") {
    try {
      return await runWorkerInpainting(image, mask, settings, signal);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      // A browser may reject module workers or a worker runtime may fail its
      // watchdog. Preserve a genuine local neural fallback on the main thread
      // instead of silently changing the reconstruction method.
    }
  }
  if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");
  return runImageInpaintingMainThread(image, mask, settings);
}

export async function resetAISession(): Promise<void> {
  await resetAIWorker();
  const currentPromise = sessionPromise;
  if (currentPromise) {
    const current = await currentPromise.catch(() => null);
    await current?.session.release?.();
  }
  sessionPromise = null;
  sessionFlavor = null;
}
