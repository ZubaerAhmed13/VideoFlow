# VideoFlow Professional Core 1.0.0 — Browser Support

Status date: 2026-08-31 UTC

`NOT VERIFIED` means the named browser did not launch. It is not inferred from source, another engine, or a previous package.

| Capability | Chromium | Firefox | WebKit/Safari |
| --- | --- | --- | --- |
| Core editing | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Local FFmpeg | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| IndexedDB project/recovery | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Nested `/VideoFlow/` hosting | Static PASS / runtime NOT VERIFIED | Static PASS / runtime NOT VERIFIED | Static PASS / runtime NOT VERIFIED |
| PWA offline shell | Static PASS / runtime NOT VERIFIED | Static PASS / runtime NOT VERIFIED | Static PASS / runtime NOT VERIFIED |
| Local AI WASM | Genuine non-browser WASM PASS / browser NOT VERIFIED | Browser NOT VERIFIED | Browser NOT VERIFIED |
| AI WebGPU | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| AI tracking | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Offline AI cache/reload | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| 4K core download inspection | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| 4K tiled AI download inspection | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Persistent FileSystemFileHandle | Implemented when API exists | Session/relink fallback | Session/relink fallback |
| Direct-to-disk output | Implemented when File System Access exists | Standard-download fallback | Standard-download/platform fallback |
| Very large standard Blob warning | Implemented | Implemented | Implemented |

## Actual attempts

The production server was started by Playwright at the nested `/VideoFlow/` base. These commands were genuinely attempted:

```bash
npm run test:e2e:chromium
npm run test:e2e:firefox
npm run test:e2e:webkit
```

All three stopped before application navigation because their executables were absent. `npx playwright install chromium firefox webkit` timed out repeatedly; an extended 120-second transfer timeout reached the CDN but received a zero-byte/truncated ZIP. No system browser was installed, and the OS package metadata exposed no browser candidate. Therefore the correct result for every engine is **NOT VERIFIED**, not PASS and not an application FAIL.

## Rerunnable matrix

The committed Playwright tests run the actual production `dist/`, not the source development server. They cover:

- startup, project creation/import, timeline, repeated clips, track controls and keyboard editing
- quick workflows, crop/resize/rotation, text, audio, watermark masks and project snapshots
- save/reload and AI settings/tracking persistence
- deterministic MP4 download and ffprobe inspection
- a real 3840×2160 five-second fixture and inspected core export
- checksum-valid bundled model installation and genuine local AI preview
- automatic moving-watermark tracking thresholds for mean center error and IoU
- AI cancellation and webdriver-gated worker-crash recovery
- no external request during offline installed-model reuse
- clean offline shell reload
- inspected Chromium 4K tiled-AI export with audio
- sparse 3 GiB structural lifecycle
- optional genuine encoded large-media lifecycle through `VIDEOFLOW_LARGE_MEDIA_FIXTURE`

Chromium is the hard 4K/large-output gate. Firefox and WebKit run core flows and local AI WASM fallback where practical; absence of persistent FileSystemFileHandle is handled through session/proxy/relink and standard-download fallbacks rather than treated as an application crash.

## Expected limitations

- WebGPU depends on browser, OS, driver and secure-context support. WASM remains the correctness fallback.
- File System Access direct-to-disk is primarily Chromium-family functionality. Other engines warn and use a standard Blob download when safe.
- Codec preview/recording capabilities vary by platform. Local FFmpeg supplies processing/export compatibility but does not remove browser memory constraints.
- WebKit AI may be LIMITED on devices where large WASM sessions are impractical; the suite must report the observed result rather than assume support.

