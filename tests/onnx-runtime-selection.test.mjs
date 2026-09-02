import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function constantMs(source, name) {
  const match = source.match(new RegExp(`const ${name} = ([\\d_]+);`));
  assert.ok(match, `Missing ${name}`);
  return Number(match[1].replaceAll("_", ""));
}

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
  assert.match(client, /WORKER_INTERACTIVE_BUDGET_MS = 165_000/);
  assert.match(client, /WORKER_PRODUCTION_BUDGET_MS = 420_000/);
  assert.match(client, /WORKER_PRODUCTION_INFERENCE_TIMEOUT_MS = 300_000/);
  assert.match(client, /WORKER_THREADED_PROBE_TIMEOUT_MS = 30_000/);
  assert.match(client, /WORKER_INFERENCE_TIMEOUT_MS = 125_000/);
  assert.match(client, /WORKER_MIN_TIMEOUT_SLICE_MS = 1_000/);
  assert.match(client, /AIWorkerWatchdogError/);

  // The adaptive path must fit inside one product-level interactive deadline.
  // A short threaded viability probe leaves enough time for a full bounded
  // single-thread retry plus worker rebuild/session initialization overhead.
  const interactiveBudget = constantMs(client, "WORKER_INTERACTIVE_BUDGET_MS");
  const threadedProbe = constantMs(client, "WORKER_THREADED_PROBE_TIMEOUT_MS");
  const fallbackInference = constantMs(client, "WORKER_INFERENCE_TIMEOUT_MS");
  assert.ok(threadedProbe + fallbackInference < interactiveBudget);
  assert.ok(interactiveBudget - threadedProbe - fallbackInference >= 10_000);
  assert.match(client, /const budgetMs = purpose === "interactive"/);
  assert.match(client, /const deadline = performance\.now\(\) \+ budgetMs/);
  assert.match(client, /function timeoutWithinDeadline/);
  assert.match(client, /timeoutWithinDeadline\(deadline, WORKER_INIT_TIMEOUT_MS, "init", budgetMs\)/);
  assert.match(client, /timeoutWithinDeadline\(deadline, timeoutCeiling, "infer", budgetMs\)/);
  assert.match(client, /Math\.min\(WORKER_INIT_TIMEOUT_MS, timeoutMs\)/);

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
