import type { AIModelDescriptor } from "./types";

// Apache-2.0 quantized LaMa export with dynamic spatial dimensions.
// VideoFlow uses 256x256 for interactive previews and 512x512 for final/high-quality inference.
export const LAMA_DYNAMIC_INT8: AIModelDescriptor = {
  id: "lama-dynamic-int8",
  name: "LaMa Dynamic INT8",
  version: "g-ronimo-dynamic",
  license: "Apache-2.0",
  source: "https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx",
  sha256: "1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972",
  size: 61512617,
  inputWidth: 512,
  inputHeight: 512,
  imageInput: "input",
  maskInput: "",
  output: "output",
};

export const AI_MODELS = [LAMA_DYNAMIC_INT8] as const;
export const DEFAULT_AI_MODEL = LAMA_DYNAMIC_INT8;
