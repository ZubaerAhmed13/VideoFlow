import type { AIModelDescriptor } from "./types";

// Apache-2.0 browser-friendly 512x512 quantized LaMa export.
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

export const AI_MODELS = [LAMA_512_INT8] as const;
export const DEFAULT_AI_MODEL = LAMA_512_INT8;
