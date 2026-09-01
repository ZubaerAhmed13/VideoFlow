from pathlib import Path
import json

OLD_ID = "lama-512-int8"
NEW_ID = "lama-dynamic-int8"
OLD_NAME = "LaMa 512 INT8"
NEW_NAME = "LaMa Dynamic INT8"
OLD_SHA = "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe"
NEW_SHA = "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972"
OLD_SIZE = "62074990"
NEW_SIZE = "61512617"
OLD_VERSION = "g-ronimo-8e20140"
NEW_VERSION = "sha256-1941214c"
OLD_SOURCE_FILE = "lama_512_int8.onnx"
NEW_SOURCE_FILE = "lama_int8.onnx"


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, value: str) -> None:
    Path(path).write_text(value)


# Canonical dynamic model descriptor. 512 remains the default/final inference
# size; interactive previews explicitly request 256.
write(
    "lib/videoflow/ai/AIModelRegistry.ts",
    '''import type { AIModelDescriptor } from "./types";

// Apache-2.0 quantized LaMa export with dynamic spatial dimensions.
// VideoFlow uses 256×256 for interactive preview latency and 512×512 for
// final/high-quality reconstruction. Both sizes execute the same neural model.
export const LAMA_DYNAMIC_INT8: AIModelDescriptor = {
  id: "lama-dynamic-int8",
  name: "LaMa Dynamic INT8",
  version: "sha256-1941214c",
  license: "Apache-2.0",
  source: "https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx",
  sha256: "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
  size: 61512617,
  inputWidth: 512,
  inputHeight: 512,
  imageInput: "input",
  maskInput: "",
  output: "output",
};

export const AI_MODELS = [LAMA_DYNAMIC_INT8] as const;
export const DEFAULT_AI_MODEL = LAMA_DYNAMIC_INT8;
''',
)

# Cache v2 prevents stale fixed-model bytes/metadata from being treated as the
# newly checksum-pinned dynamic model.
write(
    "lib/videoflow/ai/AIModelLoader.ts",
    '''import { DEFAULT_AI_MODEL } from "./AIModelRegistry";
import { deploymentAssetUrl } from "../base-url";
import type { AIModelDescriptor, AIModelInstallRecord } from "./types";

const MODEL_CACHE = "videoflow-ai-models-v2";
const MODEL_RECORD = "videoflow-ai-model-record-v2";
const LEGACY_MODEL_CACHE = "videoflow-ai-models-v1";
const LEGACY_MODEL_RECORD = "videoflow-ai-model-record";
const modelUrl = (id: string) => deploymentAssetUrl(`models/${id}.onnx`);

async function digestHex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function storeVerifiedModel(bytes: ArrayBuffer, descriptor: AIModelDescriptor): Promise<AIModelInstallRecord> {
  if (bytes.byteLength !== descriptor.size) throw new Error(`AI model validation failed. Expected ${descriptor.size} bytes, received ${bytes.byteLength}.`);
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    const available = Math.max(0, Number(estimate.quota ?? 0) - Number(estimate.usage ?? 0));
    const required = Math.ceil(bytes.byteLength * 1.2) + 64 * 1024 * 1024;
    if (estimate.quota && available < required) {
      throw new Error(`AI model installation needs about ${Math.ceil(required / 1024 / 1024)} MiB of free browser storage; only ${Math.floor(available / 1024 / 1024)} MiB is available.`);
    }
  }
  const checksum = await digestHex(bytes);
  if (checksum !== descriptor.sha256) throw new Error(`AI model validation failed. Expected ${descriptor.sha256}, received ${checksum}.`);
  const cache = await caches.open(MODEL_CACHE);
  await cache.put(modelUrl(descriptor.id), new Response(bytes, { headers: { "content-type": "application/octet-stream", "x-videoflow-sha256": checksum } }));
  const record: AIModelInstallRecord = { descriptor, state: "installed", installedAt: new Date().toISOString(), verifiedAt: new Date().toISOString() };
  localStorage.setItem(MODEL_RECORD, JSON.stringify(record));
  await caches.delete(LEGACY_MODEL_CACHE);
  localStorage.removeItem(LEGACY_MODEL_RECORD);
  return record;
}

export async function installBundledAIModel(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<AIModelInstallRecord> {
  const response = await fetch(modelUrl(descriptor.id), { cache: "no-store" });
  if (!response.ok) throw new Error("Bundled AI model pack is not available in this build.");
  return storeVerifiedModel(await response.arrayBuffer(), descriptor);
}

export async function bundledAIModelAvailable(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<boolean> {
  try {
    const response = await fetch(modelUrl(descriptor.id), { method: "HEAD", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

export async function installAIModel(file: File, descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<AIModelInstallRecord> {
  return storeVerifiedModel(await file.arrayBuffer(), descriptor);
}

export function getAIModelRecord(): AIModelInstallRecord {
  try {
    const record = JSON.parse(localStorage.getItem(MODEL_RECORD) ?? "null") as AIModelInstallRecord | null;
    if (!record) return { descriptor: DEFAULT_AI_MODEL, state: "not-installed" };
    if (
      record.descriptor?.id !== DEFAULT_AI_MODEL.id
      || record.descriptor?.sha256 !== DEFAULT_AI_MODEL.sha256
      || record.descriptor?.size !== DEFAULT_AI_MODEL.size
    ) return { descriptor: DEFAULT_AI_MODEL, state: "not-installed" };
    return record;
  } catch {
    return { descriptor: DEFAULT_AI_MODEL, state: "error", error: "Stored AI model metadata is invalid." };
  }
}

export async function getAIModelBytes(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<ArrayBuffer | null> {
  const response = await (await caches.open(MODEL_CACHE)).match(modelUrl(descriptor.id));
  if (!response) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== descriptor.size) throw new Error("AI model validation failed. Cached model size mismatch.");
  const checksum = await digestHex(bytes);
  if (checksum !== descriptor.sha256) throw new Error("AI model validation failed. Cached checksum mismatch.");
  return bytes;
}

export async function removeAIModel(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<void> {
  await (await caches.open(MODEL_CACHE)).delete(modelUrl(descriptor.id));
  await caches.delete(LEGACY_MODEL_CACHE);
  localStorage.removeItem(MODEL_RECORD);
  localStorage.removeItem(LEGACY_MODEL_RECORD);
}
''',
)

