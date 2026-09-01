from pathlib import Path

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    text = read(path)
    actual = text.count(old)
    if actual != expected:
        raise SystemExit(f"{path}: expected {expected} occurrence(s) of {old!r}, found {actual}")
    write(path, text.replace(old, new))


# ---------------------------------------------------------------------------
# 1. Model registry: production keeps the optimized fixed-512 graph; dynamic
#    INT8 is a separate preview accelerator for CPU/WASM interactive preview.
# ---------------------------------------------------------------------------
write("lib/videoflow/ai/AIModelRegistry.ts", '''import type { AIModelDescriptor } from "./types";

// Production/final model: fixed 512x512 graph with FFTs replaced by matmuls.
// Upstream documents this variant as ~1.8x faster than lama_int8.onnx on CPU/WASM
// with identical output, so final/high-quality reconstruction stays on this graph.
export const LAMA_512_INT8: AIModelDescriptor = {
  id: "lama-512-int8",
  name: "LaMa 512 INT8",
  version: "g-ronimo-8e20140",
  license: "Apache-2.0",
  source: "https://huggingface.co/g-ronimo/lama/blob/main/lama_512_int8.onnx",
  sha256: "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe",
  size: 62074990,
  inputWidth: 512,
  inputHeight: 512,
  imageInput: "input",
  maskInput: "",
  output: "output",
};

// Interactive CPU/WASM accelerator: same LaMa family with dynamic H/W.
// VideoFlow uses this graph at 256x256 only for interactive preview/recovery.
// Project/export metadata continues to reference LAMA_512_INT8.
export const LAMA_DYNAMIC_INT8: AIModelDescriptor = {
  id: "lama-dynamic-int8",
  name: "LaMa Dynamic INT8",
  version: "g-ronimo-dynamic",
  license: "Apache-2.0",
  source: "https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx",
  sha256: "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
  size: 61512617,
  inputWidth: 256,
  inputHeight: 256,
  imageInput: "input",
  maskInput: "",
  output: "output",
};

export const AI_MODELS = [LAMA_512_INT8, LAMA_DYNAMIC_INT8] as const;
export const DEFAULT_AI_MODEL = LAMA_512_INT8;
export const PREVIEW_AI_MODEL = LAMA_DYNAMIC_INT8;

export function modelForInferenceSize(size: 256 | 512): AIModelDescriptor {
  return size === 256 ? PREVIEW_AI_MODEL : DEFAULT_AI_MODEL;
}
''')

# ---------------------------------------------------------------------------
# 2. Shared types: record complete installed pack and distinguish interactive
#    watchdog policy from production/final worker policy.
# ---------------------------------------------------------------------------
replace(
    "lib/videoflow/ai/types.ts",
    'export type AIQuality = "fast" | "balanced" | "high" | "maximum";\n',
    'export type AIQuality = "fast" | "balanced" | "high" | "maximum";\nexport type AIInferencePurpose = "interactive" | "production";\n',
)
replace(
    "lib/videoflow/ai/types.ts",
    '  verifiedAt?: string;\n  error?: string;\n}',
    '  verifiedAt?: string;\n  installedModelIds?: string[];\n  error?: string;\n}',
)

# ---------------------------------------------------------------------------
# 3. Model loader: bundle installation is an integrity-checked two-model pack.
#    Models stay outside the PWA precache and are only copied to Cache Storage
#    after explicit user action. Existing v2 dynamic bytes can be reused.
# ---------------------------------------------------------------------------
write("lib/videoflow/ai/AIModelLoader.ts", '''import { AI_MODELS, DEFAULT_AI_MODEL } from "./AIModelRegistry";
import { deploymentAssetUrl } from "../base-url";
import type { AIModelDescriptor, AIModelInstallRecord } from "./types";

const MODEL_CACHE = "videoflow-ai-models-v2";
const LEGACY_MODEL_CACHE = "videoflow-ai-models-v1";
const MODEL_RECORD = "videoflow-ai-model-record";
const modelUrl = (id: string) => deploymentAssetUrl(`models/${id}.onnx`);

async function digestHex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function validateModelBytes(bytes: ArrayBuffer, descriptor: AIModelDescriptor): Promise<void> {
  if (bytes.byteLength !== descriptor.size) {
    throw new Error(`AI model validation failed. Expected ${descriptor.size} bytes, received ${bytes.byteLength}.`);
  }
  const checksum = await digestHex(bytes);
  if (checksum !== descriptor.sha256) {
    throw new Error(`AI model validation failed. Expected ${descriptor.sha256}, received ${checksum}.`);
  }
}

async function ensureStorageHeadroom(additionalBytes: number): Promise<void> {
  if (!additionalBytes || typeof navigator === "undefined" || !navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  const available = Math.max(0, Number(estimate.quota ?? 0) - Number(estimate.usage ?? 0));
  const required = Math.ceil(additionalBytes * 1.2) + 64 * 1024 * 1024;
  if (estimate.quota && available < required) {
    throw new Error(`AI model installation needs about ${Math.ceil(required / 1024 / 1024)} MiB of free browser storage; only ${Math.floor(available / 1024 / 1024)} MiB is available.`);
  }
}

async function verifiedCachedBytes(descriptor: AIModelDescriptor): Promise<ArrayBuffer | null> {
  const cache = await caches.open(MODEL_CACHE);
  const response = await cache.match(modelUrl(descriptor.id));
  if (!response) return null;
  const bytes = await response.arrayBuffer();
  try {
    await validateModelBytes(bytes, descriptor);
    return bytes;
  } catch {
    await cache.delete(modelUrl(descriptor.id));
    return null;
  }
}

async function writePackRecord(installedModelIds: string[]): Promise<AIModelInstallRecord> {
  const timestamp = new Date().toISOString();
  const record: AIModelInstallRecord = {
    descriptor: DEFAULT_AI_MODEL,
    state: "installed",
    installedAt: timestamp,
    verifiedAt: timestamp,
    installedModelIds,
  };
  localStorage.setItem(MODEL_RECORD, JSON.stringify(record));
  return record;
}

export async function installBundledAIModel(): Promise<AIModelInstallRecord> {
  const cache = await caches.open(MODEL_CACHE);
  const entries: Array<{ descriptor: AIModelDescriptor; bytes: ArrayBuffer; needsWrite: boolean }> = [];
  let additionalBytes = 0;

  // Validate every model before mutating the installed-pack record. A partially
  // downloaded pack is never reported as installed.
  for (const descriptor of AI_MODELS) {
    const cached = await verifiedCachedBytes(descriptor);
    if (cached) {
      entries.push({ descriptor, bytes: cached, needsWrite: false });
      continue;
    }
    const response = await fetch(modelUrl(descriptor.id), { cache: "no-store" });
    if (!response.ok) throw new Error(`Bundled AI model is unavailable: ${descriptor.name}.`);
    const bytes = await response.arrayBuffer();
    await validateModelBytes(bytes, descriptor);
    additionalBytes += bytes.byteLength;
    entries.push({ descriptor, bytes, needsWrite: true });
  }

  await ensureStorageHeadroom(additionalBytes);
  for (const entry of entries) {
    if (!entry.needsWrite) continue;
    await cache.put(modelUrl(entry.descriptor.id), new Response(entry.bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "x-videoflow-sha256": entry.descriptor.sha256,
      },
    }));
  }
  await caches.delete(LEGACY_MODEL_CACHE).catch(() => false);
  return writePackRecord(AI_MODELS.map((model) => model.id));
}

export async function bundledAIModelAvailable(): Promise<boolean> {
  try {
    const results = await Promise.all(AI_MODELS.map(async (descriptor) => {
      const response = await fetch(modelUrl(descriptor.id), { method: "HEAD", cache: "no-store" });
      return response.ok;
    }));
    return results.every(Boolean);
  } catch {
    return false;
  }
}

export async function installAIModel(file: File, descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<AIModelInstallRecord> {
  const bytes = await file.arrayBuffer();
  await validateModelBytes(bytes, descriptor);
  await ensureStorageHeadroom(bytes.byteLength);
  const cache = await caches.open(MODEL_CACHE);
  await cache.put(modelUrl(descriptor.id), new Response(bytes, {
    headers: { "content-type": "application/octet-stream", "x-videoflow-sha256": descriptor.sha256 },
  }));
  const installed = [descriptor.id];
  for (const candidate of AI_MODELS) {
    if (candidate.id === descriptor.id) continue;
    if (await verifiedCachedBytes(candidate)) installed.push(candidate.id);
  }
  await caches.delete(LEGACY_MODEL_CACHE).catch(() => false);
  return writePackRecord(installed);
}

export function getAIModelRecord(): AIModelInstallRecord {
  try {
    const record = JSON.parse(localStorage.getItem(MODEL_RECORD) ?? "null") as AIModelInstallRecord | null;
    if (!record || record.descriptor?.id !== DEFAULT_AI_MODEL.id) {
      if (record) localStorage.removeItem(MODEL_RECORD);
      return { descriptor: DEFAULT_AI_MODEL, state: "not-installed", installedModelIds: [] };
    }
    return { ...record, installedModelIds: record.installedModelIds ?? [record.descriptor.id] };
  } catch {
    return { descriptor: DEFAULT_AI_MODEL, state: "error", installedModelIds: [], error: "Stored AI model metadata is invalid." };
  }
}

export function isAIModelInstalled(modelId: string): boolean {
  const record = getAIModelRecord();
  return (record.state === "installed" || record.state === "ready")
    && (record.installedModelIds ?? [record.descriptor.id]).includes(modelId);
}

export async function getAIModelBytes(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<ArrayBuffer | null> {
  return verifiedCachedBytes(descriptor);
}

export async function removeAIModel(): Promise<void> {
  await Promise.all([
    caches.delete(MODEL_CACHE),
    caches.delete(LEGACY_MODEL_CACHE),
  ]);
  localStorage.removeItem(MODEL_RECORD);
}
''')

