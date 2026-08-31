/// <reference lib="webworker" />

type Provider = "webgpu" | "wasm";
type OrtTensor = { data: Float32Array | Uint8Array; dims: readonly number[] };
type OrtRuntime = {
  env?: { wasm?: { numThreads?: number; wasmPaths?: string } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(model: ArrayBuffer, options: { executionProviders: string[] }): Promise<{ inputNames?: string[]; outputNames?: string[]; run(feeds: Record<string, OrtTensor>): Promise<Record<string, { data: Float32Array | Uint8Array }>>; release?(): Promise<void> | void }> };
};

type Session = Awaited<ReturnType<OrtRuntime["InferenceSession"]["create"]>>;
let runtime: OrtRuntime | null = null;
let session: Session | null = null;
let provider: Provider = "wasm";
let imageInput = "image";
let maskInput = "mask";
let outputName = "output";
let size = 512;

type InitRequest = {
  id: number;
  type: "init";
  runtimeUrl: string;
  wasmBaseUrl: string;
  model: ArrayBuffer;
  providers: string[];
  hardwareConcurrency?: number;
  imageInput: string;
  maskInput: string;
  outputName: string;
  size: number;
};

type InferRequest = {
  id: number;
  type: "infer";
  rgba: ArrayBuffer;
  mask: ArrayBuffer;
};

type DisposeRequest = { id: number; type: "dispose" };
type WorkerRequest = InitRequest | InferRequest | DisposeRequest;

async function init(data: InitRequest) {
  runtime = await import(/* @vite-ignore */ data.runtimeUrl) as OrtRuntime;
  if (runtime.env?.wasm) {
    runtime.env.wasm.wasmPaths = data.wasmBaseUrl;
    runtime.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, data.hardwareConcurrency || 2)) : 1;
  }
  imageInput = data.imageInput;
  maskInput = data.maskInput;
  outputName = data.outputName;
  size = data.size;
  const providers: string[] = data.providers;
  try {
    session = await runtime.InferenceSession.create(data.model, { executionProviders: providers });
    provider = providers[0] as Provider;
  } catch (error) {
    if (providers[0] !== "webgpu") throw error;
    session = await runtime.InferenceSession.create(data.model, { executionProviders: ["wasm"] });
    provider = "wasm";
  }
  return provider;
}

async function infer(data: InferRequest) {
  if (!runtime || !session) throw new Error("AI worker session is not initialized.");
  const rgba = new Uint8ClampedArray(data.rgba);
  const mask = new Float32Array(data.mask);
  const pixels = size * size;
  const inputNames = session.inputNames ?? [imageInput];
  const feeds: Record<string, OrtTensor> = {};
  if (inputNames.length === 1) {
    const packed = new Float32Array(4 * pixels);
    for (let i = 0; i < pixels; i += 1) {
      const hole = Math.max(0, Math.min(1, mask[i]));
      packed[i] = (rgba[i * 4] / 255) * (1 - hole);
      packed[pixels + i] = (rgba[i * 4 + 1] / 255) * (1 - hole);
      packed[pixels * 2 + i] = (rgba[i * 4 + 2] / 255) * (1 - hole);
      packed[pixels * 3 + i] = hole;
    }
    feeds[inputNames[0]] = new runtime.Tensor("float32", packed, [1, 4, size, size]);
  } else {
    const rgb = new Float32Array(3 * pixels);
    for (let i = 0; i < pixels; i += 1) {
      rgb[i] = rgba[i * 4] / 255;
      rgb[pixels + i] = rgba[i * 4 + 1] / 255;
      rgb[pixels * 2 + i] = rgba[i * 4 + 2] / 255;
    }
    feeds[inputNames[0] ?? imageInput] = new runtime.Tensor("float32", rgb, [1, 3, size, size]);
    feeds[inputNames[1] ?? maskInput] = new runtime.Tensor("float32", mask, [1, 1, size, size]);
  }
  const started = performance.now();
  const outputs = await session.run(feeds);
  const inferenceMs = performance.now() - started;
  const values = outputs[session.outputNames?.[0] ?? outputName]?.data ?? Object.values(outputs)[0]?.data;
  if (!values) throw new Error("AI model returned no output tensor.");
  const result = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const r = Number(values[i]);
    const g = Number(values[size * size + i]);
    const b = Number(values[size * size * 2 + i]);
    const scale = Math.max(r, g, b) <= 1.5 ? 255 : 1;
    result[i * 4] = Math.max(0, Math.min(255, r * scale));
    result[i * 4 + 1] = Math.max(0, Math.min(255, g * scale));
    result[i * 4 + 2] = Math.max(0, Math.min(255, b * scale));
    result[i * 4 + 3] = 255;
  }
  return { result, inferenceMs, provider };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      const activeProvider = await init(message);
      self.postMessage({ id: message.id, ok: true, provider: activeProvider });
      return;
    }
    if (message.type === "infer") {
      const response = await infer(message);
      self.postMessage({ id: message.id, ok: true, provider: response.provider, inferenceMs: response.inferenceMs, rgba: response.result.buffer }, [response.result.buffer]);
      return;
    }
    await session?.release?.();
    session = null;
    runtime = null;
    self.postMessage({ id: message.id, ok: true });
    self.close();
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
