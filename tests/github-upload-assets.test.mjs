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

test("release and Pages workflows restore split assets before dependency install", () => {
  for (const workflow of ["release-verification.yml", "deploy-pages.yml"]) {
    const source = readFileSync(join(root, ".github", "workflows", workflow), "utf8");
    const restore = source.indexOf("npm run restore:large-assets -- --if-present");
    const install = source.indexOf("npm ci");
    assert.ok(restore >= 0, `${workflow} is missing split-asset restoration`);
    assert.ok(restore < install, `${workflow} must restore assets before npm ci`);
  }
});