# ---------------------------------------------------------------------------
# 4. Inference purpose and reconstruction plumbing.
# ---------------------------------------------------------------------------
replace(
    "lib/videoflow/ai/AIInferenceEngine.ts",
    'import type { AIProvider, AISettings } from "./types";',
    'import type { AIInferencePurpose, AIProvider, AISettings } from "./types";',
)
replace(
    "lib/videoflow/ai/AIInferenceEngine.ts",
    '  settings: AISettings,\n  signal?: AbortSignal,\n): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {',
    '  settings: AISettings,\n  signal?: AbortSignal,\n  purpose: AIInferencePurpose = "production",\n): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {',
)
replace(
    "lib/videoflow/ai/AIInferenceEngine.ts",
    '  return runWorkerInpainting(image, mask, settings, signal);',
    '  return runWorkerInpainting(image, mask, settings, signal, purpose);',
)

replace(
    "lib/videoflow/ai/AIManager.ts",
    'import type { AIFrameResult, AISettings } from "./types";',
    'import type { AIFrameResult, AIInferencePurpose, AISettings } from "./types";',
)
replace(
    "lib/videoflow/ai/AIManager.ts",
    '  signal?: AbortSignal,\n  inferenceSize: 256 | 512 = 512,\n): Promise<AIFrameResult> {',
    '  signal?: AbortSignal,\n  inferenceSize: 256 | 512 = 512,\n  purpose: AIInferencePurpose = "production",\n): Promise<AIFrameResult> {',
)
replace(
    "lib/videoflow/ai/AIManager.ts",
    '      const result = await runImageInpainting(prepared.imageData, modelMask, effective, signal);',
    '      const result = await runImageInpainting(prepared.imageData, modelMask, effective, signal, purpose);',
)

