import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("static test server serves module runtime with JavaScript MIME", async () => {
  const server = await read("scripts/serve-dist.mjs");
  assert.match(server, /"\.mjs": "text\/javascript; charset=utf-8"/);
  assert.match(server, /writeHead\(404/);
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

test("nested browser runtimes resolve local ESM and WASM companions explicitly", async () => {
  assert.match(await read("scripts/copy-ffmpeg-assets.mjs"), /@ffmpeg\/core\/dist\/esm/);
  assert.match(await read("lib/videoflow/ai/AIInferenceEngine.ts"), /wasmPaths = deploymentAssetUrl\("vendor\/onnx\/"\)/);
  assert.match(await read("workers/ai-inference.worker.ts"), /runtime\.env\.wasm\.wasmPaths = data\.wasmBaseUrl/);
  assert.match(await read("scripts/verify-release.mjs"), /export default createFFmpegCore/);
  assert.match(await read("scripts/verify-nested-http.mjs"), /WebAssembly bytes/);
  const staging = await read("scripts/stage-ai-pack-ci.sh");
  const installer = await read("lib/videoflow/ai/AIRuntimeInstaller.ts");
  for (const variant of ["asyncify", "jsep", "jspi"]) {
    assert.match(staging, new RegExp(`ort-wasm-simd-threaded\\.${variant}\\.mjs`));
    assert.match(staging, new RegExp(`ort-wasm-simd-threaded\\.${variant}\\.wasm`));
    assert.match(installer, new RegExp(`ort-wasm-simd-threaded\\.${variant}\\.mjs`));
    assert.match(installer, new RegExp(`ort-wasm-simd-threaded\\.${variant}\\.wasm`));
  }
});

test("browser FFprobe calls use the explicit input flag required by ffmpeg.wasm", async () => {
  const ffmpeg = await read("lib/videoflow/ffmpeg.ts");
  assert.equal(
    [...ffmpeg.matchAll(/"-i",\s*(?:filename|mounted\.path)/g)].length,
    2,
  );
  assert.match(ffmpeg, /"error",\s*"-i",\s*filename,\s*"-show_streams"/);
  assert.match(ffmpeg, /"error",\s*"-i",\s*mounted\.path,\s*"-show_streams"/);
});

test("WebKit offline AI limitation is measured instead of assumed", async () => {
  const e2e = await read("tests/e2e/videoflow.spec.ts");
  assert.match(e2e, /stage: "offline-ai"/);
  assert.match(e2e, /status: "LIMITED"/);
  assert.match(e2e, /Original\\\/proxy media is offline/);
  assert.doesNotMatch(e2e, /sourceDurationSeconds: 5/);
});

test("Firefox browser matrix uses native Ogg Theora Vorbis fixtures", async () => {
  const fixtures = await read("scripts/generate-test-fixtures.mjs");
  const e2e = await read("tests/e2e/videoflow.spec.ts");
  const media = await read("lib/videoflow/media.ts");
  assert.match(fixtures, /overlap-source\.ogv/);
  assert.match(fixtures, /"libtheora"/);
  assert.match(fixtures, /libvorbis/);
  assert.match(e2e, /firefoxFixture/);
  assert.match(e2e, /firefoxAI/);
  assert.match(media, /ogv\|ogm/);
});


test("release dialogs and cross-browser imports remain bounded", async () => {
  assert.match(await read("app/globals.css"), /\.vf-export-dialog[\s\S]*max-height: calc\(100dvh - 32px\)[\s\S]*overflow-y: auto/);
  const media = await read("lib/videoflow/media.ts");
  assert.match(media, /OPTIONAL_TECHNICAL_PROBE_TIMEOUT_MS = 6_000/);
  assert.match(media, /probeMediaBlob\(file, file\.name, controller\.signal\)/);
  assert.match(media, /controller\.abort\(\)/);
  const ffmpeg = await read("lib/videoflow/ffmpeg.ts");
  assert.match(ffmpeg, /FFPROBE_TIMEOUT_MS = 12_000/);
  assert.match(ffmpeg, /FFMPEG_LOAD_TIMEOUT_MS = 15_000/);
  assert.match(ffmpeg, /FFmpeg initialization cancelled/);
  assert.match(await read("components/videoflow/AIWatermarkControls.tsx"), /aria-label="Run AI preview"/);
});

test("moving-watermark certification fixture uses a true time expression", async () => {
  const fixtures = await read("scripts/generate-test-fixtures.mjs");
  assert.match(fixtures, /overlay=x='100\+300\*t':y='70\+80\*t'/);
});
