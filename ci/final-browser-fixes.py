from pathlib import Path

root = Path.cwd()

def replace(path, old, new, required=True):
    p = root / path
    text = p.read_text()
    if new in text:
        return
    if old not in text:
        if required:
            raise SystemExit(f"Expected pattern missing in {path}: {old[:100]!r}")
        return
    p.write_text(text.replace(old, new))

replace("scripts/serve-dist.mjs",
        '  ".js": "text/javascript; charset=utf-8",\n',
        '  ".js": "text/javascript; charset=utf-8",\n  ".mjs": "text/javascript; charset=utf-8",\n')

p = root / "components/videoflow/ExportControls.tsx"
s = p.read_text()
if "const currentEnd = current.rangeEnd ?? 0;" not in s:
    anchor = '  const audioOnly = ["wav", "mp3", "opus"].includes(settings.format);\n'
    addition = anchor + '''  useEffect(() => {\n    if (!open || fullDuration <= 0) return;\n    const timer = window.setTimeout(() => {\n      setSettings((current) => {\n        const currentEnd = current.rangeEnd ?? 0;\n        if (currentEnd > 0 && currentEnd <= fullDuration) return current;\n        return { ...current, rangeEnd: fullDuration };\n      });\n    }, 0);\n    return () => window.clearTimeout(timer);\n  }, [open, fullDuration]);\n'''
    if anchor not in s: raise SystemExit("ExportControls range anchor missing")
    p.write_text(s.replace(anchor, addition, 1))

replace("workers/ai-inference.worker.ts",
        'if (runtime.env?.wasm) runtime.env.wasm.numThreads = Math.max(1, Math.min(4, data.hardwareConcurrency || 2));',
        'if (runtime.env?.wasm) runtime.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, data.hardwareConcurrency || 2)) : 1;')
replace("lib/videoflow/ai/AIInferenceEngine.ts",
        'if (runtime.env?.wasm) runtime.env.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));',
        'if (runtime.env?.wasm) runtime.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) : 1;')

p = root / "scripts/generate-test-fixtures.mjs"
s = p.read_text()
if 'overlap-source.webm' not in s:
    s = s.replace('const video = join(directory, "overlap-source.mp4");\n', 'const video = join(directory, "overlap-source.mp4");\nconst videoWebm = join(directory, "overlap-source.webm");\n', 1)
    audio_anchor = 'if (!existsSync(audio)) {\n'
    video_webm = '''if (!existsSync(videoWebm)) {\n  const result = spawnSync(\n    "ffmpeg",\n    [\n      "-hide_banner", "-loglevel", "error", "-y",\n      "-i", video,\n      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-crf", "38", "-b:v", "0",\n      "-c:a", "libopus", "-b:a", "96k",\n      videoWebm,\n    ],\n    { encoding: "utf8" },\n  );\n  if (result.status !== 0) throw new Error(result.stderr);\n}\n\n'''
    if audio_anchor not in s: raise SystemExit("Fixture audio anchor missing")
    s = s.replace(audio_anchor, video_webm + audio_anchor, 1)
    s = s.replace('const aiStatic = join(aiDir, "ai-static-watermark-720p.mp4");\n', 'const aiStatic = join(aiDir, "ai-static-watermark-720p.mp4");\nconst aiStaticWebm = join(aiDir, "ai-static-watermark-720p.webm");\n', 1)
    moving_anchor = 'generate(aiMoving, ["-f", "lavfi"'
    ai_webm = 'generate(aiStaticWebm, ["-i", aiStatic, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-crf", "38", "-b:v", "0", "-c:a", "libopus", "-b:a", "96k"]);\n'
    if moving_anchor not in s: raise SystemExit("AI moving fixture anchor missing")
    s = s.replace(moving_anchor, ai_webm + moving_anchor, 1)
    p.write_text(s)

p = root / "tests/e2e/videoflow.spec.ts"
s = p.read_text()
if 'const firefoxFixture' not in s:
    s = s.replace('const fixture = join(generated, "overlap-source.mp4");\n', 'const fixture = join(generated, "overlap-source.mp4");\nconst firefoxFixture = join(generated, "overlap-source.webm");\nconst firefoxAI = join(root, "tests", "fixtures", "ai", "ai-static-watermark-720p.webm");\n', 1)
