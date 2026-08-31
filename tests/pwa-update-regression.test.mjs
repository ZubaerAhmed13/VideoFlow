import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("../components/videoflow/VideoFlowApp.tsx", import.meta.url);

test("initial service-worker claim never reloads the active editing session", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /pwaReloadRequestedRef\s*=\s*useRef\(false\)/);
  assert.match(source, /if \(!pwaReloadRequestedRef\.current \|\| reloading\) return/);
  assert.match(source, /pwaReloadRequestedRef\.current = true;\s*\n\s*pwaUpdateWorker\.postMessage\(\{ type: "SKIP_WAITING" \}\)/);
});
