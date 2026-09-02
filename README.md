# VideoFlow Professional Core 1.0.0

VideoFlow is a privacy-first, non-destructive video and audio workstation for modern browsers. Source media, project state, recovery data, proxies, previews, and exports remain on the device during ordinary use.

## Implemented core

- validated local import for video, audio, images, SRT, and WebVTT, with native metadata inspection, an FFmpeg probe fallback, and session-first handling for very large sources
- persistent projects and media blobs in IndexedDB, including autosave, recovery, bounded undo/redo, snapshots, and JSON backups
- multi-track timeline with real mute, solo, visibility, lock and gain controls, plus selection, moving, trimming, splitting, looping, zoom, and snapping
- video and image transforms: crop, resize presets, scale, rotate, flip, opacity, and speed
- direct preview positioning/crop/mask interaction; styled text presets; burned-in subtitles with an SRT editor and exporter
- Watermark Studio regions with blur, pixelate, cover, nearby-region clone, manual/trusted tracking anchors, full-range directional confidence-scored tracking, and genuine local LaMa ONNX neural reconstruction when the checksum-validated AI pack is installed
- aspect-preserving ROI/mask letterboxing, overlapping large-ROI tiling, bidirectional sliding temporal context, local multi-block motion alignment, boundary luminance/chroma matching and bounded 4K AI micro-batches
- original, processed, and split comparison preview modes with visible mask guides
- screen, camera, and voice recording with device selection, FPS/quality, countdown, pause/resume, local audio metering, optional screen+microphone mixing, and automatic import to the editor timeline
- local FFmpeg audio trim, speed, independent pitch shift, gain, reverse, dynamic normalization, ten-band EQ, real fade-in/fade-out, proxy-first multi-resolution waveforms, actual preview, and WAV output; browser-native joining remains available
- current-frame PNG extraction
- deterministic, original-source FFmpeg RenderPlan export directly to MP4, WebM, GIF, WAV, MP3, and Opus; no Canvas capture or MediaRecorder master; adaptive direct-to-disk segmented MP4 for high-risk output; audio extraction/removal, format conversion, compression, Low/Balanced/High proxies, and basic deshake stabilization
- source/project, 480p, 720p, 1080p, 1440p, 2K DCI, 4K UHD/DCI, vertical/social and custom export dimensions; exact 23.976/29.97/59.94 cadence preservation; real Smart Copy, Visually Lossless, High, Balanced, Smaller and Custom codec policies
- FFprobe colour/audio metadata capture, explicit Rec.709 limited/full conversion and output tags, HDR detection with a no-silent-tone-map policy, source-aware 48/44.1 kHz audio handling, and expanded post-export cadence/colour/audio synchronization validation
- independent same-asset clip instances, clip fades, track/clip/master mixing, and generic linear x/y/scale/rotation/opacity/volume keyframes in preview and final output
- serial multi-job export queue with presets, custom resolution/FPS/bitrates, cancellation, retry, downloads, progress, elapsed time, and ETA
- post-export FFmpeg probing for stream, duration, and resolution validation
- command palette, keyboard shortcuts, responsive quick-workflow layout, and light/dark/system themes
- executable diagnostics for IndexedDB, local FFmpeg assets, worker communication, video/audio encode, output probe, and PWA shell state
- nested-path-safe PWA manifest, safe update lifecycle, service worker, local app-shell/FFmpeg cache, security headers, plain local FFmpeg WASM, and no runtime CDN dependency

## Architecture

```text
app/                       application entry, metadata, providers, global CSS
components/videoflow/      editor, diagnostics, media tools, and export UI
hooks/                     serial export-queue state
lib/videoflow/             project, database, render, media, audio, and FFmpeg modules
public/vendor/ffmpeg/       bundled worker core, WebAssembly binary, and notices
public/vendor/onnx/         local ONNX Runtime Web modules/WASM and notices
public/models/              optional checksum-pinned LaMa model pack and metadata
public/                     manifest, service worker, icon, and security headers
tests/                      unit, deterministic render, generated fixtures, and Playwright E2E tests
docs/                       architecture, browser support, and release certification
dist/ or dist/client/       generated static package (verifier accepts either build layout)
```

Project edits are instructions; imported source media is never modified. Preview may use a generated proxy, while final render always resolves the original asset.

## Requirements

- Node.js 22.13 or later for development and build
- a current Chromium, Firefox, or Safari browser with WebAssembly, Web Workers, Canvas, and IndexedDB; MediaRecorder is needed only for recorder features
- HTTPS or localhost for service workers, screen capture, camera, and microphone
- sufficient browser storage/memory for durable small-media copies and proxies; large sources use reference/session architecture instead of mandatory whole-file IndexedDB duplication; direct-to-disk segmented MP4 requires the File System Access API

## Run locally

```bash
npm ci
npm run dev
```

For a production static package:

```bash
npm run build
```

Serve the generated `dist/` (or `dist/client/` when that build layout is produced) over HTTP rather than opening `index.html` directly:

```bash
python3 -m http.server 8080 --directory dist/client
```

Then open `http://localhost:8080`.

## Test

