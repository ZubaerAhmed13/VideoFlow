# VideoFlow AI Reconstruction Pack

The final release includes the checksum-pinned LaMa Dynamic INT8 ONNX model at `public/models/lama-dynamic-int8.onnx`; a fresh build copies it to `dist/client/models/lama-dynamic-int8.onnx`. The app does not automatically download or precache the model. The user explicitly installs it into protected local Cache Storage.

Model metadata:

- Model: LaMa Dynamic INT8 ONNX
- License: Apache-2.0
- Expected SHA-256: `1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972`
- Expected size: `61,512,617` bytes
- Browser runtime: ONNX Runtime Web 1.29.0, packaged locally under `public/vendor/onnx/`
- Staging script: `scripts/stage-ai-pack-ci.sh`

The app validates the complete model checksum before installing it into the local AI cache and again before inference. After local installation, inference, tracking, preview and export require no network. Blur, pixelate, cover and clone remain available even if the model is removed.
