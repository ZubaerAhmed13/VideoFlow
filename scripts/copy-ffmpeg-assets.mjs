import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/@ffmpeg/core/dist/umd");
const destination = resolve(root, "public/vendor/ffmpeg");

await mkdir(destination, { recursive: true });
await Promise.all([
  cp(resolve(source, "ffmpeg-core.js"), resolve(destination, "ffmpeg-core.js"), { force: true }),
  cp(resolve(source, "ffmpeg-core.wasm"), resolve(destination, "ffmpeg-core.wasm"), { force: true }),
]);