# Diagnostics expose the actual neural input dimension.
source = read("lib/videoflow/ai/AIDiagnostics.ts")
source = source.replace("  inferenceROI: string;\n", "  inferenceROI: string;\n  inferenceInput: string;\n")
source = source.replace(
    '  model: "LaMa 512 INT8",\n  modelVersion: "g-ronimo-8e20140",',
    '  model: "LaMa Dynamic INT8",\n  modelVersion: "sha256-1941214c",',
)
source = source.replace("  inferenceROI: \"not run\",\n", "  inferenceROI: \"not run\",\n  inferenceInput: \"not run\",\n")
if "inferenceInput: string" not in source or NEW_NAME not in source:
    raise SystemExit("AIDiagnostics adaptive patch incomplete")
write("lib/videoflow/ai/AIDiagnostics.ts", source)

# reconstructFrame defaults to 512 for final/high-quality callers. The
# Watermark Studio preview opts into 256 explicitly.
source = read("lib/videoflow/ai/AIManager.ts")
old_sig = "  context?: TemporalNeighborhood | TemporalFrame[] | null,\n  signal?: AbortSignal,\n): Promise<AIFrameResult> {"
new_sig = "  context?: TemporalNeighborhood | TemporalFrame[] | null,\n  signal?: AbortSignal,\n  inferenceSize: 256 | 512 = 512,\n): Promise<AIFrameResult> {"
if source.count(old_sig) != 1:
    raise SystemExit("AIManager reconstructFrame signature guard failed")
source = source.replace(old_sig, new_sig)
source = source.replace(
    "      const prepared = extractROI(source, plan.roi, 512, 512);",
    "      const prepared = extractROI(source, plan.roi, inferenceSize, inferenceSize);",
)
source = source.replace(
    "      inferenceROI: `${Math.round(roi.width)}×${Math.round(roi.height)}` ,",
    "      inferenceROI: `${Math.round(roi.width)}×${Math.round(roi.height)}` ,\n      inferenceInput: `${inferenceSize}×${inferenceSize}` ,",
)
# Repository formatting has no space before the comma; handle the exact form.
source = source.replace(
    "      inferenceROI: `${Math.round(roi.width)}×${Math.round(roi.height)}` ,\n",
    "      inferenceROI: `${Math.round(roi.width)}×${Math.round(roi.height)}`,\n",
)
if "inferenceInput:" not in source:
    source = source.replace(
        "      inferenceROI: `${Math.round(roi.width)}×${Math.round(roi.height)}`,\n",
        "      inferenceROI: `${Math.round(roi.width)}×${Math.round(roi.height)}`,\n      inferenceInput: `${inferenceSize}×${inferenceSize}`,\n",
    )
