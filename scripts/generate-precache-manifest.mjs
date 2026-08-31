import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const output = existsSync(join(root, "dist", "client", "index.html")) ? join(root, "dist", "client") : join(root, "dist");
if (!existsSync(output)) throw new Error("Production dist is missing; cannot generate PWA precache manifest.");
const allowed = new Set([".html", ".js", ".css", ".mjs", ".wasm", ".svg", ".webmanifest"]);
const entries = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else {
      const rel = relative(output, path).replaceAll("\\", "/");
      if (!allowed.has(extname(path))) continue;
      if (/^models\/.*\.onnx$/i.test(rel)) continue;
      if (rel === "service-worker.js" || rel === "precache-manifest.json") continue;
      entries.push(`./${rel}`);
    }
  }
};
walk(output);
entries.sort();
writeFileSync(join(output, "precache-manifest.json"), `${JSON.stringify(entries, null, 2)}\n`);
console.log(`Generated PWA precache manifest with ${entries.length} essential build assets.`);
