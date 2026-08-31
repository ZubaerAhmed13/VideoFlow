# VideoFlow Professional Core 1.0.0 — Final Release Certification

Certification date: 2026-08-31 UTC  
Build: `1.0.0-8be338dc09e9`

## Release decision

**NOT READY.** The professional media-quality, colour, source/static, local AI, clean build, nested-hosting, security, deterministic-render, and sparse 3 GiB structural gates pass. The release rule still requires launched Chromium, Firefox, and WebKit sessions plus browser-produced 4K, offline AI, and clean-cache PWA evidence. This runner could not obtain those executables, so those gates remain **NOT VERIFIED**.

The ZIP is a complete release candidate with a fresh production build. No launch-blocked or skipped browser test is converted to PASS.

## Environment and clean build

- Ubuntu 24.04.3 LTS, Linux x86_64, approximately 15.6 GiB RAM
- Node.js 24.19.0, npm 11.9.0, FFmpeg/ffprobe 6.1.1, Playwright 1.62.1
- `npm ci`: PASS, 679 locked packages
- old `dist/` removed before final build: PASS
- production fingerprint/source match: PASS
- production app bundle: `assets/VideoFlowApp-DjLBLm4x.js`
- generated PWA precache: 24 essential assets; model intentionally excluded
- production verification: 38 files; exact AI model/runtime/workers and FFmpeg present
- nested `/VideoFlow/` HTTP verification: 27 assets PASS, including WASM MIME

## Media matrix

The status below is the controlled native output/probe gate. Browser output is listed separately and remains NOT VERIFIED.

| Output | Status |
| --- | --- |
| 480p 854×480 | PASS |
| 720p 1280×720 | PASS |
| 1080p 1920×1080 | PASS |
| 1440p 2560×1440 | PASS |
| 2K DCI 2048×1080 | PASS |
| 4K UHD 3840×2160 | PASS |
| 4K DCI 4096×2160 | PASS native / NOT VERIFIED browser |
| Custom resolution | PASS implementation/unit |
| Source/project and first-clip matching | PASS implementation/unit |
| Vertical/social presets | PASS implementation/unit |

## Frame-rate matrix

| FPS | Result |
| ---: | --- |
| 23.976 (`24000/1001`) | PASS |
| 24 | PASS |
| 25 | PASS |
| 29.97 (`30000/1001`) | PASS |
| 30 | PASS |
| 50 | PASS |
| 59.94 (`60000/1001`) | PASS |
| 60 | PASS |

All probed rates matched within 0.002 fps. Fractional NTSC values were not rounded.

## Quality and colour gates

| Capability | Status | Evidence |
| --- | --- | --- |
| Smart Copy | PASS | actual remux; video stream SHA-256 identical |
| Visually Lossless | PASS | H.264 CRF 14 slow; PSNR 56.473, SSIM 0.998295 |
| High Quality | PASS | H.264 CRF 18 medium; PSNR 55.394, SSIM 0.997799 |
| Balanced | PASS | H.264 CRF 21 medium; PSNR 54.572, SSIM 0.997444 |
| Smaller File | PASS | H.264 CRF 26 medium; PSNR 53.736, SSIM 0.997224 |
| Resolution/FPS-aware bitrate policy | PASS | scales with pixels, cadence, codec and mode |
| Rec.709 limited | PASS native / NOT VERIFIED browser | exact primaries/transfer/matrix/`tv` probe |
| Rec.709 full | PASS native / NOT VERIFIED browser | exact primaries/transfer/matrix/`pc` probe |
| Colour bars/gradients and black/white range | PASS controlled gate |
| HDR | NOT CERTIFIED | detected; effects/Canvas/AI blocked unless untouched Smart Copy is eligible |

Metrics are regression evidence on controlled fixtures, not a promise of perfect subjective reproduction.

## Audio matrix

