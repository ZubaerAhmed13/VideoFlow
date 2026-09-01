# VideoFlow Professional Core 1.0.0 — AI Reconstruction

## Status and boundary

The release candidate contains a genuine local neural-inpainting pipeline and a checksum-valid LaMa model. Local ONNX Runtime Web WASM session creation and inference passed outside the browser. Browser WebGPU, offline-cache reload, 4K AI export and visual browser certification are **NOT VERIFIED** in the current runner, so the overall release remains NOT READY.

Blur, Pixelate, Cover and Clone are separate non-neural tools and are never reported as AI. Reconstruction produces plausible replacement pixels; it does not recover permanently occluded originals.

## Model pack

| Field | Value |
| --- | --- |
| Model | LaMa Dynamic INT8 ONNX |
| Version | `g-ronimo-dynamic` |
| License | Apache-2.0 |
| Path | `models/lama-dynamic-int8.onnx` under the deployment base |
| Expected size | 61,512,617 bytes |
| SHA-256 | `1941214c210399eb815eb2d32570ba91d5e6c4ac3de4c939bd3fb09300454972` |
| Metadata | `models/lama-dynamic-int8.model.json` |
| Notices | `models/MODEL_LICENSE_NOTICE.md` |

The bundled model is optional at PWA-install time. **Install bundled AI** loads it from the same deployment origin, checks exact size and SHA-256, and only then stores it in the protected local AI cache. An invalid file reports `AI model validation failed.` and no session is created. A user can instead install the exact model file through Settings → AI.

After successful installation, model loading and inference use the protected local cache. The ONNX runtime modules/WASM are ordinary local application assets and part of the generated core precache. No CDN, inference API, telemetry endpoint or hidden remote model URL is used.

## Runtime

- ONNX Runtime Web 1.29.0 is stored under `vendor/onnx/`.
- Runtime/model URLs are resolved through the deployment base, including nested GitHub Pages paths.
- WebGPU is selected only after adapter/device initialization succeeds.
- WASM is the fallback and was genuinely executed in the local certification.
- The inference worker reuses its session, reports real provider/duration/ROI values, and retries once after an unexpected crash.
- Cancellation terminates active workers, rejects pending work and releases decoded frames, canvases, model tensors and temporary FFmpeg files.

## ROI and mask geometry

The neural model never receives an entire 4K frame. A normalized watermark mask becomes a padded source-resolution ROI.

An 800×200 ROI is processed as:

```text
800×200 → scale 0.64 → 512×128 → pad 192px top + 192px bottom → 512×512
```

The recorded transform contains original size, scaled size, four padding values and scale. RGB and mask use the same transform. Inference padding is removed before the patch is restored to the original ROI dimensions.

Large ROIs use quality-dependent overlapping tiles. Overlap is never zero when tiling is active; cosine feather weights blend shared areas. The reconstructed patch is then composited into the original-resolution source frame.

## Bidirectional temporal reconstruction

Long media uses a bounded sliding window rather than a full-frame array. A balanced target can use:

```text
t-4  t-3  t-2  t-1  [t]  t+1  t+2  t+3  t+4
```

The renderer decodes only enough lookahead to finalize the target, releases frames behind the window immediately, and includes temporal overlap at segmented-render boundaries. Future source/reconstruction patches can therefore contribute when a background becomes visible after the target frame.

Quality modes change real parameters:

| Mode | Temporal window | ROI/tiling | Tracking refinement | Consistency |
| --- | --- | --- | --- | --- |
| Fast | 3–5 frames | smaller padding, later tiling | 0.25 s / 24 px | light |
| Balanced | 7–9 frames | 64 px overlap strategy | 0.125 s / 32 px | normal |
| High | 11–15 frames | 72 px overlap strategy | 0.08 s / 40 px | stronger |
| Maximum | adaptive 15–17 frames | 96 px overlap strategy | 0.05 s / 48 px | strongest with motion guard |

## Motion and temporal consistency

The implementation uses a robust local multi-block motion field over the ROI with coarse global translation as fallback. This is region-aware classical motion estimation; it is **not dense optical flow** and is documented accordingly.

Past and future patches are motion-aligned before blending. Confidence, bidirectional disagreement and reconstruction variance reduce the blend when motion is unreliable, which limits ghost trails. High disagreement favors the current neural result.

## Tracking

Watermark Studio supports:

- Track Forward to End
- Track Backward to Start
- Track Selected Range
- Re-track from this point
- real percentage/time progress and cancellation
- persisted per-point confidence and grouped low-confidence ranges
- automatic stop after repeated confidence loss
- Review navigation and manual correction
- manual correction points as trusted anchors
- saved trajectory, method, issues, active range, mask timing and model version

Tracking is template/local-block based. It does not claim semantic object tracking or dense optical flow.

## Boundary treatment

A narrow band outside the active mask supplies mean luminance, chroma and contrast statistics. The reconstructed patch receives a capped correction to avoid over-adjustment, then mask expansion, feathering and alpha blending hide the boundary. Pixels outside the compositing mask are not intentionally modified.

## 4K and memory

AI export is integrated with bounded rendering. It holds only a sliding temporal set of ROI results and a short encoded micro-batch. At 4K the batch is capped at two frames; hundreds of full-resolution frames are never accumulated.

The professional path now uses lossless PNG micro-batches before local FFmpeg encoding. If Canvas cannot produce PNG, VideoFlow flushes the current batch and uses a bounded quality-0.96 JPEG emergency fallback; diagnostics then reports `JPEG fallback` rather than implying losslessness. A future direct `VideoFrame`/WebCodecs muxer can remove even the lossless image-container step. Encoded batch outputs are concatenated locally and released segment by segment.

Tracking/masks are normalized in clip-source coordinates, so proxy dimensions scale back to the original automatically. AI reconstruction happens on the original source before downstream crop/rotation/project transforms. Final 4K settings retain 3840×2160; a proxy result is never permanently upscaled as the master.

## Preview, settings and diagnostics

Current-frame and 2/5/10-second previews use the same ROI, tiling, temporal and blending configuration as export where practical. Before/After/Split views are included. The cache key includes source, playhead, mask geometry, tracking, quality, model, temporal settings, feather and ROI padding.

Settings → AI shows model/version/checksum/size, local runtime, provider, default quality, WebGPU/WASM capability, inference ROI, temporal context, recent duration, tile count and worker state/restarts. The self-test covers local runtime/model, ROI/mask/restore, WASM inference, WebGPU when present, past+future context and cancellation.

AI currently requires SDR-compatible processing. HDR input is detected and blocked from the Canvas/AI path because LaMa consumes normalized SDR RGB and the 1.0 pipeline does not claim a verified reversible HDR transform.

## Certification evidence and limitations

The local WASM certification created the real model session and ran inference with zero remote requests. On a controlled masked-gradient ground truth it measured 39.57 dB PSNR and 0.9727 SSIM. These metrics are regression checks, not a universal quality guarantee.

Browser-produced 4K AI, offline installed-model reload, tracking trajectory, cancellation and crash-recovery E2E are present in the Playwright suite but were not executable in this environment because browser binaries could not be installed. See `RELEASE_CERTIFICATION.md`.