# ---------------------------------------------------------------------------
# 5. Worker client: one worker/session at a time, but session identity includes
#    model id. 256 selects dynamic preview graph; 512 selects optimized final.
#    Interactive SLA stays strict; production remains bounded/cancellable but
#    gets enough CPU time to preserve 512 quality on slow WASM browsers.
# ---------------------------------------------------------------------------
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    'import { DEFAULT_AI_MODEL } from "./AIModelRegistry";',
    'import { DEFAULT_AI_MODEL, PREVIEW_AI_MODEL, modelForInferenceSize } from "./AIModelRegistry";',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    'import type { AIProvider, AISettings } from "./types";',
    'import type { AIInferencePurpose, AIModelDescriptor, AIProvider, AISettings } from "./types";',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    'const WORKER_INTERACTIVE_BUDGET_MS = 165_000;\nconst WORKER_THREADED_PROBE_TIMEOUT_MS = 30_000;\nconst WORKER_INFERENCE_TIMEOUT_MS = 125_000;',
    'const WORKER_INTERACTIVE_BUDGET_MS = 165_000;\nconst WORKER_PRODUCTION_BUDGET_MS = 420_000;\nconst WORKER_THREADED_PROBE_TIMEOUT_MS = 30_000;\nconst WORKER_INFERENCE_TIMEOUT_MS = 125_000;\nconst WORKER_PRODUCTION_INFERENCE_TIMEOUT_MS = 300_000;',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    'function timeoutWithinDeadline(deadline: number, ceilingMs: number, operation: string): number {',
    'function timeoutWithinDeadline(deadline: number, ceilingMs: number, operation: string, budgetMs: number): number {',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    '`Local AI worker ${operation} exhausted the ${Math.round(WORKER_INTERACTIVE_BUDGET_MS / 1000)} second interactive budget.`',
    '`Local AI worker ${operation} exhausted the ${Math.round(budgetMs / 1000)} second ${budgetMs === WORKER_INTERACTIVE_BUDGET_MS ? "interactive" : "production"} budget.`',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    'async function resolveWorkerPlan(settings: AISettings): Promise<WorkerPlan> {',
    'async function resolveWorkerPlan(settings: AISettings, descriptor: AIModelDescriptor): Promise<WorkerPlan> {',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    '    key: `${runtimeFile}:${providers.join(",")}:threads-${maxWasmThreads}`,',
    '    key: `${descriptor.id}:${runtimeFile}:${providers.join(",")}:threads-${maxWasmThreads}`,',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    'async function initialize(settings: AISettings, timeoutMs = WORKER_INIT_TIMEOUT_MS): Promise<AIProvider> {\n  const plan = await resolveWorkerPlan(settings);',
    'async function initialize(settings: AISettings, descriptor: AIModelDescriptor = DEFAULT_AI_MODEL, timeoutMs = WORKER_INIT_TIMEOUT_MS): Promise<AIProvider> {\n  const plan = await resolveWorkerPlan(settings, descriptor);',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    '      const model = await getAIModelBytes(DEFAULT_AI_MODEL);',
    '      const model = await getAIModelBytes(descriptor);',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    '        imageInput: DEFAULT_AI_MODEL.imageInput,\n        maskInput: DEFAULT_AI_MODEL.maskInput,\n        outputName: DEFAULT_AI_MODEL.output,',
    '        imageInput: descriptor.imageInput,\n        maskInput: descriptor.maskInput,\n        outputName: descriptor.output,',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    '  signal?: AbortSignal,\n): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {',
    '  signal?: AbortSignal,\n  purpose: AIInferencePurpose = "production",\n): Promise<{ imageData: ImageData; provider: AIProvider; inferenceMs: number }> {',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    '  const deadline = performance.now() + WORKER_INTERACTIVE_BUDGET_MS;',
    '  const modelDescriptor = modelForInferenceSize(inferenceSize);\n  const budgetMs = purpose === "interactive" ? WORKER_INTERACTIVE_BUDGET_MS : WORKER_PRODUCTION_BUDGET_MS;\n  const deadline = performance.now() + budgetMs;\n  updateAIDiagnostics({ model: modelDescriptor.name, modelVersion: modelDescriptor.version });',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    '      const provider = await initialize(\n        settings,\n        timeoutWithinDeadline(deadline, WORKER_INIT_TIMEOUT_MS, "init"),\n      );',
    '      const provider = await initialize(\n        settings,\n        modelDescriptor,\n        timeoutWithinDeadline(deadline, WORKER_INIT_TIMEOUT_MS, "init", budgetMs),\n      );',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    '      const timeoutCeiling = provider === "wasm" && activeWasmThreads > 1\n        ? WORKER_THREADED_PROBE_TIMEOUT_MS\n        : WORKER_INFERENCE_TIMEOUT_MS;\n      const timeoutMs = timeoutWithinDeadline(deadline, timeoutCeiling, "infer");',
    '      const reliableInferenceCeiling = purpose === "interactive"\n        ? WORKER_INFERENCE_TIMEOUT_MS\n        : WORKER_PRODUCTION_INFERENCE_TIMEOUT_MS;\n      const timeoutCeiling = provider === "wasm" && activeWasmThreads > 1\n        ? WORKER_THREADED_PROBE_TIMEOUT_MS\n        : reliableInferenceCeiling;\n      const timeoutMs = timeoutWithinDeadline(deadline, timeoutCeiling, "infer", budgetMs);',
)

# Remove an unused direct preview import if TypeScript/ESLint sees it later.
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    'import { DEFAULT_AI_MODEL, PREVIEW_AI_MODEL, modelForInferenceSize } from "./AIModelRegistry";',
    'import { DEFAULT_AI_MODEL, modelForInferenceSize } from "./AIModelRegistry";',
)

# ---------------------------------------------------------------------------
# 6. UI preview: WebGPU retains full 512 preview. CPU/WASM uses the dynamic 256
#    accelerator only when the complete bundled pack is installed. Final mask
#    metadata continues to name the optimized 512 production model.
# ---------------------------------------------------------------------------
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    'import { bundledAIModelAvailable, getAIModelRecord, installAIModel, installBundledAIModel, removeAIModel } from "@/lib/videoflow/ai/AIModelLoader";',
    'import { bundledAIModelAvailable, getAIModelRecord, installAIModel, installBundledAIModel, isAIModelInstalled, removeAIModel } from "@/lib/videoflow/ai/AIModelLoader";',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    'import { DEFAULT_AI_MODEL } from "@/lib/videoflow/ai/AIModelRegistry";',
    'import { DEFAULT_AI_MODEL, PREVIEW_AI_MODEL } from "@/lib/videoflow/ai/AIModelRegistry";',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    '    setBusy(true); setError(null); setProgress("Validating bundled AI model…");',
    '    setBusy(true); setError(null); setProgress("Validating bundled production + preview AI pack…");',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    '    try { setRecord(await installBundledAIModel()); setProgress("Bundled AI model installed locally and checksum verified."); }',
    '    try { setRecord(await installBundledAIModel()); setProgress("Bundled AI pack installed locally; both model checksums verified."); }',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    '      setProgress("Running local ONNX inpainting…");\n      const result = await reconstructFrame(bitmap, bitmap.width, bitmap.height, resolved, settings, null, controller.signal, 256);',
    '      setProgress("Selecting the best local neural path…");\n      const capability = await detectAICapability();\n      const fullPreviewWebGPU = capability.webgpu === "available"\n        && settings.provider !== "wasm"\n        && (settings.provider === "webgpu" || capability.recommendedProvider === "webgpu");\n      const hasPreviewAccelerator = isAIModelInstalled(PREVIEW_AI_MODEL.id);\n      const previewSize: 256 | 512 = !fullPreviewWebGPU && hasPreviewAccelerator ? 256 : 512;\n      setProgress(previewSize === 256\n        ? "Running accelerated 256×256 local WASM preview; final reconstruction remains optimized 512×512…"\n        : "Running full 512×512 local ONNX preview…");\n      const result = await reconstructFrame(bitmap, bitmap.width, bitmap.height, resolved, settings, null, controller.signal, previewSize, "interactive");',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    '      setProgress(`${result.provider.toUpperCase()} inference • ${Math.round(result.inferenceMs)} ms • ROI ${result.roi.width}×${result.roi.height} • ${result.tileCount} tile${result.tileCount === 1 ? "" : "s"}`);',
    '      setProgress(`${result.provider.toUpperCase()} inference • ${previewSize}×${previewSize} preview • ${Math.round(result.inferenceMs)} ms • ROI ${result.roi.width}×${result.roi.height} • ${result.tileCount} tile${result.tileCount === 1 ? "" : "s"} • final 512 preserved`);',
)

