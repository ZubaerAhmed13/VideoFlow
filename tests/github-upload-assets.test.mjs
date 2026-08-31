import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("GitHub web-upload asset parts reconstruct exact release binaries", () => {
  const manifestPath = join(root, "large-assets", "manifest.json");
  if (!existsSync(manifestPath)) {
    for (const target of [
      "public/models/lama-512-int8.onnx",
      "public/vendor/ffmpeg/ffmpeg-core.wasm",
      "public/vendor/onnx/ort-wasm-simd-threaded.jsep.wasm",
    ]) assert.ok(existsSync(join(root, target)), `release asset is missing: ${target}`);
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.assets.length >= 3);

  for (const asset of manifest.assets) {
    const hash = createHash("sha256");
    let size = 0;
    for (const part of asset.parts) {
      const bytes = readFileSync(join(root, part.path));
      assert.equal(bytes.byteLength, part.sizeBytes);
      assert.ok(bytes.byteLength < 25 * 1024 * 1024, `${part.path} exceeds GitHub's web-upload limit`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), part.sha256);
      hash.update(bytes);
      size += bytes.byteLength;
    }
    assert.equal(size, asset.sizeBytes);
    assert.equal(hash.digest("hex"), asset.sha256);
    assert.equal(statSync(join(root, asset.target)).size, asset.sizeBytes);
  }
});

test("release verification restores assets before install and Pages deploys only its certified artifact", () => {
  const release = readFileSync(join(root, ".github", "workflows", "release-verification.yml"), "utf8");
  const restore = release.indexOf("npm run restore:large-assets -- --if-present");
  const install = release.indexOf("npm ci");
  assert.ok(restore >= 0, "release verification is missing split-asset restoration");
  assert.ok(restore < install, "release verification must restore assets before npm ci");
  assert.match(release, /name: videoflow-static-site[\s\S]*path: \.pages-dist/);

  const pages = readFileSync(join(root, ".github", "workflows", "deploy-pages.yml"), "utf8");
  assert.match(pages, /workflow_run:[\s\S]*VideoFlow AI release verification/);
  assert.match(pages, /workflow_run\.conclusion == 'success'/);
  assert.match(pages, /name: videoflow-static-site/);
  assert.match(pages, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
});
