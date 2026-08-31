# VideoFlow Professional Core 1.0.0 — Final Test Results

Date: 2026-08-31 UTC  
Build: `1.0.0-8be338dc09e9` / `assets/VideoFlowApp-DjLBLm4x.js`  
Environment: Ubuntu 24.04.3 LTS, Node.js 24.19.0, npm 11.9.0, FFmpeg 6.1.1

| Command / suite | Browser | Passed | Failed | Skipped / blocked | Result |
| --- | --- | ---: | ---: | ---: | --- |
| `npm ci` | n/a | 679 packages | 0 | 0 | PASS |
| `npm run typecheck` | n/a | 1 | 0 | 0 | PASS |
| `npm run lint` | n/a | 1 | 0 | 0 | PASS |
| `npm run security` | n/a | 112 files | 0 | 0 | PASS |
| `npm run verify:render` | native FFmpeg | 1 | 0 | 0 | PASS |
| `npm run test:unit` | Node/static | 80 | 0 | 0 | PASS |
| final `npm run build` | n/a | 1 | 0 | 0 | PASS — stale dist deleted first |
| `VIDEOFLOW_REQUIRE_AI_PACK=1 npm run verify:dist` | n/a | 38 files | 0 | 0 | PASS |
| `npm run verify:nested` | local HTTP | 27 assets | 0 | 0 | PASS |
| `npm run cert:quality` | native FFmpeg | 7 resolutions + 8 FPS + 4 quality modes + Smart Copy + colour/audio | 0 | 0 | PASS |
| `npm run cert:ai:wasm` | ONNX WASM | 1 real session/inference | 0 | 0 | PASS; zero remote requests |
| `npm run cert:media` | native ffprobe | real 4K + sparse 3 GiB | 0 | 0 | PASS structural |
| `npm run cert:large-media:real` | native | 0 | 0 | fixture absent | NOT VERIFIED |
| `npm run test:e2e:chromium` | Chromium | 0 | 20 launch failures | 0 | NOT VERIFIED |
| `npm run test:e2e:firefox` | Firefox | 0 | 20 launch failures | 0 | NOT VERIFIED |
| `npm run test:e2e:webkit` | WebKit | 0 | 20 launch failures | 0 | NOT VERIFIED |
| Browser 4K/AI/offline/PWA | browser matrix | 0 | 0 application assertions | launch-blocked | NOT VERIFIED |

Browser installation was attempted with a 120-second connection timeout; the Chromium archive was returned as a zero-byte/truncated ZIP. No system engines were available. These facts are kept separate from application results.
