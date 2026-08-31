# VideoFlow AI Reconstruction Pack

The final release includes the checksum-pinned LaMa 512 INT8 ONNX model at `public/models/lama-512-int8.onnx`; a fresh build copies it to `dist/client/models/lama-512-int8.onnx`. The app does not automatically download or precache the model. The user explicitly installs it into protected local Cache Storage.

Model metadata:

- Model: LaMa 512 INT8 ONNX
- License: Apache-2.0
- Expected SHA-256: `cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe`
- Expected size: `62,074,990` bytes
- Browser runtime: ONNX Runtime Web 1.29.0, packaged locally under `public/vendor/onnx/`
- Staging script: `scripts/stage-ai-pack-ci.sh`

The app validates the complete model checksum before installing it into the local AI cache and again before inference. After local installation, inference, tracking, preview and export require no network. Blur, pixelate, cover and clone remain available even if the model is removed.