| Capability | Status |
| --- | --- |
| Match source sample rate | PASS for certified 48 kHz source; 44.1 kHz policy/unit PASS |
| Stereo/channel preservation | PASS controlled fixture |
| Track/clip/master gain | PASS unit/render-plan |
| AAC quality presets | PASS implementation |
| A/V sync | PASS controlled 2 s fixture; duration delta 0.031367 s |
| Long timeline/browser AI sync | NOT VERIFIED |
| Stream copy where safe | PASS Smart Copy policy and native stream hash |

## AI release matrix

| Capability | Status |
| --- | --- |
| Local ONNX Runtime Web 1.29.0 | PASS |
| LaMa 512 INT8 model/checksum/license | PASS — 62,074,990 bytes; SHA-256 `cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe` |
| Genuine WASM session/inference | PASS — zero remote requests |
| WebGPU | NOT VERIFIED |
| ROI/aspect preservation/mask transform | PASS |
| Overlapping tiling/cosine blending | PASS |
| Past + future temporal context | PASS |
| Region motion estimation | PASS — local multi-block; not dense optical flow |
| Optical flow | NOT IMPLEMENTED |
| Full-range tracking/confidence/correction | PASS implementation/unit |
| Boundary luminance/chroma/contrast matching | PASS |
| Temporal consistency/outside-ROI metrics | PASS controlled/unit |
| AI intermediate | PASS — lossless PNG preferred; quality-0.96 JPEG emergency fallback disclosed |
| Bounded 4K batches | PASS implementation — two full-frame intermediates maximum |
| 4K AI browser output | NOT VERIFIED |
| Offline AI browser reload/export | NOT VERIFIED |
| Cancellation/recovery/persistence | PASS implementation/unit / NOT VERIFIED browser |

The local neural certification produced 39.57 dB PSNR and 0.9727 SSIM on its masked-gradient regression fixture. It does not claim recovery of unknowable hidden pixels.

## Large media and hosting

| Gate | Status |
| --- | --- |
| Multi-gigabyte reference/session/proxy/relink architecture | PASS |
| Sparse 3 GiB structural fixture | PASS — 3,221,225,472 logical bytes |
| Genuine encoded multi-GB workflow | NOT VERIFIED — no `VIDEOFLOW_LARGE_MEDIA_FIXTURE` supplied |
| Bounded segmented export | PASS implementation/native fragment tests |
| Direct-to-disk | PASS implementation / NOT VERIFIED browser |
| Nested GitHub Pages paths | PASS static HTTP |
| Generated PWA shell | PASS static |
| Clean-cache offline core/PWA update | NOT VERIFIED browser |

## Browser attempts

The installer was run with a 120-second connection timeout. Chromium download reached 100% of **0 MiB** twice and failed as an empty/truncated ZIP. No system browser executable was present. The production-dist suites were then executed individually:

| Browser | Passed | Failed before app launch | Skipped | Status |
| --- | ---: | ---: | ---: | --- |
| Chromium | 0 | 20 | 0 | NOT VERIFIED — executable absent |
| Firefox | 0 | 20 | 0 | NOT VERIFIED — executable absent |
| WebKit | 0 | 20 | 0 | NOT VERIFIED — executable absent |

These are infrastructure launch failures, not application failures. The gated suites include core editing, 720p/1080p/1440p/4K inspected output, exact output metadata, PWA/offline, local AI, tracking, cancellation/recovery, 4K AI, and large-media lifecycle.

## Remaining blockers

1. Run the complete Playwright matrix on a machine where all three engines can install and launch.
2. Inspect browser-produced 720p, 1080p, 1440p, 4K core, and 4K AI outputs including FPS, colour metadata, audio, and quality.
3. Complete clean-profile offline core and installed-model offline AI restart/export.
4. Supply a genuine non-sparse multi-gigabyte encoded source for the optional real large-media certification.

Until those observations exist, the correct status is **NOT READY**.