if "extractROI(source, plan.roi, inferenceSize, inferenceSize)" not in source or "inferenceSize: 256 | 512 = 512" not in source or "inferenceInput:" not in source:
    raise SystemExit("AIManager inference-size patch incomplete")
write("lib/videoflow/ai/AIManager.ts", source)

controls = read("components/videoflow/AIWatermarkControls.tsx")
old_call = "const result = await reconstructFrame(bitmap, bitmap.width, bitmap.height, resolved, settings, null, controller.signal);"
new_call = "const result = await reconstructFrame(bitmap, bitmap.width, bitmap.height, resolved, settings, null, controller.signal, 256);"
if controls.count(old_call) != 1:
    raise SystemExit("AIWatermarkControls preview call guard failed")
write("components/videoflow/AIWatermarkControls.tsx", controls.replace(old_call, new_call))

# Worker sessions are keyed by tensor size. Switching preview↔final creates a
# fresh session while retaining the same dynamic model bytes.
client = read("lib/videoflow/ai/AIWorkerClient.ts")
client = client.replace(
    "  maxWasmThreads: number;\n};",
    "  maxWasmThreads: number;\n  modelSize: 256 | 512;\n};",
)
client = client.replace(
    "async function resolveWorkerPlan(settings: AISettings): Promise<WorkerPlan> {",
    "async function resolveWorkerPlan(settings: AISettings, modelSize: 256 | 512): Promise<WorkerPlan> {",
)
client = client.replace(
    '    key: `${runtimeFile}:${providers.join(",")}:threads-${maxWasmThreads}`,',
    '    key: `${runtimeFile}:${providers.join(",")}:threads-${maxWasmThreads}:size-${modelSize}`,',
)
old_return = "    runtimeFile,\n    providers,\n    maxWasmThreads,\n  };"
new_return = "    runtimeFile,\n    providers,\n    maxWasmThreads,\n    modelSize,\n  };"
if client.count(old_return) != 1:
    raise SystemExit("AIWorkerClient plan return guard failed")
client = client.replace(old_return, new_return)
old_init = "async function initialize(settings: AISettings, timeoutMs = WORKER_INIT_TIMEOUT_MS): Promise<AIProvider> {\n  const plan = await resolveWorkerPlan(settings);"
new_init = "async function initialize(\n  settings: AISettings,\n  modelSize: 256 | 512 = 512,\n  timeoutMs = WORKER_INIT_TIMEOUT_MS,\n): Promise<AIProvider> {\n  const plan = await resolveWorkerPlan(settings, modelSize);"
if client.count(old_init) != 1:
    raise SystemExit("AIWorkerClient initialize guard failed")
client = client.replace(old_init, new_init)
client = client.replace("        size: DEFAULT_AI_MODEL.inputWidth,", "        size: plan.modelSize,")
old_start = '  if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");\n  const deadline = performance.now() + WORKER_INTERACTIVE_BUDGET_MS;'
new_start = '  if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");\n  if (image.width !== image.height || (image.width !== 256 && image.width !== 512)) {\n    throw new Error("Local LaMa inference requires a square 256×256 or 512×512 prepared ROI.");\n  }\n  if (mask.length !== image.width * image.height) throw new Error("AI mask dimensions do not match the prepared ROI.");\n  const modelSize = image.width as 256 | 512;\n  const deadline = performance.now() + WORKER_INTERACTIVE_BUDGET_MS;'
if client.count(old_start) != 1:
    raise SystemExit("AIWorkerClient inpainting start guard failed")
client = client.replace(old_start, new_start)
old_attempt = '      const provider = await initialize(\n        settings,\n        timeoutWithinDeadline(deadline, WORKER_INIT_TIMEOUT_MS, "init"),\n      );'
new_attempt = '      const provider = await initialize(\n        settings,\n        modelSize,\n        timeoutWithinDeadline(deadline, WORKER_INIT_TIMEOUT_MS, "init"),\n      );'
if client.count(old_attempt) != 1:
    raise SystemExit("AIWorkerClient attempt initialization guard failed")
client = client.replace(old_attempt, new_attempt)
required_client = [
    ":size-${modelSize}",
    "modelSize: 256 | 512",
    "size: plan.modelSize",
    "const modelSize = image.width as 256 | 512",
    "mask.length !== image.width * image.height",
]
if not all(token in client for token in required_client):
    raise SystemExit("AIWorkerClient size-aware patch incomplete")
