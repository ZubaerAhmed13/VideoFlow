import type { AIModelDescriptor } from "./types";

// Production/final model: fixed 512x512 graph with FFTs replaced by matmuls.
// Upstream documents this variant as ~1.8x faster than lama_int8.onnx on CPU/WASM
// with identical output, so final/high-quality reconstruction stays on this graph.
export const LAMA_512_INT8: AIModelDescriptor = {
  id: "lama-512-int8",
  name: "LaMa 512 INT8",
  version: "g-ronimo-8e20140",
  license: "Apache-2.0",
  source: "https://huggingface.co/g-ronimo/lama/blob/main/lama_512_int8.onnx",
  sha256: "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe",
  size: 62074990,
  inputWidth: 512,
  inputHeight: 512,
  imageInput: "input",
  maskInput: "",
  output: "output",
};

// Interactive CPU/WASM accelerator: same LaMa family with dynamic H/W.
// VideoFlow uses this graph at 256x256 only for interactive preview/recovery.
// Project/export metadata continues to reference LAMA_512_INT8.
export const LAMA_DYNAMIC_INT8: AIModelDescriptor = {
  id: "lama-dynamic-int8",
  name: "LaMa Dynamic INT8",
  version: "g-ronimo-dynamic",
  license: "Apache-2.0",
  source: "https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx",
  sha256: "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
  size: 61512617,
  inputWidth: 256,
  inputHeight: 256,
  imageInput: "input",
  maskInput: "",
  output: "output",
};

export const AI_MODELS = [LAMA_512_INT8, LAMA_DYNAMIC_INT8] as const;
export const DEFAULT_AI_MODEL = LAMA_512_INT8;
export const PREVIEW_AI_MODEL = LAMA_DYNAMIC_INT8;

export function modelForInferenceSize(size: 256 | 512): AIModelDescriptor {
  return size === 256 ? PREVIEW_AI_MODEL : DEFAULT_AI_MODEL;
}
