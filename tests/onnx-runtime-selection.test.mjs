import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("ONNX execution stays supervised and adaptively recovers from stalled threaded WASM", async () => {
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  const engine = await read("lib/videoflow/ai/AIInferenceEngine.ts");
  const worker = await read("workers/ai-inference.worker.ts");
  const staging = await read("scripts/stage-ai-pack-ci.sh");
  const installer = await read("lib/videoflow/ai/AIRuntimeInstaller.ts");

  // Runtime selection belongs exclusively to the supervised worker client.
  assert.match(client, /ort\.wasm\.bundle\.min\.mjs/);
  assert.match(client, /ort\.webgpu\.bundle\.min\.mjs/);
  assert.match(client, /useWebgpu/);
  assert.match(client, /const providers: AIProvider\[\] = useWebgpu \? \["webgpu", "wasm"\] : \["wasm"\]/);
  assert.match(client, /WORKER_INIT_TIMEOUT_MS = 45_000/);
  assert.match(client, /WORKER_THREADED_PROBE_TIMEOUT_MS = 75_000/);
  assert.match(client, /WORKER_INFERENCE_TIMEOUT_MS = 120_000/);
  assert.match(client, /AIWorkerWatchdogError/);

  // Thread capability is learned from actual execution rather than UA sniffing.
  assert.match(client, /shouldDowngradeThreadedWasm/);
  assert.match(client, /error\.stage === "inference-running"/);
  assert.match(client, /error\.provider === "wasm"/);
  assert.match(client, /error\.wasmThreads > 1/);
  assert.match(client, /persistSingleThreadWasmProfile/);
  assert.match(client, /sessionStorage\.setItem\(WASM_THREAD_PROFILE_KEY, "1"\)/);
  assert.match(client, /return attempt\(\)/);
  assert.doesNotMatch(client, /userAgent|firefox|Firefox/);

  // The UI-facing engine must never create or run an ONNX session directly.
  // All neural execution remains killable even during recovery.
  assert.match(engine, /runWorkerInpainting/);
  assert.match(engine, /requires Web Worker support/);
  assert.doesNotMatch(engine, /ort\.wasm\.bundle\.min\.mjs|ort\.webgpu\.bundle\.min\.mjs/);
  assert.doesNotMatch(engine, /InferenceSession\.create|session\.run\(/);

  // The worker owns ONNX, reports its actual thread profile, and can be
  // re-created with a caller-supplied single-thread limit after a stalled run.
  assert.match(worker, /InferenceSession\.create/);
  assert.match(worker, /session\.run\(feeds\)/);
  assert.match(worker, /self\.crossOriginIsolated/);
  assert.match(worker, /maxWasmThreads/);
  assert.match(worker, /resolveWasmThreadCount/);
  assert.match(worker, /runtime\.env\.wasm\.numThreads = wasmThreads/);
  assert.match(worker, /wasmThreads: active\.wasmThreads/);

  // Both packaged runtime flavors must remain present in the release pack.
  assert.match(staging, /ort\.wasm\.bundle\.min\.mjs/);
  assert.match(staging, /ort\.webgpu\.bundle\.min\.mjs/);
  assert.match(installer, /ort\.wasm\.bundle\.min\.mjs/);
  assert.match(installer, /ort\.webgpu\.bundle\.min\.mjs/);
});
