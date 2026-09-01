# VideoFlow local AI model pack

VideoFlow uses a checksum-pinned **LaMa Dynamic INT8 ONNX** model. The model is not automatically downloaded or precached by the PWA shell. The user explicitly chooses **Install bundled AI**, after which VideoFlow validates the exact byte size and SHA-256 digest before storing the model in protected local Cache Storage.

- File: `lama-dynamic-int8.onnx`
- Source: `https://huggingface.co/g-ronimo/lama/blob/main/lama_int8.onnx`
- License: Apache-2.0
- Size: 61,512,617 bytes
- SHA-256: `1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972`
- Interactive preview: 256x256 ROI inference for bounded latency
- Final/high-quality reconstruction and certification: 512x512 ROI inference

The dynamic graph was release-benchmarked at both sizes. 512x512 output parity against the previous fixed-512 export was numerically equivalent within floating-point noise; release certification continues to exercise genuine 512x512 WASM inference.
