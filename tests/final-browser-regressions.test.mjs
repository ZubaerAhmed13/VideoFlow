import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("static test server serves module runtime with JavaScript MIME", async () => {
  assert.match(await read("scripts/serve-dist.mjs"), /"\.mjs": "text\/javascript; charset=utf-8"/);
});

test("export range follows newly imported project duration", async () => {
  const source = await read("components/videoflow/ExportControls.tsx");
  assert.match(source, /const currentEnd = current\.rangeEnd \?\? 0/);
  assert.match(source, /rangeEnd: fullDuration/);
});

test("ONNX WASM falls back to one thread without cross-origin isolation", async () => {
  assert.match(await read("workers/ai-inference.worker.ts"), /self\.crossOriginIsolated[^\n]+: 1/);
  assert.match(await read("lib/videoflow/ai/AIInferenceEngine.ts"), /globalThis\.crossOriginIsolated[^\n]+: 1/);
});

test("Firefox browser matrix uses generated VP9 Opus fixtures", async () => {
  const fixtures = await read("scripts/generate-test-fixtures.mjs");
  const e2e = await read("tests/e2e/videoflow.spec.ts");
  assert.match(fixtures, /overlap-source\.webm/);
  assert.match(fixtures, /libvpx-vp9/);
  assert.match(e2e, /firefoxFixture/);
  assert.match(e2e, /firefoxAI/);
});
