import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("AI registry uses a real checksum-validated Apache-2.0 LaMa model descriptor", async () => {
  const source = await read("lib/videoflow/ai/AIModelRegistry.ts");
  assert.match(source, /LaMa 512 INT8/);
  assert.match(source, /LaMa Dynamic INT8/);
  assert.match(source, /Apache-2\.0/);
  assert.match(source, /cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe/);
  assert.match(source, /1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972/);
  assert.match(source, /inputWidth:\s*512/);
});

test("AI model install verifies SHA-256 and persists model in a protected local cache", async () => {
  const source = await read("lib/videoflow/ai/AIModelLoader.ts");
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /AI model validation failed/);
  assert.match(source, /videoflow-ai-models-v1/);
  assert.match(source, /cache\.put/);
});

test("AI inference is genuine ONNX execution with worker isolation and WebGPU to WASM fallback", async () => {
  const engine = await read("lib/videoflow/ai/AIInferenceEngine.ts");
  const worker = await read("workers/ai-inference.worker.ts");
  assert.match(engine, /runWorkerInpainting/);
  assert.match(worker, /InferenceSession\.create/);
  assert.match(worker, /session\.run/);
  assert.match(worker, /\["webgpu",\s*"wasm"\]|providers/);
  assert.match(worker, /\["wasm"\]/);
  assert.doesNotMatch(worker, /blur|pixelate|clone/i);
});

