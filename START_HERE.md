# VideoFlow Professional Core 1.0.0 — Start Here

This archive contains the complete final release candidate: source, tests, workflows, documentation, local runtime/model pack and a fresh production `dist/`.

## Deployable application

The verified static application is in `dist/`. Its production build includes:

- current React/TypeScript application JS/CSS
- AI inference and tracking workers
- local ONNX Runtime Web modules/WASM
- checksum-pinned LaMa Dynamic INT8 model and metadata
- local FFmpeg core/WASM
- generated PWA precache, service worker, manifest and icons

Serve `dist/` over HTTP(S). For local nested-path verification:

```bash
node scripts/serve-dist.mjs 4173
```

Open `http://127.0.0.1:4173/VideoFlow/`.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm run security
npm test
VIDEOFLOW_REQUIRE_AI_PACK=1 npm run verify:dist
npm run verify:nested
npm run cert:ai:wasm
```

Install Playwright browsers and run the production matrix on an unrestricted machine:

```bash
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e:chromium
npm run test:e2e:firefox
npm run test:e2e:webkit
```

For a genuine large encoded source, follow `LARGE_MEDIA_CERTIFICATION.md` and set `VIDEOFLOW_LARGE_MEDIA_FIXTURE`.

## GitHub verification handoff

If the local machine cannot install all Playwright engines, run `npm run package:github-upload`. Extract all generated parts into one folder, upload its contents to GitHub, and run **VideoFlow AI release verification**. The upload edition stores every individual repository file below GitHub's 25 MB browser-upload limit and reconstructs the checksum-pinned release assets automatically.

## Certification status

The candidate is **NOT READY** under the strict release rule because this environment could not install/locate Chromium, Firefox or WebKit. The clean build, portable tests, security/typecheck/lint, nested production assets, model integrity and genuine local WASM LaMa inference pass. Browser 4K AI, offline AI/PWA and genuine encoded multi-gigabyte media remain NOT VERIFIED until external evidence is returned.

Read these first:

- `RELEASE_CERTIFICATION.md`
- `certification-artifacts/FINAL_TEST_RESULTS.md`
- `AI_RECONSTRUCTION.md`
- `BROWSER_SUPPORT.md`
- `LARGE_MEDIA_CERTIFICATION.md`
- `GITHUB_PAGES.md`