# ---------------------------------------------------------------------------
# 7. AI settings status/self-test: production model remains the canonical model;
#    bundled install visibly includes the preview accelerator and verifies both.
# ---------------------------------------------------------------------------
replace(
    "components/videoflow/AISettingsPanel.tsx",
    '  installBundledAIModel,\n  removeAIModel,',
    '  installBundledAIModel,\n  isAIModelInstalled,\n  removeAIModel,',
)
replace(
    "components/videoflow/AISettingsPanel.tsx",
    'import { DEFAULT_AI_MODEL } from "@/lib/videoflow/ai/AIModelRegistry";',
    'import { DEFAULT_AI_MODEL, PREVIEW_AI_MODEL } from "@/lib/videoflow/ai/AIModelRegistry";',
)
replace(
    "components/videoflow/AISettingsPanel.tsx",
    '    setStatus("Validating bundled LaMa checksum…");',
    '    setStatus("Validating bundled production + preview LaMa checksums…");',
)
replace(
    "components/videoflow/AISettingsPanel.tsx",
    '      setStatus("Model installed locally and checksum verified.");',
    '      setStatus("AI model pack installed locally and both checksums verified.");',
    expected=1,
)
replace(
    "components/videoflow/AISettingsPanel.tsx",
    '      const modelBytes = await getAIModelBytes(DEFAULT_AI_MODEL);\n      if (!modelBytes || modelBytes.byteLength !== DEFAULT_AI_MODEL.size) throw new Error("Checksum-validated model cache is unavailable or has the wrong size.");',
    '      const modelBytes = await getAIModelBytes(DEFAULT_AI_MODEL);\n      if (!modelBytes || modelBytes.byteLength !== DEFAULT_AI_MODEL.size) throw new Error("Checksum-validated production model cache is unavailable or has the wrong size.");\n      if (isAIModelInstalled(PREVIEW_AI_MODEL.id)) {\n        const previewBytes = await getAIModelBytes(PREVIEW_AI_MODEL);\n        if (!previewBytes || previewBytes.byteLength !== PREVIEW_AI_MODEL.size) throw new Error("Checksum-validated preview accelerator cache is unavailable or has the wrong size.");\n      }',
)
replace(
    "components/videoflow/AISettingsPanel.tsx",
    '<span>{installed ? `Checksum verified • ${DEFAULT_AI_MODEL.sha256.slice(0, 12)}… • ${(DEFAULT_AI_MODEL.size / 1024 / 1024).toFixed(1)} MiB` : bundled ? "Bundled model available to install" : "Model not installed"}</span>',
    '<span>{installed ? `Checksum verified • production 512${isAIModelInstalled(PREVIEW_AI_MODEL.id) ? " + 256 preview accelerator" : ""} • ${((DEFAULT_AI_MODEL.size + (isAIModelInstalled(PREVIEW_AI_MODEL.id) ? PREVIEW_AI_MODEL.size : 0)) / 1024 / 1024).toFixed(1)} MiB` : bundled ? "Bundled production + preview pack available to install" : "Model not installed"}</span>',
)

# ---------------------------------------------------------------------------
# 8. CI staging: both checksum-pinned model binaries plus local ORT runtime.
# ---------------------------------------------------------------------------
write("scripts/stage-ai-pack-ci.sh", '''#!/usr/bin/env bash
set -euo pipefail

ORT_VERSION="1.29.0"
FIXED_MODEL_URL="https://huggingface.co/g-ronimo/lama/resolve/main/lama_512_int8.onnx?download=true"
FIXED_MODEL_SHA256="cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe"
FIXED_MODEL_SIZE="62074990"
DYNAMIC_MODEL_URL="https://huggingface.co/g-ronimo/lama/resolve/main/lama_int8.onnx?download=true"
DYNAMIC_MODEL_SHA256="1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972"
DYNAMIC_MODEL_SIZE="61512617"

mkdir -p public/models public/vendor/onnx .tmp-ai-pack
node scripts/restore-large-assets.mjs --if-present

runtime_is_complete=1
for name in \
  ort.wasm.bundle.min.mjs \
  ort.webgpu.bundle.min.mjs \
  ort-wasm-simd-threaded.asyncify.mjs \
  ort-wasm-simd-threaded.asyncify.wasm \
  ort-wasm-simd-threaded.jsep.mjs \
  ort-wasm-simd-threaded.jsep.wasm \
  ort-wasm-simd-threaded.jspi.mjs \
  ort-wasm-simd-threaded.jspi.wasm \
  ort-wasm-simd-threaded.mjs \
  ort-wasm-simd-threaded.wasm
do
  [[ -s "public/vendor/onnx/${name}" ]] || runtime_is_complete=0
done

if [[ "${runtime_is_complete}" == "1" ]]; then
  echo "[ai] using bundled ONNX Runtime Web ${ORT_VERSION}"
else
  echo "[ai] staging ONNX Runtime Web ${ORT_VERSION}"
  (
    cd .tmp-ai-pack
    npm pack "onnxruntime-web@${ORT_VERSION}" --silent > package-name.txt
    tar -xzf "$(cat package-name.txt)"
  )
  for name in \
    ort.wasm.bundle.min.mjs \
    ort.webgpu.bundle.min.mjs \
    ort-wasm-simd-threaded.asyncify.mjs \
    ort-wasm-simd-threaded.asyncify.wasm \
    ort-wasm-simd-threaded.jsep.mjs \
    ort-wasm-simd-threaded.jsep.wasm \
    ort-wasm-simd-threaded.jspi.mjs \
    ort-wasm-simd-threaded.jspi.wasm \
    ort-wasm-simd-threaded.mjs \
    ort-wasm-simd-threaded.wasm
  do
    source_path=".tmp-ai-pack/package/dist/${name}"
    [[ -f "${source_path}" ]] || { echo "Missing ONNX Runtime asset: ${name}" >&2; exit 65; }
    cp "${source_path}" "public/vendor/onnx/${name}"
  done
fi

stage_model() {
  local path="$1"
  local url="$2"
  local sha="$3"
  local size="$4"
  local label="$5"
  if [[ -f "${path}" ]] \
    && [[ "$(stat -c '%s' "${path}")" == "${size}" ]] \
    && echo "${sha}  ${path}" | sha256sum --check --strict >/dev/null 2>&1; then
    echo "[ai] using bundled checksum-pinned ${label}"
  else
    echo "[ai] downloading checksum-pinned ${label}"
    curl --fail --location --retry 2 --connect-timeout 30 --max-time 300 --output "${path}" "${url}"
  fi
  echo "${sha}  ${path}" | sha256sum --check --strict
  [[ "$(stat -c '%s' "${path}")" == "${size}" ]] || { echo "${label} size mismatch" >&2; exit 65; }
}

stage_model public/models/lama-512-int8.onnx "${FIXED_MODEL_URL}" "${FIXED_MODEL_SHA256}" "${FIXED_MODEL_SIZE}" "LaMa 512 INT8 production model"
stage_model public/models/lama-dynamic-int8.onnx "${DYNAMIC_MODEL_URL}" "${DYNAMIC_MODEL_SHA256}" "${DYNAMIC_MODEL_SIZE}" "LaMa Dynamic INT8 preview model"

rm -rf .tmp-ai-pack
echo "[ai] dual-model/runtime pack staged and verified"
''')