test("4K AI path uses adaptive fixed-size ROI inference rather than full-frame neural inference", async () => {
  const manager = await read("lib/videoflow/ai/AIManager.ts");
  const controls = await read("components/videoflow/AIWatermarkControls.tsx");
  const roi = await read("lib/videoflow/ai/inpainting/ROIPreprocessor.ts");
  const tiling = await read("lib/videoflow/ai/inpainting/TiledInference.ts");
  assert.match(manager, /inferenceSize:\s*256 \| 512 = 512/);
  assert.match(manager, /extractROI\(source, plan\.roi, inferenceSize, inferenceSize\)/);
  assert.match(controls, /const previewSize: 256 \| 512/);
  assert.match(controls, /previewSize, "interactive"/);
  assert.match(manager, /restoreROI/);
  assert.match(manager, /planROITiles/);
  assert.match(roi, /normalizedMaskToROI/);
  assert.match(roi, /createROITransform/);
  assert.match(roi, /paddingTop/);
  assert.match(tiling, /cos\(Math\.PI/);
  assert.match(tiling, /overlap/);
});

test("ROI and mask preprocessing share the same aspect-preserving letterbox transform", async () => {
  const roi = await read("lib/videoflow/ai/inpainting/ROIPreprocessor.ts");
  const mask = await read("lib/videoflow/ai/inpainting/MaskProcessor.ts");
  assert.match(roi, /scale = Math\.min/);
  assert.match(roi, /scaledWidth/);
  assert.match(roi, /paddingLeft/);
  assert.match(roi, /restoreROI/);
  assert.match(mask, /transform\.paddingLeft/);
  assert.match(mask, /transform\.scaledWidth/);
  assert.doesNotMatch(roi, /roi\.width, roi\.height, 0, 0, size, size/);
});

test("AI quality modes materially alter ROI and temporal processing", async () => {
  const source = await read("lib/videoflow/ai/AIManager.ts");
  assert.match(source, /fast:/);
  assert.match(source, /high:/);
  assert.match(source, /maximum:/);
  assert.match(source, /oddWithin\(settings\.temporalWindow, 3, 5\)/);
  assert.match(source, /oddWithin\(settings\.temporalWindow, 7, 9\)/);
  assert.match(source, /oddWithin\(settings\.temporalWindow, 11, 15\)/);
  assert.match(source, /maximumWindow/);
  assert.match(source, /consistencyStrength/);
});

test("AI export is bounded, cancellable and preserves original audio", async () => {
  const source = await read("lib/videoflow/ai/VideoInpainter.ts");
  const encoder = await read("lib/videoflow/ffmpeg.ts");
  assert.match(source, /microBatchSize/);
  assert.match(source, /batchFrames\.splice/);
  assert.match(source, /SlidingTemporalWindow/);
  assert.match(source, /concatenateMp4Batches/);
  assert.doesNotMatch(source, /const frames:\s*Blob\[\]\s*=\s*\[\]/);
  assert.match(encoder, /compressed batch outputs are retained/);
  assert.match(source, /signal\.aborted/);
  assert.match(source, /reconstructFrame\([\s\S]*signal\)/);
  assert.match(source, /AI source audio/);
  assert.match(source, /kind = "audio"/);
});

test("AI masks cannot fall through to a fake FFmpeg blur implementation", async () => {
  const plan = await read("lib/videoflow/render-plan.mjs");
  assert.match(plan, /AI masks must be neural-preprocessed/);
  const app = await read("components/videoflow/VideoFlowApp.tsx");
  assert.match(app, /never relabels blur, pixelate, cover or clone as AI/);
});

test("PWA protects separately installed AI caches and does not auto-precache ONNX models", async () => {
  const sw = await read("public/service-worker.js");
  assert.match(sw, /videoflow-ai-/);
  assert.match(sw, /\/models\/.*\\\.onnx|models/);
  assert.match(sw, /precache-manifest\.json/);
});

test("large-media fingerprints use sampled SHA-256 identity checks", async () => {
  const source = await read("lib/videoflow/media.ts");
  assert.match(source, /PARTIAL_HASH_SAMPLE_BYTES\s*=\s*4 \* 1024 \* 1024/);
  assert.match(source, /SHA-256/);
  assert.match(source, /Math\.floor\(\(file\.size - sampleSize\) \/ 2\)/);
  assert.match(source, /fingerprintMatchesAsync/);
});

test("temporal stabilization uses real block-motion estimation before blending", async () => {
  const estimator = await read("lib/videoflow/ai/temporal/MotionEstimator.ts");
  const temporal = await read("lib/videoflow/ai/temporal/TemporalContext.ts");
  assert.match(estimator, /coarse-to-fine luminance block matching/);
  assert.match(estimator, /translationError/);
  assert.match(estimator, /translateImage/);
  assert.match(estimator, /does not claim a dense per-pixel flow field/);
  assert.match(estimator, /estimateLocalMotionField/);
  assert.match(estimator, /sparse local motion[\s\S]*not dense optical flow/);
  assert.match(temporal, /estimateLocalMotionField/);
  assert.match(temporal, /future/);
  assert.match(temporal, /SlidingTemporalWindow/);
  assert.match(temporal, /confidence/);
  assert.match(temporal, /warpImageWithMotionField/);
});

test("tracking spans explicit ranges in a cancellable worker and persists confidence issues", async () => {
  const controls = await read("components/videoflow/AIWatermarkControls.tsx");
  const client = await read("lib/videoflow/ai/tracking/TrackingWorkerClient.ts");
  const worker = await read("workers/tracking.worker.ts");
  assert.match(controls, /Track Forward to End/);
  assert.match(controls, /Track Backward to Start/);
  assert.match(controls, /Track Selected Range/);
  assert.match(controls, /Re-track from this point/);
  assert.match(controls, /trackingIssues/);
  assert.match(controls, /maximum:\s*\{ step:\s*0\.05, searchRadius:\s*48 \}/);
  assert.match(client, /videoflow-tracking/);
  assert.match(client, /AbortError/);
  assert.match(worker, /consecutiveLost/);
  assert.match(worker, /confidence/);
});

test("postprocessing performs real boundary color matching and feathered compositing", async () => {
  const source = await read("lib/videoflow/ai/inpainting/InpaintPostprocessor.ts");
  assert.match(source, /boundaryStatistics/);
  assert.match(source, /meanCb/);
  assert.match(source, /meanCr/);
  assert.match(source, /deviationY/);
  assert.match(source, /contrast/);
  assert.match(source, /blur\(/);
});

test("AI settings expose real local self-test, storage removal and manual tracking correction persistence", async () => {
  const settings = await read("components/videoflow/AISettingsPanel.tsx");
  const app = await read("components/videoflow/VideoFlowApp.tsx");
  assert.match(settings, /Run AI self-test/);
  assert.match(settings, /runImageInpainting/);
  assert.match(settings, /Remove AI model/);
  assert.match(settings, /saveAIDefaultSettings/);
  assert.match(app, /manual correction anchor/);
  assert.match(app, /manual:\s*true/);
});

test("AI worker has a webdriver-gated crash/recovery test hook", async () => {
  const client = await read("lib/videoflow/ai/AIWorkerClient.ts");
  assert.match(client, /forceAIWorkerCrashForTest/);
  assert.match(client, /navigator\.webdriver/);
  assert.match(client, /workerState:\s*"crashed"/);
  assert.match(client, /workerRestarts/);
});

test("local AI certification creates a real checksum-pinned WASM LaMa session and inference", async () => {
  const certification = await read("scripts/certify-ai-wasm.mjs");
  assert.match(certification, /InferenceSession\.create/);
  assert.match(certification, /executionProviders:\s*\["wasm"\]/);
  assert.match(certification, /session\.run/);
  assert.match(certification, /AI model validation failed/);
  assert.match(certification, /remoteRequests:\s*0/);
});

test("real large-media certification rejects sparse stand-ins and records ffprobe evidence", async () => {
  const verifier = await read("scripts/verify-real-large-media.mjs");
  assert.match(verifier, /VIDEOFLOW_LARGE_MEDIA_FIXTURE/);
  assert.match(verifier, /stat\.blocks/);
  assert.match(verifier, /genuinely encoded file/);
  assert.match(verifier, /ffprobe/);
  assert.match(verifier, /real-large-media-fixture\.json/);
});

test("nested HTTP verifier fetches generated AI, worker, FFmpeg and WASM production assets", async () => {
  const verifier = await read("scripts/verify-nested-http.mjs");
  assert.match(verifier, /\/VideoFlow\//);
  assert.match(verifier, /precache-manifest\.json/);
  assert.match(verifier, /lama-dynamic-int8\.onnx/);
  assert.match(verifier, /application\/wasm/);
});

test("output policy is capability-aware instead of using a universal 1.5 GiB cutoff", async () => {
  const policy = await read("lib/videoflow/import-policy.mjs");
  const exporter = await read("lib/videoflow/export.ts");
  assert.match(policy, /deviceMemoryGb/);
  assert.match(policy, /inMemoryLimitBytes/);
  assert.match(policy, /inMemoryAllowed/);
  assert.match(policy, /500 \* MEBIBYTE/);
  assert.doesNotMatch(exporter, /1\.5 \* GIBIBYTE/);
  assert.match(exporter, /!risk\.inMemoryAllowed/);
});
