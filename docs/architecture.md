# Architecture

## Execution model

VideoFlow has no ordinary media backend. The React interface controls a versioned project document, IndexedDB persistence, independent native media elements for preview, recorder-only MediaRecorder use, and a lazily loaded local FFmpeg/WebAssembly worker.

Source assets remain immutable. Each clip references an asset plus source range, timeline position, speed, gain, opacity, crop, transform, fades, generic property keyframes, masks, and text. Export compiles that state into a deterministic RenderPlan. One FFmpeg complex filter graph decodes each unique source once, splits it for repeated or overlapping clip instances, composites visuals, mixes track/clip/master gain exactly once, and directly encodes the selected final container. Canvas capture and MediaRecorder are not part of the final-render path. FFprobe validates the finished file before it becomes downloadable.

## Local processing paths

- Native browser decoders drive interactive preview where supported.
- Each timeline clip owns an independent preview media element, so overlapping clips from the same asset can seek and play independently.
- FFmpeg probing supplies metadata for compatibility-sensitive sources.
- Browser `File`/`Blob` sources are exposed to FFmpeg through read-only WORKERFS mounts, so probing, tools, and final render do not first copy an entire large source into WebAssembly memory.
- Low/Balanced/High H.264 proxies improve preview; proxy blobs are persisted independently of original-source storage mode, source/proxy timing metadata is retained, and final export explicitly resolves originals.
- The RenderPlan compiler provides direct MP4, WebM, GIF, WAV, MP3, and Opus output with track visibility/mute/solo/gain, clip fades, transform/crop/opacity/volume keyframes, text/subtitles, and Watermark Studio regions.
- Separate FFmpeg commands provide stream-level audio removal/extraction, format conversion, compression, audio processing, proxies, and basic `deshake` stabilization.
- A single shared FFmpeg worker serializes heavy work to prevent concurrent jobs from exhausting browser memory. Cancellation terminates and safely recreates that worker.
- Local core JavaScript and plain WebAssembly files are copied into the static package at build time and cached by the service worker; no gzip expansion step or CDN is required.

## Export queue

For high-risk MP4 output, the exporter can render adaptive fragmented-MP4 segments and write each fragment directly to a user-selected File System Access destination, avoiding one giant output Blob. Standard in-memory output is blocked when the estimate exceeds the safety threshold.

The queue owns job settings, preflight results, progress, ETA, output metadata, validation results, and object URLs. Jobs run one at a time and move through queued, rendering, processing, validating, completed, failed, or cancelled states. Failed and cancelled jobs can be retried. Pause/resume is not exposed because the local encoder does not provide a dependable resumable checkpoint.

## Persistence

IndexedDB stores projects, eligible small source blobs, persisted proxy blobs, recovery state and snapshots. Large/high-risk sources use explicit reference/session modes: persistent FileSystemFileHandle references are stored where supported, otherwise only metadata/fingerprint is durable while the original reopens offline. Non-persisted original blobs are not duplicated into IndexedDB. Runtime object URLs are recreated when a persisted project opens and never serialized. Autosave is debounced. Snapshots copy project instructions without duplicating sources. JSON backups omit media bytes.

Project schema version 3 adds real track solo/gain state, master gain/background, fades, text styles, and generic linear property keyframes. Supported older projects migrate when opened; future schema versions are rejected before replacing current state.

## Failure boundaries

- unsupported native decode falls back to local FFmpeg probing before import is rejected
- duplicate media is detected using name, byte size, and signature
- imports have no artificial 1 GB rejection; very large files use reference/session storage plus read-only FFmpeg mounts, with proxy-first editing, relinking and explicit browser/OS resource boundaries
- final export bypasses proxies, fails on missing sources, and validates non-empty output, expected streams, duration, and resolution
- AbortController cancellation stops recorders/tracks or terminates the FFmpeg worker and cleans temporary files
- generated object URLs are revoked when replaced, removed, or unmounted
- future-schema backups are rejected before current state is changed

## Security

Imported strings are inserted through React text nodes. Text and subtitle angle brackets are removed before storage. There is no `eval`, `new Function`, remote script, remote font, telemetry, or media upload. Host headers provide CSP, nosniff, referrer, and permissions policies. The CSP explicitly permits local WebAssembly compilation and same-origin workers.

## Deliberate extension boundary

Neural inpainting, automatic object tracking, temporal reconstruction, GPU-specific acceleration, and optical-flow stabilization are not represented as installed features. Manual linear mask tracking and single-pass FFmpeg deshake provide the honest local baseline.
