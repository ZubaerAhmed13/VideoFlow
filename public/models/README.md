# VideoFlow AI Reconstruction Pack

The release does not auto-download or auto-precache the large model. Use **Install bundled AI** in Settings or Watermark Studio; VideoFlow verifies the bundled bytes before copying them into its protected local cache. Manual installation accepts only the same descriptor/checksum.

Certified descriptor target:
- Model: LaMa 512 INT8 (`lama_512_int8.onnx`)
- License: Apache-2.0
- SHA-256: `cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe`
- Expected size: 62,074,990 bytes

ONNX Runtime Web 1.29.0 files are hosted locally in `public/vendor/onnx/`. VideoFlow never uploads media, masks, or model tensors.
