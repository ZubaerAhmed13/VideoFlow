# VideoFlow AI Reconstruction Pack

VideoFlow uses two checksum-pinned Apache-2.0 LaMa ONNX models for different jobs without reducing final reconstruction quality:

- `lama-512-int8.onnx` — **production/final model**, fixed 512×512. Upstream replaces FFT operations with fixed-size matmuls and documents about 1.8× faster CPU/WASM inference than the dynamic INT8 graph with identical output.
- `lama-dynamic-int8.onnx` — **interactive preview accelerator**, arbitrary H/W. VideoFlow uses 256×256 only when an interactive preview is running on WASM; final/export reconstruction never switches down to 256.

The PWA shell does **not** automatically precache either large ONNX model. **Install bundled AI** explicitly validates both SHA-256 digests and copies the pack into protected local Cache Storage. Local runtime modules/WASM remain part of the offline app shell.