# ---------------------------------------------------------------------------
# 9. Model metadata files and notices.
# ---------------------------------------------------------------------------
write("public/models/lama-512-int8.model.json", '''{
  "id": "lama-512-int8",
  "name": "LaMa 512 INT8",
  "role": "production-final",
  "version": "g-ronimo-8e20140",
  "license": "Apache-2.0",
  "source": "https://huggingface.co/g-ronimo/lama/blob/main/lama_512_int8.onnx",
  "sha256": "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe",
  "sizeBytes": 62074990,
  "localPath": "models/lama-512-int8.onnx",
  "input": "1x4x512x512 float32 packed RGB+mask",
  "installation": "Explicit user action installs the checksum-validated dual-model AI pack into protected local Cache Storage. The PWA shell never auto-precaches ONNX models."
}
''')
write("public/models/lama-dynamic-int8.model.json", '''{
  "id": "lama-dynamic-int8",
  "name": "LaMa Dynamic INT8",
  "role": "interactive-preview-accelerator",
  "version": "g-ronimo-dynamic",
  "license": "Apache-2.0",
  "source": "https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx",
  "sha256": "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
  "sizeBytes": 61512617,
  "localPath": "models/lama-dynamic-int8.onnx",
  "input": "1x4xHxW float32 packed RGB+mask; VideoFlow preview uses 256x256",
  "installation": "Installed alongside the optimized 512 production model after explicit user action; used only for interactive CPU/WASM preview/recovery."
}
''')
write("public/models/README.md", '''# VideoFlow AI Reconstruction Pack

VideoFlow uses two checksum-pinned Apache-2.0 LaMa ONNX models for different jobs without reducing final reconstruction quality:

- `lama-512-int8.onnx` — **production/final model**, fixed 512×512. Upstream replaces FFT operations with fixed-size matmuls and documents about 1.8× faster CPU/WASM inference than the dynamic INT8 graph with identical output.
- `lama-dynamic-int8.onnx` — **interactive preview accelerator**, arbitrary H/W. VideoFlow uses 256×256 only when an interactive preview is running on WASM; final/export reconstruction never switches down to 256.

The PWA shell does **not** automatically precache either large ONNX model. **Install bundled AI** explicitly validates both SHA-256 digests and copies the pack into protected local Cache Storage. Local runtime modules/WASM remain part of the offline app shell.
''')
write("public/models/MODEL_LICENSE_NOTICE.md", '''# LaMa model notices

VideoFlow bundles two Apache-2.0 ONNX exports from the same g-ronimo/LaMa model family:

1. **LaMa 512 INT8** (`lama_512_int8.onnx`) — production/final fixed 512×512 model.
2. **LaMa Dynamic INT8** (`lama_int8.onnx`) — interactive 256×256 preview accelerator on CPU/WASM.

Upstream project: LaMa — Resolution-robust Large Mask Inpainting with Fourier Convolutions.
Export source: https://huggingface.co/g-ronimo/lama
Declared license: Apache-2.0.

VideoFlow does not imply that neural inpainting recovers hidden original pixels; it generates plausible reconstruction from visible context.
''')

# ---------------------------------------------------------------------------
# 10. Production verifier and nested HTTP verifier require BOTH model assets.
# ---------------------------------------------------------------------------
verify = read("scripts/verify-release.mjs")
verify = verify.replace(
    '    "models/lama-dynamic-int8.onnx",\n    "models/lama-dynamic-int8.model.json",',
    '    "models/lama-512-int8.onnx",\n    "models/lama-512-int8.model.json",\n    "models/lama-dynamic-int8.onnx",\n    "models/lama-dynamic-int8.model.json",',
)
old_block = '''  const modelBytes = readFileSync(join(output, "models/lama-dynamic-int8.onnx"));
  const modelSha = createHash("sha256").update(modelBytes).digest("hex");
  assert.equal(modelSha, "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972", "AI model checksum mismatch in production dist");
  assert.equal(modelBytes.byteLength, 61512617, "AI model size mismatch in production dist");'''
new_block = '''  const modelSpecs = [
    ["models/lama-512-int8.onnx", "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe", 62074990],
    ["models/lama-dynamic-int8.onnx", "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972", 61512617],
  ];
  for (const [path, expectedSha, expectedSize] of modelSpecs) {
    const modelBytes = readFileSync(join(output, path));
    const modelSha = createHash("sha256").update(modelBytes).digest("hex");
    assert.equal(modelSha, expectedSha, `AI model checksum mismatch in production dist: ${path}`);
    assert.equal(modelBytes.byteLength, expectedSize, `AI model size mismatch in production dist: ${path}`);
  }'''
if old_block not in verify:
    raise SystemExit("verify-release model integrity block not found")
verify = verify.replace(old_block, new_block)
verify = verify.replace('    "LaMa Dynamic INT8",', '    "LaMa 512 INT8",\n    "LaMa Dynamic INT8",')
write("scripts/verify-release.mjs", verify)

nested = read("scripts/verify-nested-http.mjs")
nested = nested.replace(
    '"./models/lama-dynamic-int8.onnx", "./models/lama-dynamic-int8.model.json",',
    '"./models/lama-512-int8.onnx", "./models/lama-512-int8.model.json", "./models/lama-dynamic-int8.onnx", "./models/lama-dynamic-int8.model.json",',
)
write("scripts/verify-nested-http.mjs", nested)

upload = read("scripts/create-github-upload-kit.mjs")
upload = upload.replace(
    '{ target: "public/models/lama-dynamic-int8.onnx" },',
    '{ target: "public/models/lama-512-int8.onnx" },\n  { target: "public/models/lama-dynamic-int8.onnx" },',
)
write("scripts/create-github-upload-kit.mjs", upload)

