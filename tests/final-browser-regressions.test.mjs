import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("static test server serves module runtime with JavaScript MIME and cross-origin isolation", async () => {
  const server = await read("scripts/serve-dist.mjs");
  assert.match(server, /"\.mjs": "text\/javascript; charset=utf-8"/);
  assert.match(server, /"Cross-Origin-Opener-Policy": "same-origin"/);
  assert.match(server, /"Cross-Origin-Embedder-Policy": "require-corp"/);
  assert.match(server, /"Cross-Origin-Resource-Policy": "same-origin"/);
  assert.match(server, /writeHead\(404/);
});

test("export range follows newly imported project duration", async () => {
  const source = await read("components/videoflow/ExportControls.tsx");
  assert.match(source, /const currentEnd = current\.rangeEnd \?\? 0/);
  assert.match(source, /rangeEnd: fullDuration/);
});

test("ONNX execution adaptively supervises threaded WASM inside a killable worker", async () => {
  const worker = await read("workers/ai-inference.worker.ts");
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  const engine = await read("lib/videoflow/ai/AIInferenceEngine.ts");

  // Thread selection is capability-driven: isolation permits a bounded thread
  // pool, while the caller can explicitly constrain a rebuilt worker to one.
  assert.match(worker, /function resolveWasmThreadCount\(data: InitRequest\)/);
  assert.match(worker, /if \(!self\.crossOriginIsolated\) return 1/);
  assert.match(worker, /data\.maxWasmThreads/);
  assert.match(worker, /runtime\.env\.wasm\.numThreads = wasmThreads/);
  assert.match(worker, /wasmThreads: active\.wasmThreads/);
  assert.match(worker, /wasmThreads: response\.wasmThreads/);
  assert.match(worker, /runtime\.env\.wasm\.proxy = false/);
  assert.match(worker, /graphOptimizationLevel: "all"/);
  assert.match(worker, /executionMode: "sequential"/);
  assert.match(worker, /reportStage\(data\.id, "inference-running"\)/);

  // A genuine stalled threaded WASM inference is treated as runtime evidence,
  // not as a browser-name heuristic. It is terminated and retried exactly once
  // in a fresh single-thread worker, with the stable profile remembered per tab.
  assert.match(client, /WORKER_INTERACTIVE_BUDGET_MS = 165_000/);
  assert.match(client, /WORKER_THREADED_PROBE_TIMEOUT_MS = 30_000/);
  assert.match(client, /WORKER_INFERENCE_TIMEOUT_MS = 125_000/);
  assert.match(client, /timeoutWithinDeadline/);
  assert.match(client, /initialize\([\s\S]*timeoutWithinDeadline\(deadline, WORKER_INIT_TIMEOUT_MS, "init"\)/);
  assert.match(client, /timeoutWithinDeadline\(deadline, timeoutCeiling, "infer"\)/);
  const constantMs = (name) => {
    const match = client.match(new RegExp(`const ${name} = ([\\d_]+);`));
    assert.ok(match, `Missing ${name}`);
    return Number(match[1].replaceAll("_", ""));
  };
  assert.ok(
    constantMs("WORKER_THREADED_PROBE_TIMEOUT_MS") + constantMs("WORKER_INFERENCE_TIMEOUT_MS")
      < constantMs("WORKER_INTERACTIVE_BUDGET_MS"),
    "Adaptive recovery must reserve deadline time for worker rebuild/session initialization.",
  );
  assert.match(client, /AIWorkerWatchdogError/);
  assert.match(client, /while \$\{current\.stage\}/);
  assert.match(client, /function shouldDowngradeThreadedWasm/);
  assert.match(client, /error\.operation === "infer"/);
  assert.match(client, /error\.stage === "inference-running"/);
  assert.match(client, /error\.provider === "wasm"/);
  assert.match(client, /error\.wasmThreads > 1/);
  assert.match(client, /persistSingleThreadWasmProfile\(\)/);
  assert.match(client, /sessionStorage\.setItem\(WASM_THREAD_PROFILE_KEY, "1"\)/);
  assert.match(client, /maxWasmThreads: plan\.maxWasmThreads/);
  assert.doesNotMatch(client, /navigator\.userAgent|\bFirefox\b|\bGecko\b/);

  // The UI-facing engine never owns an ONNX session. Even recovery remains
  // entirely inside terminable workers, so no watchdog can migrate a stalled
  // neural run onto the main thread.
  assert.doesNotMatch(engine, /session\.run\(/);
  assert.doesNotMatch(engine, /runImageInpaintingMainThread/);
  assert.match(engine, /requires Web Worker support so ONNX inference remains isolated, cancellable, and bounded/);
});

test("GitHub Pages shell can establish cross-origin isolation without a custom server", async () => {
  const sw = await read("public/service-worker.js");
  const bootstrap = await read("public/coi-bootstrap.js");
  const layout = await read("app/layout.tsx");
  assert.match(sw, /videoflow-pwa10-coi/);
  assert.match(sw, /Cross-Origin-Opener-Policy/);
  assert.match(sw, /Cross-Origin-Embedder-Policy/);
  assert.match(sw, /Cross-Origin-Resource-Policy/);
  assert.match(sw, /isolatedResponse\(cached\)/);
  assert.match(bootstrap, /navigator\.serviceWorker\.register/);
  assert.match(bootstrap, /SKIP_WAITING/);
  assert.match(bootstrap, /videoflow-coi-reload-v1/);
  assert.match(layout, /<script src="\.\/coi-bootstrap\.js"/);
});

test("nested browser runtimes resolve local ESM and WASM companions explicitly", async () => {
  assert.match(await read("scripts/copy-ffmpeg-assets.mjs"), /@ffmpeg\/core\/dist\/esm/);
  const worker = await read("workers/ai-inference.worker.ts");
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  assert.match(worker, /runtime\.env\.wasm\.wasmPaths = data\.wasmBaseUrl/);
  assert.match(client, /ort\.wasm\.bundle\.min\.mjs/);
  assert.match(client, /ort\.webgpu\.bundle\.min\.mjs/);
  assert.match(await read("scripts/verify-release.mjs"), /export default createFFmpegCore/);
  const nested = await read("scripts/verify-nested-http.mjs");
  assert.match(nested, /WebAssembly bytes/);
  assert.match(nested, /cross-origin-opener-policy/);
  assert.match(nested, /cross-origin-embedder-policy/);
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
  assert.match(media, /STORAGE_ESTIMATE_TIMEOUT_MS = 1_000/);
  assert.match(media, /const estimatePromise = navigator\.storage\?\.estimate\?\.\(\)/);
  assert.match(media, /estimateFreeDecision\.mode !== "persisted"/);
  const app = await read("components/videoflow/VideoFlowApp.tsx");
  assert.ok(app.includes('if (storage.mode === "persisted")\n              void navigator.storage?.persist?.().catch(() => undefined);'));
  assert.doesNotMatch(app, /await navigator\.storage\?\.persist\?\.\(\)/);
  assert.ok(app.includes('markImportStage(`Saving ${file.name} as ${storage.mode}`);'));
  const ffmpeg = await read("lib/videoflow/ffmpeg.ts");
  assert.match(ffmpeg, /FFPROBE_TIMEOUT_MS = 12_000/);
  assert.match(ffmpeg, /FFMPEG_LOAD_TIMEOUT_MS = 15_000/);
  assert.match(ffmpeg, /FFmpeg initialization cancelled/);
  const aiControls = await read("components/videoflow/AIWatermarkControls.tsx");
  assert.match(aiControls, /aria-label="Run AI preview"/);
  assert.equal((aiControls.match(/await openFrameExtractionSession\(/g) ?? []).length, 2);
  assert.equal((aiControls.match(/releaseFrameExtractionSession\(frameSession\)/g) ?? []).length, 2);
  assert.match(aiControls, /asset\.proxyBlob \?\? asset\.blob/);
  assert.match(aiControls, /captureVideoFrame\(extractionSession, sourceTime/);
  const decoder = await read("lib/videoflow/ai/VideoFrameDecoder.ts");
  assert.match(decoder, /MEDIA_METADATA_TIMEOUT_MS = 8_000/);
  assert.match(decoder, /MEDIA_PASSIVE_DECODE_TIMEOUT_MS = 1_500/);
  assert.match(decoder, /MEDIA_PLAY_PRIME_TIMEOUT_MS = 2_500/);
  assert.match(decoder, /MEDIA_SEEK_PRIME_TIMEOUT_MS = 2_500/);
  assert.match(decoder, /FRAME_DECODE_TIMEOUT_MS = 8_000/);
  assert.match(decoder, /FRAME_CAPTURE_RETRIES = 4/);
  assert.match(decoder, /nativeDecodeFailures = new WeakSet<Blob>\(\)/);
  assert.match(decoder, /createFfmpegFrameExtractionSession/);
  assert.match(decoder, /Native decoder unavailable; switching to local FFmpeg frame decoder/);
  assert.match(decoder, /Native frame capture failed; switching to local FFmpeg frame decoder/);
  assert.match(decoder, /recoverableFfmpegFrameError/);
  assert.match(decoder, /Local FFmpeg filesystem state fault; rebuilding decoder session/);
  assert.match(decoder, /failedSession\?\.close\(\)\.catch/);
  assert.match(decoder, /document\.body\.appendChild\(video\)/);
  assert.match(decoder, /context\.drawImage\(video, 0, 0, canvas\.width, canvas\.height\)/);
  assert.doesNotMatch(decoder, /createImageBitmap\(video\)/);
  assert.doesNotMatch(decoder, /navigator\.userAgent|\bFirefox\b|\bGecko\b/);
  assert.match(ffmpeg, /export interface FfmpegFrameExtractionSession/);
  assert.match(ffmpeg, /createFfmpegFrameExtractionSession/);
  assert.match(ffmpeg, /MEMFS_INPUT_LIMIT_BYTES = 64 \* 1024 \* 1024/);
  assert.match(ffmpeg, /instance\.mount\(WORKER_FS/);
  assert.match(ffmpeg, /"-ss", safeTime\.toFixed\(6\)/);
  assert.match(ffmpeg, /"-frames:v", "1"/);
  assert.match(ffmpeg, /bytesToBlob\(data, "image\/png"\)/);
});

test("release workflow cannot hide a unit failure behind tee", async () => {
  const workflow = await read(".github/workflows/release-verification.yml");
  assert.match(workflow, /set -o pipefail[\s\S]*npm run test:unit \| tee ci-results\/unit\.log/);
});

test("moving-watermark certification fixture uses a true time expression", async () => {
  const fixtures = await read("scripts/generate-test-fixtures.mjs");
  assert.match(fixtures, /overlay=x='100\+300\*t':y='70\+80\*t'/);
});
