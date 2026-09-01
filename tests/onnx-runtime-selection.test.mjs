import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("WASM-only AI uses the pure ONNX runtime while WebGPU keeps the WebGPU bundle", async () => {
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  const engine = await read("lib/videoflow/ai/AIInferenceEngine.ts");
  const staging = await read("scripts/stage-ai-pack-ci.sh");
  const installer = await read("lib/videoflow/ai/AIRuntimeInstaller.ts");

  for (const source of [client, engine]) {
    assert.match(source, /ort\.wasm\.bundle\.min\.mjs/);
    assert.match(source, /ort\.webgpu\.bundle\.min\.mjs/);
    assert.match(source, /useWebgpu/);
  }
  assert.match(client, /providers = useWebgpu \? \["webgpu", "wasm"\] : \["wasm"\]/);
  assert.match(client, /WORKER_INIT_TIMEOUT_MS = 45_000/);
  assert.match(client, /WORKER_INFERENCE_TIMEOUT_MS = 120_000/);
  assert.match(client, /AIWorkerWatchdogError/);
  assert.match(staging, /ort\.wasm\.bundle\.min\.mjs/);
  assert.match(installer, /ort\.wasm\.bundle\.min\.mjs/);
});