# ---------------------------------------------------------------------------
# 11. Genuine local WASM certification: certify optimized 512 production model
#     at 512 and dynamic preview model at 256 in one local runtime, zero network.
# ---------------------------------------------------------------------------
write("scripts/certify-ai-wasm.mjs", '''import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const runtimeDirectory = join(root, "public", "vendor", "onnx");
const allowedRuntimeFiles = new Set([
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
]);
for (const file of allowedRuntimeFiles) {
  if (!existsSync(join(runtimeDirectory, file))) throw new Error(`Local ONNX runtime is incomplete: ${file}`);
}

const specs = [
  {
    role: "production-final",
    model: "LaMa 512 INT8 ONNX",
    version: "g-ronimo-8e20140",
    license: "Apache-2.0",
    path: join(root, "public", "models", "lama-512-int8.onnx"),
    sha256: "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe",
    bytes: 62_074_990,
    size: 512,
  },
  {
    role: "interactive-preview-accelerator",
    model: "LaMa Dynamic INT8 ONNX",
    version: "g-ronimo-dynamic",
    license: "Apache-2.0",
    path: join(root, "public", "models", "lama-dynamic-int8.onnx"),
    sha256: "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
    bytes: 61_512_617,
    size: 256,
  },
];

const ort = await import("../public/vendor/onnx/ort.webgpu.bundle.min.mjs");
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  mjs: pathToFileURL(join(runtimeDirectory, "ort-wasm-simd-threaded.jsep.mjs")).href,
  wasm: join(runtimeDirectory, "ort-wasm-simd-threaded.jsep.wasm"),
};

async function certify(spec) {
  const model = readFileSync(spec.path);
  if (model.byteLength !== spec.bytes) throw new Error(`${spec.model} validation failed. Size mismatch.`);
  const sha256 = createHash("sha256").update(model).digest("hex");
  if (sha256 !== spec.sha256) throw new Error(`${spec.model} validation failed. Checksum mismatch.`);

  const sessionStart = performance.now();
  const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"] });
  const sessionMs = performance.now() - sessionStart;
  const size = spec.size;
  const pixels = size * size;
  const feeds = {};
  const cleanTarget = new Float32Array(3 * pixels);
  const certificationMask = new Float32Array(pixels);
  const x0 = Math.floor(size * 0.37);
  const x1 = Math.floor(size * 0.63);
  const y0 = Math.floor(size * 0.40);
  const y1 = Math.floor(size * 0.60);

  if (session.inputNames.length === 1) {
    const packed = new Float32Array(4 * pixels);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const pixel = y * size + x;
        const hole = x >= x0 && x < x1 && y >= y0 && y < y1 ? 1 : 0;
        cleanTarget[pixel] = 0.2 + 0.6 * x / (size - 1);
        cleanTarget[pixels + pixel] = 0.25 + 0.5 * y / (size - 1);
        cleanTarget[pixels * 2 + pixel] = 0.55;
        certificationMask[pixel] = hole;
        packed[pixel] = cleanTarget[pixel] * (1 - hole);
        packed[pixels + pixel] = cleanTarget[pixels + pixel] * (1 - hole);
        packed[pixels * 2 + pixel] = cleanTarget[pixels * 2 + pixel] * (1 - hole);
        packed[pixels * 3 + pixel] = hole;
      }
    }
    feeds[session.inputNames[0]] = new ort.Tensor("float32", packed, [1, 4, size, size]);
  } else {
    const rgb = new Float32Array(3 * pixels);
    const mask = new Float32Array(pixels);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const pixel = y * size + x;
        cleanTarget[pixel] = rgb[pixel] = 0.2 + 0.6 * x / (size - 1);
        cleanTarget[pixels + pixel] = rgb[pixels + pixel] = 0.25 + 0.5 * y / (size - 1);
        cleanTarget[pixels * 2 + pixel] = rgb[pixels * 2 + pixel] = 0.55;
        mask[pixel] = x >= x0 && x < x1 && y >= y0 && y < y1 ? 1 : 0;
        certificationMask[pixel] = mask[pixel];
      }
    }
    feeds[session.inputNames[0]] = new ort.Tensor("float32", rgb, [1, 3, size, size]);
    feeds[session.inputNames[1]] = new ort.Tensor("float32", mask, [1, 1, size, size]);
  }

  const inferenceStart = performance.now();
  const output = await session.run(feeds);
  const inferenceMs = performance.now() - inferenceStart;
  const tensor = output[session.outputNames[0]] ?? Object.values(output)[0];
  if (!tensor?.data || tensor.data.length < pixels * 3) throw new Error(`${spec.model} returned an invalid output tensor.`);
  const sampled = Array.from({ length: 64 }, (_, index) => Number(tensor.data[Math.floor(index * tensor.data.length / 64)]));
  if (!sampled.every(Number.isFinite)) throw new Error(`${spec.model} produced non-finite output values.`);
  const outputScale = Math.max(...sampled.map(Math.abs)) <= 1.5 ? 255 : 1;

  let samples = 0;
  let squaredError = 0;
  let actualMean = 0;
  let targetMean = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (certificationMask[pixel] < 0.5) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = channel * pixels + pixel;
      const actual = Math.max(0, Math.min(255, Number(tensor.data[index]) * outputScale));
      const target = cleanTarget[index] * 255;
      squaredError += (actual - target) ** 2;
      actualMean += actual;
      targetMean += target;
      samples += 1;
    }
  }
  actualMean /= samples;
  targetMean /= samples;
  let actualVariance = 0;
  let targetVariance = 0;
  let covariance = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (certificationMask[pixel] < 0.5) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = channel * pixels + pixel;
      const actual = Math.max(0, Math.min(255, Number(tensor.data[index]) * outputScale));
      const target = cleanTarget[index] * 255;
      actualVariance += (actual - actualMean) ** 2;
      targetVariance += (target - targetMean) ** 2;
      covariance += (actual - actualMean) * (target - targetMean);
    }
  }
  const mse = squaredError / samples;
  const psnr = mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10(255 ** 2 / mse);
  actualVariance /= Math.max(1, samples - 1);
  targetVariance /= Math.max(1, samples - 1);
  covariance /= Math.max(1, samples - 1);
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const ssim = ((2 * actualMean * targetMean + c1) * (2 * covariance + c2)) /
    ((actualMean ** 2 + targetMean ** 2 + c1) * (actualVariance + targetVariance + c2));
  if (psnr < 10 || ssim < 0.2) {
    throw new Error(`${spec.model} controlled quality regression: PSNR ${psnr.toFixed(2)} dB, SSIM ${ssim.toFixed(4)}.`);
  }

  const evidence = {
    role: spec.role,
    model: spec.model,
    version: spec.version,
    license: spec.license,
    modelBytes: model.byteLength,
    modelSha256: sha256,
    inputSize: size,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    outputElements: tensor.data.length,
    sessionMs,
    inferenceMs,
    controlledMaskedPsnrDb: psnr,
    controlledMaskedSsim: ssim,
  };
  await session.release();
  return evidence;
}

const productionModel = await certify(specs[0]);
const previewModel = await certify(specs[1]);
const evidence = {
  certifiedAt: new Date().toISOString(),
  runtime: "ONNX Runtime Web 1.29.0 local bundle",
  provider: "wasm",
  productionModel,
  previewModel,
  finalInferenceSize: 512,
  interactiveWasmPreviewSize: 256,
  qualityThresholds: { minimumPsnrDb: 10, minimumSsim: 0.2 },
  remoteRequests: 0,
};
mkdirSync(join(root, "ci-results"), { recursive: true });
writeFileSync(join(root, "ci-results", "ai-wasm-certification.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
''')

