import assert from "node:assert/strict";
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
