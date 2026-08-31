# VideoFlow Professional Core 1.0.0 — GitHub Pages

## Release-gated workflow

`.github/workflows/deploy-pages.yml` has a single `release-gate` job. The deployment job uses `needs: release-gate`, so Pages cannot deploy after a failed required check.

The gate performs:

1. `npm ci`
2. fixture generation and checksum-pinned local AI-pack staging
3. security, TypeScript, lint and deterministic-render checks
4. deletion of old `dist/` and a fresh production build
5. AI-required static distribution and real nested HTTP verification
6. unit/integration/static-dist tests plus the media-quality/colour-fidelity gate
7. checksum-pinned local WASM AI session and inference
8. Chromium, Firefox and WebKit installation and the production-dist matrix
9. offline PWA/local-AI, 4K core, 4K AI, cancellation/recovery and inspected-download gates
10. sparse 3 GiB Chromium structural lifecycle
11. certification generation from actual runner evidence

The release workflow packages `VideoFlow_Professional_Core_1.0.0_Final_Release.zip` only after those required gates succeed. An optional genuine encoded large-file certification can be run on a machine that supplies `VIDEOFLOW_LARGE_MEDIA_FIXTURE`.

## Nested repository paths

The application targets URLs such as:

```text
https://USERNAME.github.io/REPOSITORY/
```

The Playwright production server uses `/VideoFlow/` as its base. Runtime asset URLs are resolved from the deployment base rather than the origin root:

- application JS/CSS and worker chunks
- `service-worker.js` and its scope
- manifest/icons
- FFmpeg JavaScript and WASM
- ONNX Runtime Web module/WASM files
- optional bundled AI model and metadata

The manifest uses `start_url: "./"` and `scope: "./"`. The service worker builds its URLs from `self.registration.scope`. `npm run verify:dist` rejects root-relative runtime paths and external runtime/CDN dependencies.

## AI model policy

The 62,074,990-byte LaMa model is present in the release under `models/`, but it is intentionally absent from `precache-manifest.json`. Ordinary PWA installation therefore does not force a large model download.

When a user chooses **Install bundled AI**, the application loads the model from the same nested deployment base, validates exact size and SHA-256, and stores it in the protected `videoflow-ai-*` cache. Service-worker upgrades preserve protected AI caches. After installation, inference can use local runtime/model data without remote services.

Hosting providers can impose repository/artifact quotas; distributors should confirm the 62,074,990-byte model fits their chosen host before deployment.

## Generated precache

`scripts/build-verified.sh` regenerates `precache-manifest.json` from the fresh hashed output. It includes essential:

- hashed application JavaScript/CSS
- AI and tracking worker chunks
- FFmpeg core JavaScript/WASM
- ONNX runtime module and WASM fallback
- manifest, icons and app shell

Hashed filenames are not manually maintained. Imported user media, proxies and the large ONNX model are excluded.

## PWA behavior

The `videoflow-pwa9` service worker:

- installs the generated shell under the nested scope
- excludes Blob URLs and user media
- falls back to the scoped app shell while offline
- preserves separately installed AI caches
- deletes obsolete app-shell caches on activation
- supports the safe project-save → recovery-clear → `SKIP_WAITING` update flow

Static PWA/nested-path verification passes. Actual clean-browser install/offline reload is NOT VERIFIED in the current environment because Playwright browser binaries could not be obtained.

## Local/static verification

```bash
rm -rf dist
npm run build
VIDEOFLOW_REQUIRE_AI_PACK=1 npm run verify:dist
node scripts/serve-dist.mjs 4173
```

Open `http://127.0.0.1:4173/VideoFlow/`. Do not open `index.html` directly from `file://`; service workers and several media APIs require HTTP(S).
