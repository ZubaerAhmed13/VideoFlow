import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, relative } from "node:path";
import { computeSourceFingerprint } from "./generate-build-info.mjs";

const root = process.cwd();
const output = existsSync(join(root, "dist", "client", "index.html"))
  ? join(root, "dist", "client")
  : join(root, "dist");
const required = [
  "index.html",
  "manifest.webmanifest",
  "service-worker.js",
  "precache-manifest.json",
  "favicon.svg",
  "build-info.json",
  "vendor/ffmpeg/ffmpeg-core.js",
  "vendor/ffmpeg/ffmpeg-core.wasm",
];
for (const name of required)
  assert.ok(existsSync(join(output, name)), `Missing release asset: ${name}`);
const ffmpegCoreModule = readFileSync(join(output, "vendor/ffmpeg/ffmpeg-core.js"), "utf8");
assert.match(ffmpegCoreModule, /export default createFFmpegCore/, "FFmpeg core must be the ESM build used by the module worker");

function assertWasmMagic(name) {
  const bytes = readFileSync(join(output, name));
  assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], `${name} is not a WebAssembly binary`);
}
assertWasmMagic("vendor/ffmpeg/ffmpeg-core.wasm");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const buildInfo = JSON.parse(readFileSync(join(output, "build-info.json"), "utf8"));
assert.equal(buildInfo.version, packageJson.version, "Production version does not match source package version");
assert.equal(buildInfo.sourceHash, computeSourceFingerprint(), "Production build fingerprint is stale relative to source");

const requireAI = process.env.VIDEOFLOW_REQUIRE_AI_PACK === "1";
if (requireAI) {
  const aiRequired = [
    "models/lama-512-int8.onnx",
    "models/lama-512-int8.model.json",
    "vendor/onnx/ort.webgpu.bundle.min.mjs",
    "vendor/onnx/ort-wasm-simd-threaded.asyncify.mjs",
    "vendor/onnx/ort-wasm-simd-threaded.asyncify.wasm",
    "vendor/onnx/ort-wasm-simd-threaded.jsep.mjs",
    "vendor/onnx/ort-wasm-simd-threaded.jsep.wasm",
    "vendor/onnx/ort-wasm-simd-threaded.jspi.mjs",
    "vendor/onnx/ort-wasm-simd-threaded.jspi.wasm",
    "vendor/onnx/ort-wasm-simd-threaded.mjs",
    "vendor/onnx/ort-wasm-simd-threaded.wasm",
  ];
  for (const name of aiRequired) assert.ok(existsSync(join(output, name)), `Missing AI release asset: ${name}`);
  for (const name of ["asyncify", "jsep", "jspi"]) {
    assertWasmMagic(`vendor/onnx/ort-wasm-simd-threaded.${name}.wasm`);
  }
  assertWasmMagic("vendor/onnx/ort-wasm-simd-threaded.wasm");
  const modelBytes = readFileSync(join(output, "models/lama-512-int8.onnx"));
  const modelSha = createHash("sha256").update(modelBytes).digest("hex");
  assert.equal(modelSha, "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe", "AI model checksum mismatch in production dist");
  assert.equal(modelBytes.byteLength, 62074990, "AI model size mismatch in production dist");
}

const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(output);
if (requireAI) {
  const productionJavaScript = files
    .filter((path) => [".js", ".mjs"].includes(extname(path)))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  for (const marker of [
    "LaMa 512 INT8",
    "videoflow-ai-inference",
    "videoflow-tracking",
    "local-multiblock",
    "AI model validation failed",
    "Install bundled AI",
    "past + future context",
  ]) assert.ok(productionJavaScript.includes(marker), `Fresh production bundle is missing AI marker: ${marker}`);
}
for (const path of files) {
  if (![".html", ".js", ".css", ".webmanifest"].includes(extname(path))) continue;
  const source = readFileSync(path, "utf8");
  assert.doesNotMatch(
    source,
    /(?:src|href)=["']\/(?!\/)|["']\/(?:service-worker\.js|manifest\.webmanifest|vendor\/ffmpeg\/)/,
    `Root-relative deployment URL in ${relative(output, path)}`,
  );

  assert.doesNotMatch(
    source,
    /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i,
    `External runtime asset dependency in ${relative(output, path)}`,
  );
  assert.doesNotMatch(
    source,
    /(?:@import\s+(?:url\()?|url\()\s*["\'`]?https?:\/\/|(?:fetch|import|new\s+Worker)\(\s*["\'`]https?:\/\//i,
    `External runtime fetch/import in ${relative(output, path)}`,
  );
  assert.doesNotMatch(
    source,
    /(?:google-analytics|googletagmanager|segment\.com|mixpanel|sentry\.io|plausible\.io)/i,
    `Analytics/telemetry reference in ${relative(output, path)}`,
  );
}
const manifest = JSON.parse(readFileSync(join(output, "manifest.webmanifest"), "utf8"));
assert.equal(manifest.start_url, "./");
assert.equal(manifest.scope, "./");
const wasm = statSync(join(output, "vendor/ffmpeg/ffmpeg-core.wasm"));
assert.ok(wasm.size > 1_000_000, "Packaged FFmpeg core is incomplete");
assert.ok(!existsSync(join(output, "vendor/ffmpeg/ffmpeg-core.wasm.gz")), "Release must not require gzip-expanded WASM at runtime");
const precache = JSON.parse(readFileSync(join(output, "precache-manifest.json"), "utf8"));
assert.ok(Array.isArray(precache), "PWA precache manifest must be an array");
assert.ok(!precache.some((entry) => /models\/.*\.onnx/i.test(String(entry))), "Large AI models must not be automatically precached with the core shell");
if (requireAI) {
  assert.ok(precache.some((entry) => /vendor\/onnx\/ort\.webgpu\.bundle\.min\.mjs/i.test(String(entry))), "ONNX runtime module must be part of the generated offline shell");
  assert.ok(precache.some((entry) => /vendor\/onnx\/.*\.wasm/i.test(String(entry))), "ONNX WASM fallback must be part of the generated offline shell");
}
const serviceWorker = readFileSync(join(output, "service-worker.js"), "utf8");
assert.match(serviceWorker, /vendor\/ffmpeg\/ffmpeg-core\.wasm/);
assert.match(serviceWorker, /precache-manifest\.json/);
assert.match(serviceWorker, /videoflow-ai-/);
assert.doesNotMatch(serviceWorker, /(?:user-media|indexeddb)/i, "Service worker must not cache user media/data routes");
assert.match(serviceWorker, /!event\.request\.url\.startsWith\("blob:"\)/, "Service worker must explicitly exclude Blob media URLs");
console.log(`Release verified: ${files.length} files, nested-path-safe app shell.`);
