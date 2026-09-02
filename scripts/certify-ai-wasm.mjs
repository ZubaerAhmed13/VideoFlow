import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const runtimeDirectory = join(root, "public", "vendor", "onnx");
const allowedRuntimeFiles = new Set([
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
]);
for (const file of allowedRuntimeFiles) {
  if (!existsSync(join(runtimeDirectory, file))) throw new Error(`Local ONNX runtime is incomplete: ${file}`);
}

const specs = [
  {
    role: "production-final",
    model: "LaMa 512 INT8 ONNX",
    version: "g-ronimo-8e20140",
    license: "Apache-2.0",
    path: join(root, "public", "models", "lama-512-int8.onnx"),
    sha256: "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe",
    bytes: 62_074_990,
    size: 512,
  },
  {
    role: "interactive-preview-accelerator",
    model: "LaMa Dynamic INT8 ONNX",
    version: "g-ronimo-dynamic",
    license: "Apache-2.0",
    path: join(root, "public", "models", "lama-dynamic-int8.onnx"),
    sha256: "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
    bytes: 61_512_617,
    size: 256,
  },
];

const ort = await import("../public/vendor/onnx/ort.webgpu.bundle.min.mjs");
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  mjs: pathToFileURL(join(runtimeDirectory, "ort-wasm-simd-threaded.jsep.mjs")).href,
  wasm: join(runtimeDirectory, "ort-wasm-simd-threaded.jsep.wasm"),
};

async function certify(spec) {
  const model = readFileSync(spec.path);
  if (model.byteLength !== spec.bytes) throw new Error(`AI model validation failed: ${spec.model} size mismatch.`);
  const sha256 = createHash("sha256").update(model).digest("hex");
  if (sha256 !== spec.sha256) throw new Error(`AI model validation failed: ${spec.model} checksum mismatch.`);

  const sessionStart = performance.now();
  const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"] });
  const sessionMs = performance.now() - sessionStart;
  const size = spec.size;
  const pixels = size * size;
  const feeds = {};
  const cleanTarget = new Float32Array(3 * pixels);
  const certificationMask = new Float32Array(pixels);
  const x0 = Math.floor(size * 0.37);
  const x1 = Math.floor(size * 0.63);
  const y0 = Math.floor(size * 0.40);
  const y1 = Math.floor(size * 0.60);

  if (session.inputNames.length === 1) {
    const packed = new Float32Array(4 * pixels);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const pixel = y * size + x;
        const hole = x >= x0 && x < x1 && y >= y0 && y < y1 ? 1 : 0;
        cleanTarget[pixel] = 0.2 + 0.6 * x / (size - 1);
        cleanTarget[pixels + pixel] = 0.25 + 0.5 * y / (size - 1);
        cleanTarget[pixels * 2 + pixel] = 0.55;
        certificationMask[pixel] = hole;
        packed[pixel] = cleanTarget[pixel] * (1 - hole);
        packed[pixels + pixel] = cleanTarget[pixels + pixel] * (1 - hole);
        packed[pixels * 2 + pixel] = cleanTarget[pixels * 2 + pixel] * (1 - hole);
        packed[pixels * 3 + pixel] = hole;
      }
    }
    feeds[session.inputNames[0]] = new ort.Tensor("float32", packed, [1, 4, size, size]);
  } else {
    const rgb = new Float32Array(3 * pixels);
    const mask = new Float32Array(pixels);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const pixel = y * size + x;
        cleanTarget[pixel] = rgb[pixel] = 0.2 + 0.6 * x / (size - 1);
        cleanTarget[pixels + pixel] = rgb[pixels + pixel] = 0.25 + 0.5 * y / (size - 1);
        cleanTarget[pixels * 2 + pixel] = rgb[pixels * 2 + pixel] = 0.55;
        mask[pixel] = x >= x0 && x < x1 && y >= y0 && y < y1 ? 1 : 0;
        certificationMask[pixel] = mask[pixel];
      }
    }
    feeds[session.inputNames[0]] = new ort.Tensor("float32", rgb, [1, 3, size, size]);
    feeds[session.inputNames[1]] = new ort.Tensor("float32", mask, [1, 1, size, size]);
  }

  const inferenceStart = performance.now();
  const output = await session.run(feeds);
  const inferenceMs = performance.now() - inferenceStart;
  const tensor = output[session.outputNames[0]] ?? Object.values(output)[0];
  if (!tensor?.data || tensor.data.length < pixels * 3) throw new Error(`${spec.model} returned an invalid output tensor.`);
  const sampled = Array.from({ length: 64 }, (_, index) => Number(tensor.data[Math.floor(index * tensor.data.length / 64)]));
  if (!sampled.every(Number.isFinite)) throw new Error(`${spec.model} produced non-finite output values.`);
  const outputScale = Math.max(...sampled.map(Math.abs)) <= 1.5 ? 255 : 1;

  let samples = 0;
  let squaredError = 0;
  let actualMean = 0;
  let targetMean = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (certificationMask[pixel] < 0.5) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = channel * pixels + pixel;
      const actual = Math.max(0, Math.min(255, Number(tensor.data[index]) * outputScale));
      const target = cleanTarget[index] * 255;
      squaredError += (actual - target) ** 2;
      actualMean += actual;
      targetMean += target;
      samples += 1;
    }
  }
  actualMean /= samples;
  targetMean /= samples;
  let actualVariance = 0;
  let targetVariance = 0;
  let covariance = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (certificationMask[pixel] < 0.5) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = channel * pixels + pixel;
      const actual = Math.max(0, Math.min(255, Number(tensor.data[index]) * outputScale));
      const target = cleanTarget[index] * 255;
      actualVariance += (actual - actualMean) ** 2;
      targetVariance += (target - targetMean) ** 2;
      covariance += (actual - actualMean) * (target - targetMean);
    }
  }
  const mse = squaredError / samples;
  const psnr = mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10(255 ** 2 / mse);
  actualVariance /= Math.max(1, samples - 1);
  targetVariance /= Math.max(1, samples - 1);
  covariance /= Math.max(1, samples - 1);
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const ssim = ((2 * actualMean * targetMean + c1) * (2 * covariance + c2)) /
    ((actualMean ** 2 + targetMean ** 2 + c1) * (actualVariance + targetVariance + c2));
  if (psnr < 10 || ssim < 0.2) {
    throw new Error(`${spec.model} controlled quality regression: PSNR ${psnr.toFixed(2)} dB, SSIM ${ssim.toFixed(4)}.`);
  }

  const evidence = {
    role: spec.role,
    model: spec.model,
    version: spec.version,
    license: spec.license,
    modelBytes: model.byteLength,
    modelSha256: sha256,
    inputSize: size,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    outputElements: tensor.data.length,
    sessionMs,
    inferenceMs,
    controlledMaskedPsnrDb: psnr,
    controlledMaskedSsim: ssim,
  };
  await session.release();
  return evidence;
}

const productionModel = await certify(specs[0]);
const previewModel = await certify(specs[1]);
const evidence = {
  certifiedAt: new Date().toISOString(),
  runtime: "ONNX Runtime Web 1.29.0 local bundle",
  provider: "wasm",
  productionModel,
  previewModel,
  finalInferenceSize: 512,
  interactiveWasmPreviewSize: 256,
  qualityThresholds: { minimumPsnrDb: 10, minimumSsim: 0.2 },
  remoteRequests: 0,
};
mkdirSync(join(root, "ci-results"), { recursive: true });
writeFileSync(join(root, "ci-results", "ai-wasm-certification.json"), `${JSON.stringify(evidence, null, 2)}
`);
console.log(JSON.stringify(evidence, null, 2));
