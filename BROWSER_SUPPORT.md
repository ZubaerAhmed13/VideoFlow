# VideoFlow Professional Core 1.0.0 — Browser Support

Status date: 2026-08-31 UTC

`NOT VERIFIED` means the engine never launched. It is never inferred from source, static verification, another browser, or native FFmpeg.

| Capability | Chromium | Firefox | WebKit/Safari |
| --- | --- | --- | --- |
| Core editing | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Local FFmpeg/WASM | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| IndexedDB save/reopen | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| 720p/1080p/1440p inspected export | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| 4K core/AI export | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Rec.709 limited/full output | Native gate PASS / browser NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Local AI WASM | Non-browser WASM PASS / browser NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| AI WebGPU | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| PWA/offline core | Static PASS / runtime NOT VERIFIED | Static PASS / runtime NOT VERIFIED | Static PASS / runtime NOT VERIFIED |
| Offline installed AI | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |
| Nested `/VideoFlow/` | Static HTTP PASS / runtime NOT VERIFIED | Static HTTP PASS / runtime NOT VERIFIED | Static HTTP PASS / runtime NOT VERIFIED |
| Persistent file handles | Implemented when API exists | Session/proxy/relink fallback | Session/proxy/relink fallback |
| Direct-to-disk | Implemented when File System Access exists | Standard-download fallback | Standard-download/platform fallback |

## Actual attempts

```bash
PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000 npx playwright install chromium firefox webkit
npm run test:e2e:chromium -- --reporter=line
npm run test:e2e:firefox -- --reporter=line
npm run test:e2e:webkit -- --reporter=line
```

The Chromium archive returned zero bytes/truncated ZIP twice. Each engine suite then reported 20 `Executable doesn't exist` failures at `browserType.launch`; no page or application assertion executed.

## Intended fallbacks

- WebGPU is optional; local ONNX WASM is the correctness fallback.
- Firefox/WebKit do not need persistent `FileSystemFileHandle`; session import, persisted proxies, relink, and safe standard download remain available.
- Direct-to-disk is primarily Chromium-family. Other engines warn before unsafe large Blob output.
- HDR effects/AI are not certified in any engine. HDR is detected and non-Smart-Copy paths are blocked.
- WebKit AI may ultimately be LIMITED on devices where the model session exceeds practical memory, but that status must come from an observed run.

The GitHub release and Pages workflows install all three engines and block publication until their required production-dist suites pass.
