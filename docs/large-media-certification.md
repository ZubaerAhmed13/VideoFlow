# VideoFlow Professional Core 1.0.0 — Large Media Certification

Certification date: 2026-08-31 UTC

## Status

- multi-gigabyte reference/session/proxy/relink architecture: **PASS**
- sparse 3 GiB structural fixture generation and ffprobe: **PASS**
- genuine long encoded multi-gigabyte source: **NOT VERIFIED**
- browser lifecycle and original-quality range output: **NOT VERIFIED**
- product wording: **Large-media optimized with multi-gigabyte reference workflows and 4K proxy editing.**

No “unlimited” claim is made.

## 4K fixture

The deterministic real encoded fixture at `tests/fixtures/generated/uhd-4k-5s.mp4` is:

- 13,429,116 bytes
- 3840×2160
- H.264 video and AAC audio
- 24 fps
- 5.000 seconds

Generation and ffprobe passed. Browser export remains NOT VERIFIED because no browser executable was available.

## Sparse 3 GiB structural fixture

`npm run cert:media` creates `outputs/certification/large-3gb-4k-sparse.mp4`:

- logical size: 3,221,225,472 bytes
- valid real 3840×2160 H.264/AAC payload
- sparse extension used only to exercise File/File-handle size policy
- ffprobe: PASS

This fixture is explicitly **not** a genuinely long 3 GiB encode and is never used to certify that claim.

## Genuine encoded fixture path

Use a non-sparse external file without committing it:

```bash
VIDEOFLOW_LARGE_MEDIA_FIXTURE=/absolute/path/to/long-large-video.mp4 \
  npm run cert:large-media:real

VIDEOFLOW_LARGE_MEDIA_FIXTURE=/absolute/path/to/long-large-video.mp4 \
VIDEOFLOW_LARGE_MEDIA_RANGE_START=4200 \
VIDEOFLOW_LARGE_MEDIA_RANGE_END=4260 \
  npx playwright test tests/e2e/large-media.spec.ts --project=chromium
```

The verifier requires, by default:

- a regular file of at least 1 GiB
- at least 60 seconds duration
- physical allocation of at least 90% of logical size, rejecting sparse stand-ins
- a decodable video stream through ffprobe

Thresholds can be raised with `VIDEOFLOW_LARGE_MEDIA_MIN_BYTES` and `VIDEOFLOW_LARGE_MEDIA_MIN_SECONDS`. Evidence is written to `ci-results/real-large-media-fixture.json`.

No qualifying external fixture was supplied in this environment, so the status is **NOT VERIFIED**.

## Architecture evidence

PASS at source/unit/integration level:

- explicit persisted, reference and session storage modes
- supporting browsers can retain a FileSystemFileHandle without copying the original into IndexedDB
- session/relink fallback keeps metadata and project edits without storing the original Blob
- sampled SHA-256 fingerprints read 4 MiB at the beginning, middle and end instead of hashing an entire multi-gigabyte source
- proxy media is persisted independently and preferred for preview/waveform/tracking
- reopening keeps an unavailable original offline while preserving its proxy and timeline state
- relink validates identity and never silently accepts a suspicious replacement
- final original-quality export is blocked until required originals are online
- WORKERFS mounts large originals read-only for FFmpeg without whole-file JavaScript copies

## Bounded render and output policy

PASS at source/unit/integration level:

- deterministic range slicing and keyframe/mask projection
- adaptive segmented MP4 direct-to-disk where File System Access is available
- fragmented-MP4 compatibility checks, timestamp/sequence patching and incremental writes
- AI temporal overlap is included around render segments and duplicate context output is discarded
- AI holds a sliding ROI window and short micro-batches, not hundreds of 4K frames
- high-risk output prefers direct-to-disk for 4K, AI, long media and estimated 500 MB+ results
- conservative in-memory policy warns or blocks an unsafe giant Blob
- Firefox/WebKit use a bounded standard-download fallback when direct-to-disk is unavailable

## Proxy and original coordinates

Masks/tracking are stored as normalized clip-source coordinates. Proxy dimensions therefore map proportionally back to the original, while final reconstruction reads the original source and composites before the clip's crop/rotation/project transforms. A 960×540 proxy for a 3840×2160 original maps by 4× in both axes without baking a proxy upscale into the master.

## Required real browser lifecycle

| Step | Status in this runner |
| --- | --- |
| Import external multi-gigabyte encoded source | NOT VERIFIED |
| Reference/session mode without whole-file IndexedDB copy | PASS architecture / NOT VERIFIED browser |
| Generate and persist proxy | PASS implementation / NOT VERIFIED browser |
| Save, close/reopen and restore proxy | PASS implementation / NOT VERIFIED browser |
| Relink original | PASS implementation / NOT VERIFIED browser |
| Track selected watermark range | PASS implementation / NOT VERIFIED browser |
| Bounded original-source 4K AI range export | PASS implementation / NOT VERIFIED browser |
| Download and ffprobe output/audio | E2E gate present / NOT VERIFIED |
| Cleanup temporary resources | PASS implementation / NOT VERIFIED browser |

Practical limits depend on codec, duration, device memory, disk/quota and browser APIs. The optional real-fixture path exists specifically to record those facts on the target release machine.

