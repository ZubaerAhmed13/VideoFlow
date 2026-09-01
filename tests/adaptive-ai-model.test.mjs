import assert from "node:assert/strict";
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