write("lib/videoflow/ai/AIWorkerClient.ts", client)

# Diagnostics UI shows adaptive resolution.
panel = read("components/videoflow/DiagnosticsPanel.tsx")
old = '<div><span>Inference ROI</span><b>{diagnostics.inferenceROI}</b></div>'
new = '<div><span>Inference ROI</span><b>{diagnostics.inferenceROI}</b></div>\n        <div><span>Inference input</span><b>{diagnostics.inferenceInput}</b></div>'
if panel.count(old) != 1:
    raise SystemExit("DiagnosticsPanel inference ROI marker guard failed")
write("components/videoflow/DiagnosticsPanel.tsx", panel.replace(old, new))

# Release staging/certification switch to the dynamic model. Certification
# deliberately remains a genuine 512×512 final-quality inference.
stage = read("scripts/stage-ai-pack-ci.sh")
stage = stage.replace("lama_512_int8.onnx?download=true", "lama_int8.onnx?download=true")
stage = stage.replace(OLD_SHA, NEW_SHA).replace(OLD_SIZE, NEW_SIZE).replace(OLD_ID, NEW_ID)
if NEW_SHA not in stage or f"public/models/{NEW_ID}.onnx" not in stage:
    raise SystemExit("stage-ai-pack-ci dynamic patch incomplete")
write("scripts/stage-ai-pack-ci.sh", stage)

for path in [
    "scripts/certify-ai-wasm.mjs",
    "scripts/verify-release.mjs",
    "scripts/verify-nested-http.mjs",
    "scripts/create-github-upload-kit.mjs",
    "tests/github-upload-assets.test.mjs",
]:
    source = read(path)
    source = source.replace(OLD_ID, NEW_ID).replace(OLD_NAME, NEW_NAME).replace(OLD_SHA, NEW_SHA)
    source = source.replace(OLD_SIZE, NEW_SIZE).replace("62_074_990", "61_512_617").replace("62,074,990", "61,512,617")
    write(path, source)

cert = read("scripts/certify-ai-wasm.mjs")
if "const size = 512;" not in cert or NEW_SHA not in cert or NEW_ID not in cert:
    raise SystemExit("WASM certification must remain checksum-pinned at 512")

# Rename/rewrite metadata.
old_meta = Path(f"public/models/{OLD_ID}.model.json")
new_meta = Path(f"public/models/{NEW_ID}.model.json")
if not old_meta.exists():
    raise SystemExit("Old model metadata missing")
old_meta.rename(new_meta)
new_meta.write_text(
    json.dumps(
        {
            "id": NEW_ID,
            "name": NEW_NAME,
            "version": NEW_VERSION,
            "license": "Apache-2.0",
            "source": "https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx",
            "sha256": NEW_SHA,
            "sizeBytes": 61512617,
            "localPath": f"models/{NEW_ID}.onnx",
            "input": "Dynamic 1x4xHxW float32 packed RGB+mask; 256x256 interactive preview, 512x512 final/high-quality reconstruction",
            "installation": "Explicit user action copies the checksum-validated bundled model into protected local Cache Storage. The PWA shell never auto-downloads the model.",
        },
        indent=2,
    )
    + "\n"
)

# Update current model docs/notices. Historical release-certification snapshots
# are intentionally left untouched until a new authoritative release is green.
for path in [
    "README.md",
    "START_HERE.md",
    "models/README.md",
    "public/models/README.md",
    "public/models/MODEL_LICENSE_NOTICE.md",
    "AI_RECONSTRUCTION.md",
    "docs/ai-reconstruction.md",
]:
    source = read(path)
    source = source.replace(OLD_ID, NEW_ID).replace(OLD_NAME, NEW_NAME)
    source = source.replace(OLD_SHA, NEW_SHA).replace(OLD_SIZE, NEW_SIZE).replace("62,074,990", "61,512,617")
    source = source.replace(OLD_VERSION, NEW_VERSION).replace(OLD_SOURCE_FILE, NEW_SOURCE_FILE)
    source = source.replace("512x512 quantized", "dynamic-resolution quantized")
    source = source.replace("512×512 quantized", "dynamic-resolution quantized")
    write(path, source)

# E2E model identity.
e2e = read("tests/e2e/videoflow.spec.ts").replace(OLD_NAME, NEW_NAME)
write("tests/e2e/videoflow.spec.ts", e2e)

