import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("renders VideoFlow metadata and local-first shell", async () => {
  const clientIndex = new URL("../dist/client/index.html", import.meta.url);
  const rootIndex = new URL("../dist/index.html", import.meta.url);
  const indexUrl = await access(clientIndex).then(() => clientIndex).catch(() => rootIndex);
  const html = await readFile(indexUrl, "utf8");
  assert.match(html, /<title>VideoFlow Professional Core<\/title>/i);
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest"/i);
  assert.match(html, /Local Mode/i);
  assert.match(html, /Video Editor/i);
  assert.doesNotMatch(html, /codex-preview/i);
});
