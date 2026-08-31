import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// @ffmpeg/ffmpeg is bundled as an ESM module worker by Vite/vinext. Its worker
// falls back to dynamic import when importScripts is unavailable, so the core
// must expose an ESM default export. Shipping the UMD build here makes every
// browser fail with "failed to import ffmpeg-core.js" under nested hosting.
const source = resolve(root, "node_modules/@ffmpeg/core/dist/esm");
const destination = resolve(root, "public/vendor/ffmpeg");

await mkdir(destination, { recursive: true });
await Promise.all([
  cp(resolve(source, "ffmpeg-core.js"), resolve(destination, "ffmpeg-core.js"), { force: true }),
  cp(resolve(source, "ffmpeg-core.wasm"), resolve(destination, "ffmpeg-core.wasm"), { force: true }),
]);
