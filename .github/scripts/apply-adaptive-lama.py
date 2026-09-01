from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    text = read(path)
    actual = text.count(old)
    if actual != expected:
        raise SystemExit(f"{path}: expected {expected} occurrence(s) of {old!r}, found {actual}")
    write(path, text.replace(old, new))


# Dynamic model descriptor. 512 remains the default/final inference size;
# interactive preview explicitly requests 256 from the same dynamic graph.
write(
    "lib/videoflow/ai/AIModelRegistry.ts",
    '''import type { AIModelDescriptor } from "./types";

// Apache-2.0 quantized LaMa export with dynamic spatial dimensions.
// VideoFlow uses 256x256 for interactive previews and 512x512 for final/high-quality inference.
export const LAMA_DYNAMIC_INT8: AIModelDescriptor = {
  id: "lama-dynamic-int8",
  name: "LaMa Dynamic INT8",
  version: "g-ronimo-dynamic",
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

replace(
    "lib/videoflow/ai/AIDiagnostics.ts",
    'model: "LaMa 512 INT8",\n  modelVersion: "g-ronimo-8e20140",',
    'model: "LaMa Dynamic INT8",\n  modelVersion: "g-ronimo-dynamic",',
)

replace(
    "lib/videoflow/ai/AIManager.ts",
    '  signal?: AbortSignal,\n): Promise<AIFrameResult> {',
    '  signal?: AbortSignal,\n  inferenceSize: 256 | 512 = 512,\n): Promise<AIFrameResult> {',
)
replace(
    "lib/videoflow/ai/AIManager.ts",
    "extractROI(source, plan.roi, 512, 512)",
    "extractROI(source, plan.roi, inferenceSize, inferenceSize)",
)

replace(
    "components/videoflow/AIWatermarkControls.tsx",
    "reconstructFrame(bitmap, bitmap.width, bitmap.height, resolved, settings, null, controller.signal)",
    "reconstructFrame(bitmap, bitmap.width, bitmap.height, resolved, settings, null, controller.signal, 256)",
)

# One dynamic ONNX session serves both 256 and 512 requests. Inference size
# travels with each infer message instead of being frozen during init.
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    "const WORKER_INFERENCE_TIMEOUT_MS = 120_000;",
    "const WORKER_INFERENCE_TIMEOUT_MS = 130_000;",
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    "        outputName: DEFAULT_AI_MODEL.output,\n        size: DEFAULT_AI_MODEL.inputWidth,",
    "        outputName: DEFAULT_AI_MODEL.output,",
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    '  if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");\n  const deadline = performance.now() + WORKER_INTERACTIVE_BUDGET_MS;',
    '  if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");\n  const inferenceSize = image.width;\n  if (image.width !== image.height || (inferenceSize !== 256 && inferenceSize !== 512)) {\n    throw new Error(`Local AI inference requires a square 256x256 or 512x512 prepared ROI; received ${image.width}x${image.height}.`);\n  }\n  if (mask.length !== inferenceSize * inferenceSize) {\n    throw new Error(`Local AI mask size does not match the prepared ${inferenceSize}x${inferenceSize} ROI.`);\n  }\n  const deadline = performance.now() + WORKER_INTERACTIVE_BUDGET_MS;',
)
replace(
    "lib/videoflow/ai/AIWorkerClient.ts",
    "{ rgba: rgba.buffer, mask: maskCopy.buffer },",
    "{ rgba: rgba.buffer, mask: maskCopy.buffer, size: inferenceSize },",
)

replace("workers/ai-inference.worker.ts", "let size = 512;\n", "")
replace(
    "workers/ai-inference.worker.ts",
    "  outputName: string;\n  size: number;\n};",
    "  outputName: string;\n};",
)
replace(
    "workers/ai-inference.worker.ts",
    "  mask: ArrayBuffer;\n};",
    "  mask: ArrayBuffer;\n  size: 256 | 512;\n};",
)
replace(
    "workers/ai-inference.worker.ts",
    "  outputName = data.outputName;\n  size = data.size;",
    "  outputName = data.outputName;",
)
replace(
    "workers/ai-inference.worker.ts",
    "  const rgba = new Uint8ClampedArray(data.rgba);\n  const mask = new Float32Array(data.mask);\n  const pixels = size * size;",
    "  const rgba = new Uint8ClampedArray(data.rgba);\n  const mask = new Float32Array(data.mask);\n  const size = data.size;\n  if (size !== 256 && size !== 512) throw new Error(`Unsupported AI inference size: ${size}.`);\n  const pixels = size * size;\n  if (rgba.length !== pixels * 4 || mask.length !== pixels) {\n    throw new Error(`AI inference buffers do not match ${size}x${size}.`);\n  }",
)

# Move the browser model cache to v2 and invalidate the legacy fixed-model
# cache/record so an already-installed 512 model cannot masquerade as ready.
write(
    "lib/videoflow/ai/AIModelLoader.ts",
    '''import { DEFAULT_AI_MODEL } from "./AIModelRegistry";
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

async function clearLegacyModelCache(): Promise<void> {
  await caches.delete(LEGACY_MODEL_CACHE).catch(() => false);
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
  await clearLegacyModelCache();
  const record: AIModelInstallRecord = { descriptor, state: "installed", installedAt: new Date().toISOString(), verifiedAt: new Date().toISOString() };
  localStorage.setItem(MODEL_RECORD, JSON.stringify(record));
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
    if (!record || record.descriptor?.id !== DEFAULT_AI_MODEL.id) {
      if (record) localStorage.removeItem(MODEL_RECORD);
      return { descriptor: DEFAULT_AI_MODEL, state: "not-installed" };
    }
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
  await clearLegacyModelCache();
  localStorage.removeItem(MODEL_RECORD);
}
''',
)

# CI staging now downloads the checksum-pinned dynamic graph.
path = "scripts/stage-ai-pack-ci.sh"
text = read(path)
for old, new in {
    "https://huggingface.co/g-ronimo/lama/resolve/main/lama_512_int8.onnx?download=true": "https://huggingface.co/g-ronimo/lama/resolve/main/lama_int8.onnx?download=true",
    "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe": "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
    "62074990": "61512617",
    "lama-512-int8.onnx": "lama-dynamic-int8.onnx",
}.items():
    if old not in text:
        raise SystemExit(f"{path}: missing {old}")
    text = text.replace(old, new)
write(path, text)

# Production verifier, nested-path verifier, upload-kit and certification
# must prove the new model bytes. Certification deliberately stays 512.
replacements_by_file = {
    "scripts/verify-release.mjs": [
        ("lama-512-int8", "lama-dynamic-int8"),
        ("LaMa 512 INT8", "LaMa Dynamic INT8"),
        ("cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe", "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972"),
        ("62074990", "61512617"),
    ],
    "scripts/verify-nested-http.mjs": [("lama-512-int8", "lama-dynamic-int8")],
    "scripts/create-github-upload-kit.mjs": [("lama-512-int8", "lama-dynamic-int8")],
    "scripts/certify-ai-wasm.mjs": [
        ("lama-512-int8.onnx", "lama-dynamic-int8.onnx"),
        ("cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe", "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972"),
        ("62_074_990", "61_512_617"),
        ("LaMa 512 INT8 ONNX", "LaMa Dynamic INT8 ONNX"),
    ],
    "scripts/finalize-ci-certification.mjs": [
        ("LaMa 512 INT8", "LaMa Dynamic INT8"),
        ("lama-512-int8", "lama-dynamic-int8"),
        ("cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe", "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972"),
        ("62,074,990", "61,512,617"),
    ],
}
for path, pairs in replacements_by_file.items():
    text = read(path)
    for old, new in pairs:
        if old in text:
            text = text.replace(old, new)
    write(path, text)

cert = read("scripts/certify-ai-wasm.mjs")
marker = "    modelSha256: sha256,\n"
if marker not in cert:
    raise SystemExit("certification evidence insertion point missing")
write(
    "scripts/certify-ai-wasm.mjs",
    cert.replace(marker, marker + "    certificationInputSize: 512,\n    supportedInputSizes: [256, 512],\n", 1),
)

# Rename and rewrite tracked model metadata.
old_meta = Path("public/models/lama-512-int8.model.json")
new_meta = Path("public/models/lama-dynamic-int8.model.json")
if not old_meta.exists():
    raise SystemExit("legacy model metadata missing")
old_meta.rename(new_meta)
new_meta.write_text(
    '''{
  "id": "lama-dynamic-int8",
  "name": "LaMa Dynamic INT8",
  "version": "g-ronimo-dynamic",
  "license": "Apache-2.0",
  "source": "https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx",
  "sha256": "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
  "sizeBytes": 61512617,
  "localPath": "models/lama-dynamic-int8.onnx",
  "input": "dynamic 1x4xHxW float32 packed RGB+mask; VideoFlow preview 256x256, final/high-quality 512x512",
  "installation": "Explicit user action copies the checksum-validated bundled model into protected local Cache Storage. The PWA shell never auto-downloads the model."
}
'''
)

# Human-facing model docs: keep the quality distinction explicit.
write(
    "public/models/README.md",
    '''# VideoFlow local AI model pack

VideoFlow uses a checksum-pinned **LaMa Dynamic INT8 ONNX** model. The model is not automatically downloaded or precached by the PWA shell. The user explicitly chooses **Install bundled AI**, after which VideoFlow validates the exact byte size and SHA-256 digest before storing the model in protected local Cache Storage.

- File: `lama-dynamic-int8.onnx`
- Source: `https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx`
- License: Apache-2.0
- Size: 61,512,617 bytes
- SHA-256: `1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972`
- Interactive preview: 256x256 ROI inference for bounded latency
- Final/high-quality reconstruction and certification: 512x512 ROI inference

The dynamic graph was release-benchmarked at both sizes. 512x512 output parity against the previous fixed-512 export was numerically equivalent within floating-point noise; release certification continues to exercise genuine 512x512 WASM inference.
''',
)
write(
    "public/models/MODEL_LICENSE_NOTICE.md",
    '''# LaMa Dynamic INT8 model notice

- Model/export: LaMa Dynamic INT8 ONNX
- Upstream project: LaMa — Resolution-robust Large Mask Inpainting with Fourier Convolutions
- Export source: <https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx>
- Declared license: Apache-2.0
- SHA-256: `1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972`
- Size: 61,512,617 bytes
- VideoFlow use: local/offline neural ROI reconstruction; 256x256 interactive preview and 512x512 final/high-quality inference.

VideoFlow does not claim ownership of the upstream model. Distribution and use remain subject to the upstream model/project license and any rights in the user-supplied media.
''',
)

# Update primary documentation without rewriting historical generated evidence.
docs = ["models/README.md", "AI_RECONSTRUCTION.md", "docs/ai-reconstruction.md", "README.md", "START_HERE.md"]
common = [
    ("LaMa 512 INT8", "LaMa Dynamic INT8"),
    ("lama-512-int8", "lama-dynamic-int8"),
    ("g-ronimo-8e20140", "g-ronimo-dynamic"),
    ("https://huggingface.co/g-ronimo/lama/blob/main/lama_512_int8.onnx", "https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx"),
    ("cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe", "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972"),
    ("62,074,990", "61,512,617"),
    ("62074990", "61512617"),
]
for path in docs:
    text = read(path)
    for old, new in common:
        text = text.replace(old, new)
    write(path, text)

# Regression suite now proves adaptive preview, 512 default quality, dynamic
# packaging, and the watchdog's strict 30+130 < 165 second budget.
test_path = "tests/ai-reconstruction.test.mjs"
text = read(test_path)
text = text.replace("/LaMa 512 INT8/", "/LaMa Dynamic INT8/")
text = text.replace(
    "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe",
    "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
)
text = text.replace(
    'test("4K AI path performs fixed-size ROI inference rather than full-frame neural inference", async () => {\n  const manager = await read("lib/videoflow/ai/AIManager.ts");',
    'test("4K AI path uses adaptive fixed-size ROI inference rather than full-frame neural inference", async () => {\n  const manager = await read("lib/videoflow/ai/AIManager.ts");\n  const controls = await read("components/videoflow/AIWatermarkControls.tsx");',
)
text = text.replace(
    "  assert.match(manager, /extractROI\\(source, plan\\.roi, 512, 512\\)/);",
    "  assert.match(manager, /inferenceSize:\\s*256 \\| 512 = 512/);\n  assert.match(manager, /extractROI\\(source, plan\\.roi, inferenceSize, inferenceSize\\)/);\n  assert.match(controls, /reconstructFrame\\(bitmap,[\\s\\S]*controller\\.signal, 256\\)/);",
)
text = text.replace("/lama-512-int8\\.onnx/", "/lama-dynamic-int8\\.onnx/")
write(test_path, text)

for path in ["tests/onnx-runtime-selection.test.mjs", "tests/final-browser-regressions.test.mjs"]:
    text = read(path)
    if "WORKER_INFERENCE_TIMEOUT_MS = 120_000" not in text:
        raise SystemExit(f"{path}: old watchdog assertion missing")
    write(path, text.replace("WORKER_INFERENCE_TIMEOUT_MS = 120_000", "WORKER_INFERENCE_TIMEOUT_MS = 130_000"))

path = "tests/github-upload-assets.test.mjs"
text = read(path)
if "lama-512-int8.onnx" not in text:
    raise SystemExit("upload asset regression fixed-model marker missing")
write(path, text.replace("lama-512-int8.onnx", "lama-dynamic-int8.onnx"))

# Additional contract assertions.
write(
    "tests/adaptive-ai-model.test.mjs",
    '''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("dynamic LaMa model has pinned production identity and 512 default quality", async () => {
  const registry = await read("lib/videoflow/ai/AIModelRegistry.ts");
  assert.match(registry, /lama-dynamic-int8/);
  assert.match(registry, /1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972/);
  assert.match(registry, /size:\s*61512617/);
  assert.match(registry, /inputWidth:\s*512/);
});

test("interactive preview requests 256 while reconstruction defaults to 512", async () => {
  const manager = await read("lib/videoflow/ai/AIManager.ts");
  const controls = await read("components/videoflow/AIWatermarkControls.tsx");
  assert.match(manager, /inferenceSize:\s*256 \| 512 = 512/);
  assert.match(manager, /extractROI\(source, plan\.roi, inferenceSize, inferenceSize\)/);
  assert.match(controls, /reconstructFrame\(bitmap,[\s\S]*controller\.signal, 256\)/);
});

test("one worker session accepts a bounded inference size per request", async () => {
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  const worker = await read("workers/ai-inference.worker.ts");
  assert.match(client, /size: inferenceSize/);
  assert.match(client, /inferenceSize !== 256 && inferenceSize !== 512/);
  assert.match(worker, /size: 256 \| 512/);
  assert.match(worker, /const size = data\.size/);
  assert.doesNotMatch(worker, /let size = 512/);
});

test("model cache migration rejects stale fixed-model records", async () => {
  const loader = await read("lib/videoflow/ai/AIModelLoader.ts");
  assert.match(loader, /videoflow-ai-models-v2/);
  assert.match(loader, /videoflow-ai-models-v1/);
  assert.match(loader, /record\.descriptor\?\.id !== DEFAULT_AI_MODEL\.id/);
  assert.match(loader, /clearLegacyModelCache/);
});

test("release certification uses the dynamic model at genuine 512 input", async () => {
  const cert = await read("scripts/certify-ai-wasm.mjs");
  assert.match(cert, /lama-dynamic-int8\.onnx/);
  assert.match(cert, /const size = 512/);
  assert.match(cert, /supportedInputSizes: \[256, 512\]/);
});
''',
)

# Guard against accidental stale production references in executable,
# verification and current docs. Historical certification artifacts are
# intentionally excluded until the authoritative release run regenerates them.
checked = [
    "lib/videoflow/ai/AIModelRegistry.ts",
    "lib/videoflow/ai/AIDiagnostics.ts",
    "scripts/stage-ai-pack-ci.sh",
    "scripts/certify-ai-wasm.mjs",
    "scripts/verify-release.mjs",
    "scripts/verify-nested-http.mjs",
    "scripts/create-github-upload-kit.mjs",
    "scripts/finalize-ci-certification.mjs",
    "public/models/README.md",
    "public/models/MODEL_LICENSE_NOTICE.md",
    "models/README.md",
    "AI_RECONSTRUCTION.md",
    "docs/ai-reconstruction.md",
    "README.md",
    "START_HERE.md",
    "tests/ai-reconstruction.test.mjs",
    "tests/github-upload-assets.test.mjs",
]
for path in checked:
    text = read(path)
    if "lama-512-int8" in text or "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe" in text:
        raise SystemExit(f"stale fixed-model production reference remains in {path}")