```bash
npm run typecheck
npm run lint
npm run security
npm run test:unit
npm run verify:render
npm run build
VIDEOFLOW_REQUIRE_AI_PACK=1 npm run verify:dist
npm run verify:nested
npm run cert:quality
npm run cert:ai:wasm
npm run test:e2e
```

The portable Node suite covers project logic, migration, PWA assets, AI architecture/metrics, large-media storage policy, proxy persistence, segmented fragmented-MP4 output, audio fades, storage/recovery controls and render-plan compilation. The local AI certification creates a real WASM LaMa session, executes inference and records controlled PSNR/SSIM. Playwright runs Chromium, Firefox and WebKit against production `dist/` for nested hosting, core editing, persistence, offline PWA/AI, inspected exports, tracking, cancellation/recovery and 4K AI.

## Static hosting

Upload the generated verified `dist/` contents (or the build-produced `dist/client/` contents) to any HTTPS static host or nested GitHub Pages path. All app-shell, service-worker and FFmpeg URLs resolve from the deployment base. The entry point is `index.html`; `_headers` contains the recommended policy for hosts that support that file format.

The Content Security Policy keeps runtime resources local and permits WebAssembly compilation. Vinext/React hydration and timeline geometry currently require inline bootstrap/style attributes, so `script-src` and `style-src` retain documented `unsafe-inline` exceptions. No media or masks are sent to remote inference services. The certified AI build bundles the model/runtime in the production dist; ordinary runtime inference remains local and cached for offline reuse.

## Browser support and truthful limitations

VideoFlow detects capabilities instead of claiming universal codec support. Native preview/recording support and resource limits vary by operating system and browser; the local FFmpeg engine provides processing and export compatibility but does not eliminate browser memory limits.

- supported export targets: MP4/H.264/AAC, WebM/VP9/Opus, GIF, WAV, MP3, and Opus
- basic FFmpeg `deshake` stabilization is available; multi-pass optical-flow stabilization is not installed
- pitch and tempo are controlled independently with FFmpeg resampling and tempo filters, but this is not formant-preserving vocal processing
- neural reconstruction uses a checksum-pinned dual LaMa pack (optimized 512 final + dynamic 256 WASM preview accelerator) ONNX model through local ONNX Runtime Web; WebGPU is attempted only after real adapter/device initialization and WASM is the fallback; automatic tracking and temporal alignment use local template/multi-block motion and are not mislabeled as dense optical flow
- export jobs run serially; cancellation terminates the active local worker, so pause/resume is intentionally not presented
- very large, 4K/8K, high-frame-rate, ten-bit, or long projects remain hardware/browser dependent; high-risk MP4 output uses an adaptive segmented direct-to-disk path where the browser exposes File System Access
- reference sources can reconnect through persisted file handles on supporting browsers; session sources reopen as offline while persisted proxies/project edits remain available until the original is relinked
- project JSON backups reference media bytes rather than embedding them, so sources may need relinking or reimport

See `MEDIA_QUALITY_CERTIFICATION.md`, `COLOR_MANAGEMENT.md`, [browser-support.md](docs/browser-support.md), and [release-certification.md](docs/release-certification.md) for the verification boundary.

## Privacy and security

- ordinary media processing is local
- telemetry, analytics, accounts, cloud processing, and remote databases are absent
- filenames, subtitle text, and overlay text are rendered as text rather than raw HTML
- file detection uses MIME, extension, signature, native metadata, and FFmpeg probing where practical
- high-risk sources use explicit reference/session storage and read-only FFmpeg mounts; non-persisted original blobs are stripped from IndexedDB while proxies remain independently persistable
- diagnostic information is not uploaded
- imported media and generated proxies are never added to the service-worker cache

## FFmpeg licensing note

This package includes `@ffmpeg/ffmpeg` 0.12.15 under MIT and `@ffmpeg/core` 0.12.10 under GPL-2.0-or-later. The WebAssembly binary is packaged as a plain local `.wasm` asset for predictable static-host delivery. Runtime files, license text, versioned attribution, and upstream source links are in `public/vendor/ffmpeg/`. Distributors remain responsible for reviewing and satisfying the licenses that apply to their distribution.

## Watermark authorization

Use Watermark Studio only on media you own or are authorized to modify. VideoFlow supplies ordinary editing and redaction methods; it does not grant rights to third-party content.


## Certification status

This artifact is a **NOT READY release candidate**. The clean install, source/static gates, fresh AI-enabled production build, exact model/runtime verification, local WASM LaMa inference, all resolution/FPS quality fixtures, Rec.709 limited/full metadata, Smart Copy stream integrity, audio sync, and controlled quality metrics pass. Chromium, Firefox and WebKit were genuinely attempted, but this runner could not download or locate their executables; browser 4K AI, offline AI and runtime PWA claims therefore remain NOT VERIFIED. The included GitHub workflows keep deployment gated until the real production-browser matrix succeeds. See `RELEASE_CERTIFICATION.md`, `MEDIA_QUALITY_CERTIFICATION.md`, `COLOR_MANAGEMENT.md`, `LARGE_MEDIA_CERTIFICATION.md`, `BROWSER_SUPPORT.md`, `GITHUB_PAGES.md`, and `AI_RECONSTRUCTION.md`.