# Source-level regressions.
tests = read("tests/ai-reconstruction.test.mjs")
tests = tests.replace("/LaMa 512 INT8/", "/LaMa Dynamic INT8/")
tests = tests.replace(OLD_SHA, NEW_SHA)
tests = tests.replace(
    "/extractROI\\(source, plan\\.roi, 512, 512\\)/",
    "/extractROI\\(source, plan\\.roi, inferenceSize, inferenceSize\\)/",
)
tests = tests.replace("/lama-512-int8\\.onnx/", "/lama-dynamic-int8\\.onnx/")
tests = tests.replace("/videoflow-ai-models-v1/", "/videoflow-ai-models-v2/")
anchor = 'test("AI model install verifies SHA-256 and persists model in a protected local cache", async () => {'
adaptive_test = '''test("adaptive LaMa uses 256 preview while final reconstruction defaults to 512", async () => {
  const manager = await read("lib/videoflow/ai/AIManager.ts");
  const controls = await read("components/videoflow/AIWatermarkControls.tsx");
  const finalRender = await read("lib/videoflow/ai/VideoInpainter.ts");
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  const certification = await read("scripts/certify-ai-wasm.mjs");
  assert.match(manager, /inferenceSize: 256 \\| 512 = 512/);
  assert.match(manager, /extractROI\\(source, plan\\.roi, inferenceSize, inferenceSize\\)/);
  assert.match(controls, /reconstructFrame\\(bitmap,[\\s\\S]*controller\\.signal, 256\\)/);
  assert.match(finalRender, /reconstructFrame\\([\\s\\S]*signal\\)/);
  assert.match(client, /size-\\$\\{modelSize\\}/);
  assert.match(client, /size: plan\\.modelSize/);
  assert.match(client, /image\\.width !== 256 && image\\.width !== 512/);
  assert.match(certification, /const size = 512/);
  assert.doesNotMatch(client, /userAgent|firefox|Firefox/);
});

'''
if anchor not in tests:
    raise SystemExit("ai-reconstruction adaptive test anchor missing")
tests = tests.replace(anchor, adaptive_test + anchor)
write("tests/ai-reconstruction.test.mjs", tests)

final_reg = read("tests/final-browser-regressions.test.mjs")
marker = 'test("AI worker supervision bounds runtime init/inference and retries stalled threaded WASM once", async () => {'
adaptive_final = '''test("adaptive dynamic LaMa keeps preview fast and final inference full-resolution", async () => {
  const registry = await read("lib/videoflow/ai/AIModelRegistry.ts");
  const loader = await read("lib/videoflow/ai/AIModelLoader.ts");
  const manager = await read("lib/videoflow/ai/AIManager.ts");
  const controls = await read("components/videoflow/AIWatermarkControls.tsx");
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  const cert = await read("scripts/certify-ai-wasm.mjs");
  assert.match(registry, /lama-dynamic-int8/);
  assert.match(registry, /1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972/);
  assert.match(loader, /videoflow-ai-models-v2/);
  assert.match(loader, /LEGACY_MODEL_CACHE/);
  assert.match(manager, /inferenceSize: 256 \\| 512 = 512/);
  assert.match(controls, /controller\\.signal, 256\\)/);
  assert.match(client, /threads-\\$\\{maxWasmThreads\\}:size-\\$\\{modelSize\\}/);
  assert.match(cert, /const size = 512/);
});

'''
if marker not in final_reg:
    raise SystemExit("final-browser regression adaptive anchor missing")
final_reg = final_reg.replace(marker, adaptive_final + marker)
write("tests/final-browser-regressions.test.mjs", final_reg)

# Active release/runtime/test paths must not retain the old identity.
for path in [
    "lib/videoflow/ai/AIModelRegistry.ts",
    "lib/videoflow/ai/AIModelLoader.ts",
    "lib/videoflow/ai/AIDiagnostics.ts",
    "scripts/stage-ai-pack-ci.sh",
    "scripts/certify-ai-wasm.mjs",
    "scripts/verify-release.mjs",
    "scripts/verify-nested-http.mjs",
    "scripts/create-github-upload-kit.mjs",
    "tests/ai-reconstruction.test.mjs",
    "tests/e2e/videoflow.spec.ts",
    "tests/github-upload-assets.test.mjs",
]:
    source = read(path)
    if OLD_ID in source or OLD_SHA in source or OLD_NAME in source:
        raise SystemExit(f"{path}: stale fixed-model identity remains")

print("Adaptive dynamic LaMa patch applied successfully")
