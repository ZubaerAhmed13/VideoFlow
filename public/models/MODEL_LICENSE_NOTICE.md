# LaMa model notices

VideoFlow bundles two Apache-2.0 ONNX exports from the same g-ronimo/LaMa model family:

1. **LaMa 512 INT8** (`lama_512_int8.onnx`) — production/final fixed 512×512 model.
2. **LaMa Dynamic INT8** (`lama_int8.onnx`) — interactive 256×256 preview accelerator on CPU/WASM.

Upstream project: LaMa — Resolution-robust Large Mask Inpainting with Fourier Convolutions.
Export source: https://huggingface.co/g-ronimo/lama
Declared license: Apache-2.0.

VideoFlow does not imply that neural inpainting recovers hidden original pixels; it generates plausible reconstruction from visible context.