# ---------------------------------------------------------------------------
# 12. Final certification must consume actual dual-model WASM evidence instead
#     of hard-coding one model identity.
# ---------------------------------------------------------------------------
finalizer = read("scripts/finalize-ci-certification.mjs")
finalizer = finalizer.replace(
    'const realLargeEvidencePath = join(root, "ci-results", "real-large-media-fixture.json");',
    'const realLargeEvidencePath = join(root, "ci-results", "real-large-media-fixture.json");\nconst aiWasmEvidencePath = join(root, "ci-results", "ai-wasm-certification.json");',
)
finalizer = finalizer.replace(
    'if (!existsSync(evidencePath)) fail(`Missing browser capability evidence: ${evidencePath}`);',
    'if (!existsSync(evidencePath)) fail(`Missing browser capability evidence: ${evidencePath}`);\nif (!existsSync(aiWasmEvidencePath)) fail(`Missing dual-model WASM certification evidence: ${aiWasmEvidencePath}`);',
)
old_model = '''const model = {
  name: "LaMa Dynamic INT8 ONNX",
  version: "g-ronimo / 8e20140-compatible descriptor",
  sha256: "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
  license: "Apache-2.0",
  size: "62.1 MB",
  runtime: "ONNX Runtime Web 1.29.0",
};'''
new_model = '''const aiWasm = JSON.parse(readFileSync(aiWasmEvidencePath, "utf8"));
const model = {
  name: aiWasm.productionModel.model,
  version: aiWasm.productionModel.version,
  sha256: aiWasm.productionModel.modelSha256,
  license: aiWasm.productionModel.license,
  size: `${(aiWasm.productionModel.modelBytes / 1024 / 1024).toFixed(1)} MiB`,
  runtime: aiWasm.runtime,
};
const previewModel = {
  name: aiWasm.previewModel.model,
  version: aiWasm.previewModel.version,
  sha256: aiWasm.previewModel.modelSha256,
  license: aiWasm.previewModel.license,
  size: `${(aiWasm.previewModel.modelBytes / 1024 / 1024).toFixed(1)} MiB`,
};'''
if old_model not in finalizer:
    raise SystemExit("finalize-ci-certification model block not found")
finalizer = finalizer.replace(old_model, new_model)
finalizer = finalizer.replace(
    '- Model: **${model.name}**\n- Model version: ${model.version}\n- License: ${model.license}\n- Model SHA-256: \\`${model.sha256}\\`\n- Model size: ${model.size}',
    '- Production/final model: **${model.name}**\n- Production model version: ${model.version}\n- Production model SHA-256: \\`${model.sha256}\\`\n- Production model size: ${model.size}\n- Interactive WASM preview accelerator: **${previewModel.name}**\n- Preview model version: ${previewModel.version}\n- Preview model SHA-256: \\`${previewModel.sha256}\\`\n- Preview model size: ${previewModel.size}\n- License: ${model.license}',
)
finalizer = finalizer.replace(
    '- Neural input contract: one \\`[1,4,512,512]\\` tensor (masked RGB + binary mask)',
    '- Neural input contract: final/high-quality uses \\`[1,4,512,512]\\`; interactive CPU/WASM still preview may use \\`[1,4,256,256]\\` with the separate dynamic accelerator',
)
finalizer = finalizer.replace(
    '- Model: ${model.name}\n- Source family: g-ronimo/lama browser-oriented ONNX export\n- License: ${model.license}\n- Version descriptor: ${model.version}\n- Size: ${model.size}\n- SHA-256: \\`${model.sha256}\\`\n- Input: \\`[1,4,512,512]\\` (masked RGB channels + binary mask)\n- Output: \\`[1,3,512,512]\\`',
    '- Production/final model: ${model.name} — ${model.size} — SHA-256 \\`${model.sha256}\\`\n- Interactive WASM preview accelerator: ${previewModel.name} — ${previewModel.size} — SHA-256 \\`${previewModel.sha256}\\`\n- Source family: g-ronimo/lama browser-oriented ONNX exports\n- License: ${model.license}\n- Final input/output: \\`[1,4,512,512]\\` → \\`[1,3,512,512]\\`\n- Interactive CPU/WASM preview accelerator input/output: \\`[1,4,256,256]\\` → \\`[1,3,256,256]\\`',
)
finalizer = finalizer.replace(
    '→ 512×512 neural input\n→ LaMa ONNX inference in module worker',
    '→ 512×512 production neural input (final/export) OR 256×256 dynamic accelerator (interactive CPU/WASM still preview only)\n→ checksum-pinned LaMa ONNX inference in module worker',
)
finalizer = finalizer.replace(
    '  model,\n  releaseStatus: "READY",',
    '  model,\n  previewModel,\n  aiWasm,\n  releaseStatus: "READY",',
)
write("scripts/finalize-ci-certification.mjs", finalizer)

# ---------------------------------------------------------------------------
# 13. Tests: assert the no-sacrifice model split, model-aware worker switching,
#     strict interactive budget, longer bounded production budget, pack storage,
#     dual certification and both release assets.
# ---------------------------------------------------------------------------
write("tests/adaptive-ai-model.test.mjs", r'''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("dual LaMa pack preserves optimized 512 final model and pins dynamic preview accelerator", async () => {
  const registry = await read("lib/videoflow/ai/AIModelRegistry.ts");
  assert.match(registry, /LAMA_512_INT8/);
  assert.match(registry, /lama-512-int8/);
  assert.match(registry, /cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe/);
  assert.match(registry, /size:\s*62074990/);
  assert.match(registry, /LAMA_DYNAMIC_INT8/);
  assert.match(registry, /lama-dynamic-int8/);
  assert.match(registry, /1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972/);
  assert.match(registry, /size:\s*61512617/);
  assert.match(registry, /DEFAULT_AI_MODEL = LAMA_512_INT8/);
  assert.match(registry, /PREVIEW_AI_MODEL = LAMA_DYNAMIC_INT8/);
});

test("interactive WASM preview may use 256 while final reconstruction defaults to optimized 512", async () => {
  const manager = await read("lib/videoflow/ai/AIManager.ts");
  const controls = await read("components/videoflow/AIWatermarkControls.tsx");
  assert.match(manager, /inferenceSize:\s*256 \| 512 = 512/);
  assert.match(manager, /purpose:\s*AIInferencePurpose = "production"/);
  assert.match(manager, /extractROI\(source, plan\.roi, inferenceSize, inferenceSize\)/);
  assert.match(controls, /const previewSize: 256 \| 512/);
  assert.match(controls, /capability\.webgpu === "available"/);
  assert.match(controls, /isAIModelInstalled\(PREVIEW_AI_MODEL\.id\)/);
  assert.match(controls, /previewSize, "interactive"/);
  assert.match(controls, /final 512 preserved/);
});

test("worker session identity includes model and selects model by inference size", async () => {
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  const worker = await read("workers/ai-inference.worker.ts");
  assert.match(client, /modelForInferenceSize\(inferenceSize\)/);
  assert.match(client, /descriptor\.id.*runtimeFile/);
  assert.match(client, /getAIModelBytes\(descriptor\)/);
  assert.match(client, /size: inferenceSize/);
  assert.match(worker, /size: 256 \| 512/);
  assert.match(worker, /const size = data\.size/);
  assert.doesNotMatch(worker, /let size = 512/);
});

test("model cache stores a complete explicitly installed dual pack and keeps models outside core precache", async () => {
  const loader = await read("lib/videoflow/ai/AIModelLoader.ts");
  const sw = await read("public/service-worker.js");
  assert.match(loader, /AI_MODELS/);
  assert.match(loader, /installedModelIds/);
  assert.match(loader, /validateModelBytes/);
  assert.match(loader, /ensureStorageHeadroom/);
  assert.match(loader, /Promise\.all\(AI_MODELS\.map/);
  assert.match(loader, /isAIModelInstalled/);
  assert.match(sw, /videoflow-ai-/);
  assert.match(sw, /models/);
});

test("interactive watchdog remains strict while production 512 gets a separate bounded worker budget", async () => {
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  assert.match(client, /WORKER_INTERACTIVE_BUDGET_MS = 165_000/);
  assert.match(client, /WORKER_PRODUCTION_BUDGET_MS = 420_000/);
  assert.match(client, /WORKER_THREADED_PROBE_TIMEOUT_MS = 30_000/);
  assert.match(client, /WORKER_INFERENCE_TIMEOUT_MS = 125_000/);
  assert.match(client, /WORKER_PRODUCTION_INFERENCE_TIMEOUT_MS = 300_000/);
  assert.match(client, /purpose === "interactive"/);
  assert.match(client, /persistSingleThreadWasmProfile/);
  assert.doesNotMatch(client, /userAgent|firefox|Firefox/);
});

test("release certification executes genuine fixed-512 and dynamic-256 WASM sessions", async () => {
  const cert = await read("scripts/certify-ai-wasm.mjs");
  assert.match(cert, /lama-512-int8\.onnx/);
  assert.match(cert, /lama-dynamic-int8\.onnx/);
  assert.match(cert, /size: 512/);
  assert.match(cert, /size: 256/);
  assert.match(cert, /InferenceSession\.create/);
  assert.match(cert, /session\.run\(feeds\)/);
  assert.match(cert, /productionModel/);
  assert.match(cert, /previewModel/);
  assert.match(cert, /remoteRequests: 0/);
});
''')