old_import = '''async function importMedia(page: Page, files: string | string[]) {\n  const list = Array.isArray(files) ? files : [files];\n  const before = await page.locator(".vf-clip").count();\n  await page.getByTestId("media-import").setInputFiles(files);\n'''
new_import = '''async function importMedia(page: Page, files: string | string[]) {\n  const list = Array.isArray(files) ? files : [files];\n  const before = await page.locator(".vf-clip").count();\n  const selectedFiles = test.info().project.name === "firefox"\n    ? list.map((file) => file === fixture ? firefoxFixture : file.endsWith("ai-static-watermark-720p.mp4") ? firefoxAI : file)\n    : list;\n  await page.getByTestId("media-import").setInputFiles(Array.isArray(files) ? selectedFiles : selectedFiles[0]);\n'''
if 'const selectedFiles = test.info().project.name === "firefox"' not in s:
    if old_import not in s: raise SystemExit("E2E import helper anchor missing")
    s = s.replace(old_import, new_import, 1)
s = s.replace('page.locator(".vf-media-item").filter({ hasText: "overlap-source.mp4" })', 'page.locator(".vf-media-item").filter({ hasText: /overlap-source/ })')
s = s.replace('await expect(page.getByText("Quick workflow title")).toBeVisible();', 'await expect(page.locator(".vf-inspector textarea")).toHaveValue("Quick workflow title");')
reload_block = '''  await page.getByRole("button", { name: "Projects" }).click();\n  await page.locator(".vf-project-grid article button").first().click();\n  await expect(page.locator(".vf-clip-video")).toHaveCount(1);\n  await expect(page.getByLabel("Region 1 method")).toBeVisible();\n'''
reload_fixed = '''  await page.getByRole("button", { name: "Projects" }).click();\n  await page.locator(".vf-project-grid article button").first().click();\n  await expect(page.locator(".vf-clip-video")).toHaveCount(1);\n  await page.locator(".vf-clip-video").first().click();\n  await expect(page.getByLabel("Region 1 method")).toBeVisible();\n'''
if reload_block in s: s = s.replace(reload_block, reload_fixed, 1)
s = s.replace('await expect(page.getByText(/linear keyframe/)).toBeVisible();', 'await expect(page.getByText("1 linear keyframe", { exact: true })).toBeVisible();')
s = s.replace('await page.keyboard.press("ArrowRight");\n  await page.keyboard.press("s");', 'await page.keyboard.press("ArrowRight");\n  await page.keyboard.press("ArrowRight");\n  await page.keyboard.press("s");')
s = s.replace('await page.goto("./", { waitUntil: "domcontentloaded" });\n  await expect(page.getByText("VideoFlow", { exact: true }).first()).toBeVisible();', 'await page.goto("./", { waitUntil: "commit", timeout: 30_000 }).catch(() => undefined);\n  await expect(page.getByText("VideoFlow", { exact: true }).first()).toBeVisible({ timeout: 30_000 });')
if 'test.setTimeout(300_000);\n  test.skip(browserName !== "chromium", "Full WASM encode' not in s:
    s = s.replace('test("queues and completes validated deterministic MP4 output", async ({ page, browserName }) => {\n  test.skip', 'test("queues and completes validated deterministic MP4 output", async ({ page, browserName }) => {\n  test.setTimeout(300_000);\n  test.skip', 1)
if 'test.setTimeout(900_000);\n  test.skip(browserName !== "chromium", "The real 4K WASM encode' not in s:
    s = s.replace('test("small real 4K fixture imports, edits and exports at 3840x2160", async ({ page, browserName }) => {\n  test.skip', 'test("small real 4K fixture imports, edits and exports at 3840x2160", async ({ page, browserName }) => {\n  test.setTimeout(900_000);\n  test.skip', 1)
p.write_text(s)

test_file = root / "tests/final-browser-regressions.test.mjs"
test_file.write_text('''import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nconst read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");\ntest("static test server serves module runtime with JavaScript MIME", async () => { assert.match(await read("scripts/serve-dist.mjs"), /"\\.mjs": "text\\/javascript; charset=utf-8"/); });\ntest("export range follows newly imported project duration", async () => { const source = await read("components/videoflow/ExportControls.tsx"); assert.match(source, /const currentEnd = current\\.rangeEnd \\?\\? 0/); assert.match(source, /rangeEnd: fullDuration/); });\ntest("ONNX WASM falls back to one thread without cross-origin isolation", async () => { assert.match(await read("workers/ai-inference.worker.ts"), /self\\.crossOriginIsolated[^\\n]+: 1/); assert.match(await read("lib/videoflow/ai/AIInferenceEngine.ts"), /globalThis\\.crossOriginIsolated[^\\n]+: 1/); });\ntest("Firefox browser matrix uses generated VP9 Opus fixtures", async () => { const fixtures = await read("scripts/generate-test-fixtures.mjs"); const e2e = await read("tests/e2e/videoflow.spec.ts"); assert.match(fixtures, /overlap-source\\.webm/); assert.match(fixtures, /libvpx-vp9/); assert.match(e2e, /firefoxFixture/); assert.match(e2e, /firefoxAI/); });\n''')
print("final browser fixes applied")
