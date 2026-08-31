# VideoFlow Professional Core 1.0.0 — Media Quality Certification

Certification date: 2026-08-31 UTC

## Quality policy

The default export is Source/Project resolution, Source/Project frame rate, High Quality, recommended codec, Match Source audio sample rate, and Preserve colour. A first imported video initializes a new project from its exact probed width, height, and average frame rate, including 24000/1001, 30000/1001, and 60000/1001.

| Quality mode | H.264 | VP9 | Purpose |
| --- | --- | --- | --- |
| Source / Smart Copy | `-c copy` only when provably safe | `-c copy` only when provably safe | untouched complete compatible source |
| Visually Lossless | CRF 14, slow | CRF 16 | highest practical generation quality |
| High Quality | CRF 18, medium | CRF 22 | safe default |
| Balanced | CRF 21, medium | CRF 28 | quality/size balance |
| Smaller File | CRF 26, medium | CRF 36 | compression-oriented |
| Custom | explicit bitrate | explicit bitrate | advanced control |

“Visually Lossless” is not described as mathematically lossless. Resolution/FPS-aware estimates scale with pixel count, cadence, codec, and quality; 4K60 no longer inherits a 720p30 bitrate.

## Controlled native gate

Command: `npm run cert:quality`

| Matrix | Result |
| --- | --- |
| 480p, 720p, 1080p, 1440p, 2K DCI, 4K UHD, 4K DCI | PASS — generated and probed exact dimensions |
| 23.976, 24, 25, 29.97, 30, 50, 59.94, 60 fps | PASS — exact rational cadence within 0.002 fps |
| Rec.709 limited | PASS — primaries/transfer/matrix/range probed |
| Rec.709 full | PASS — primaries/transfer/matrix/range probed |
| Visually Lossless H.264 CRF 14 | PASS — PSNR 56.473 dB, SSIM 0.998295 on controlled multicolour gradients |
| High Quality H.264 CRF 18 | PASS — PSNR 55.394 dB, SSIM 0.997799 |
| Balanced H.264 CRF 21 | PASS — PSNR 54.572 dB, SSIM 0.997444 |
| Smaller File H.264 CRF 26 | PASS — PSNR 53.736 dB, SSIM 0.997224 |
| Smart Copy | PASS — decoded video stream SHA-256 identical before/after remux |
| 48 kHz stereo AAC and A/V alignment | PASS — sample rate/channels preserved; duration delta ≤ 0.05 s |

PSNR and SSIM are regression thresholds on a controlled gradient/colour fixture, not claims of visual perfection. Motion/detail fixtures, black/white levels, and colour bars are separately represented by generated fixtures and metadata/range tests.

## Smart Copy safety

Smart Copy activates only for one untouched full-length video whose source dimensions, exact frame rate, container, stream presence, gain/mute state, and selected export range are compatible. Crop, transform, text, masks, AI, keyframes, fades, speed changes, mixing, accurate sub-range trim, resolution conversion, or FPS conversion falls back to a High Quality deterministic re-encode. It is reported as “Original compressed stream,” not as mathematical losslessness of the entire container.

## Scaling, overlays, proxy, and AI

- intentional resize uses Lanczos scaling; nearest-neighbour is reserved for Pixelate
- crop precedes scaling and does not resample unless the composition size requires it
- text and generated overlays are rasterized at final project resolution
- final export requires original sources; a proxy is never silently promoted to the master
- AI modifies only the masked compositing region; outside-ROI tests compare against the equivalent normally re-encoded control
- AI export prefers lossless PNG micro-batches, capped at two frames for 4K, then local FFmpeg encoding; quality-0.96 JPEG is an explicitly reported emergency fallback
- every segmented render uses one deterministic codec/FPS/pixel-format/colour/audio policy and retains temporal overlap for AI boundaries

## Post-export validation

Every completed output is probed for container, video/audio codec, width, height, exact average frame rate, duration, audio duration, sample rate, channels, pixel format, colour primaries, transfer, matrix, and range where available. Unexpected resolution, cadence, colour metadata, sample rate, stream presence, or A/V duration alignment fails the job.

## Browser boundary

The Playwright production suite contains inspected 720p, 1080p, 1440p, 4K, PWA/offline, and 4K AI downloads. Results are reported only when browser executables launch. Native fixture certification is not substituted for real browser output; see `BROWSER_SUPPORT.md` and `RELEASE_CERTIFICATION.md`.
