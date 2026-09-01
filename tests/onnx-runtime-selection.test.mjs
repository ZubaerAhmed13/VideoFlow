import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("WASM-only AI uses the pure ONNX runtime while WebGPU keeps the WebGPU bundle", async () => {
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  const engine = await read("lib/videoflow/ai/AIInferenceEngine.ts");
  const worker = await read("workers/ai-inference.worker.ts");
  const staging = await read("scripts/stage-ai-pack-ci.sh");
  const installer = await read("lib/videoflow/ai/AIRuntimeInstaller.ts");

  // Runtime selection belongs exclusively to the supervised worker client.
  assert.match(client, /ort\.wasm\.bundle\.min\.mjs/);
  assert.match(client, /ort\.webgpu\.bundle\.min\.mjs/);
  assert.match(client, /useWebgpu/);
  assert.match(client, /providers = useWebgpu \? \["webgpu", "wasm"\] : \["wasm"\]/);
  assert.match(client, /WORKER_INIT_TIMEOUT_MS = 45_000/);
  assert.match(client, /WORKER_INFERENCE_TIMEOUT_MS = 120_000/);
  assert.match(client, /AIWorkerWatchdogError/);

  // The UI-facing engine must never create or run an ONNX session directly.
  // Keeping all neural execution in a terminable worker prevents a watchdog
  // failure from freezing Firefox on an unbounded main-thread session.run().
  assert.match(engine, /runWorkerInpainting/);
  assert.match(engine, /requires Web Worker support/);
  assert.doesNotMatch(engine, /ort\.wasm\.bundle\.min\.mjs|ort\.webgpu\.bundle\.min\.mjs/);
  assert.doesNotMatch(engine, /InferenceSession\.create|session\.run\(/);

  // The worker owns the actual ONNX session and enables bounded threaded WASM
  // only when the page is cross-origin isolated.
  assert.match(worker, /InferenceSession\.create/);
  assert.match(worker, /session\.run\(feeds\)/);
  assert.match(worker, /self\.crossOriginIsolated/);
  assert.match(worker, /runtime\.env\.wasm\.numThreads/);

  // Both packaged runtime flavors must remain present in the release pack.
  assert.match(staging, /ort\.wasm\.bundle\.min\.mjs/);
  assert.match(staging, /ort\.webgpu\.bundle\.min\.mjs/);
  assert.match(installer, /ort\.wasm\.bundle\.min\.mjs/);
  assert.match(installer, /ort\.webgpu\.bundle\.min\.mjs/);
});