ai_test = read("tests/ai-reconstruction.test.mjs")
ai_test = ai_test.replace('assert.match(source, /LaMa Dynamic INT8/);', 'assert.match(source, /LaMa 512 INT8/);\n  assert.match(source, /LaMa Dynamic INT8/);')
ai_test = ai_test.replace('assert.match(source, /1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972/);', 'assert.match(source, /cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe/);\n  assert.match(source, /1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972/);')
ai_test = ai_test.replace('assert.match(controls, /reconstructFrame\\(bitmap,[\\s\\S]*controller\\.signal, 256\\)/);', 'assert.match(controls, /const previewSize: 256 \\| 512/);\n  assert.match(controls, /previewSize, "interactive"/);')
write("tests/ai-reconstruction.test.mjs", ai_test)

runtime_test = read("tests/onnx-runtime-selection.test.mjs")
runtime_test = runtime_test.replace(
    '  assert.match(client, /WORKER_INTERACTIVE_BUDGET_MS = 165_000/);',
    '  assert.match(client, /WORKER_INTERACTIVE_BUDGET_MS = 165_000/);\n  assert.match(client, /WORKER_PRODUCTION_BUDGET_MS = 420_000/);\n  assert.match(client, /WORKER_PRODUCTION_INFERENCE_TIMEOUT_MS = 300_000/);',
)
runtime_test = runtime_test.replace(
    '  assert.match(client, /const deadline = performance\\.now\\(\\) \\+ WORKER_INTERACTIVE_BUDGET_MS/);',
    '  assert.match(client, /const budgetMs = purpose === "interactive"/);\n  assert.match(client, /const deadline = performance\\.now\\(\\) \\+ budgetMs/);',
)
runtime_test = runtime_test.replace(
    '  assert.match(client, /timeoutWithinDeadline\\(deadline, WORKER_INIT_TIMEOUT_MS, "init"\\)/);\n  assert.match(client, /timeoutWithinDeadline\\(deadline, timeoutCeiling, "infer"\\)/);',
    '  assert.match(client, /timeoutWithinDeadline\\(deadline, WORKER_INIT_TIMEOUT_MS, "init", budgetMs\\)/);\n  assert.match(client, /timeoutWithinDeadline\\(deadline, timeoutCeiling, "infer", budgetMs\\)/);',
)
write("tests/onnx-runtime-selection.test.mjs", runtime_test)

browser_reg = read("tests/final-browser-regressions.test.mjs")
browser_reg = browser_reg.replace('assert.match(client, /WORKER_INFERENCE_TIMEOUT_MS = 125_000/);', 'assert.match(client, /WORKER_INFERENCE_TIMEOUT_MS = 125_000/);\n  assert.match(client, /WORKER_PRODUCTION_INFERENCE_TIMEOUT_MS = 300_000/);')
write("tests/final-browser-regressions.test.mjs", browser_reg)

upload_test = read("tests/github-upload-assets.test.mjs")
upload_test = upload_test.replace(
    '      "public/models/lama-dynamic-int8.onnx",',
    '      "public/models/lama-512-int8.onnx",\n      "public/models/lama-dynamic-int8.onnx",',
)
write("tests/github-upload-assets.test.mjs", upload_test)

# E2E offline assertion once again reflects canonical production model identity.
e2e = read("tests/e2e/videoflow.spec.ts")
e2e = e2e.replace('await expect(page.getByText(/LaMa Dynamic INT8/)).toBeVisible();', 'await expect(page.getByText(/LaMa 512 INT8/)).toBeVisible();')
write("tests/e2e/videoflow.spec.ts", e2e)

# ---------------------------------------------------------------------------
# 14. Human docs: concise source-of-truth explanation. Generated certification
#     docs will later be overwritten from actual successful runner evidence.
# ---------------------------------------------------------------------------
for path in ["AI_RECONSTRUCTION.md", "docs/ai-reconstruction.md"]:
    if not (ROOT / path).exists():
        continue
    text = read(path)
    text = text.replace("LaMa Dynamic INT8 ONNX", "LaMa 512 INT8 ONNX (production/final) + LaMa Dynamic INT8 ONNX (interactive WASM preview accelerator)")
    text = text.replace("models/lama-dynamic-int8.onnx", "models/lama-512-int8.onnx + models/lama-dynamic-int8.onnx")
    write(path, text)

for path in ["README.md", "START_HERE.md", "models/README.md"]:
    if not (ROOT / path).exists():
        continue
    text = read(path)
    text = text.replace("checksum-pinned LaMa Dynamic INT8", "checksum-pinned dual LaMa pack (optimized 512 final + dynamic 256 WASM preview accelerator)")
    text = text.replace("checksum-pinned LaMa 512 INT8 model", "checksum-pinned dual LaMa pack (optimized 512 final + dynamic preview accelerator)")
    write(path, text)

print("dual LaMa no-sacrifice migration applied")
