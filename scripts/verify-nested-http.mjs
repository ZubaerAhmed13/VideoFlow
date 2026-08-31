import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const port = 4174;
const base = `http://127.0.0.1:${port}/VideoFlow/`;
const server = spawn(process.execPath, ["scripts/serve-dist.mjs", String(port)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Nested-path test server did not start.")), 10_000);
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Nested-path test server exited early (${code}).`)));
    server.stdout.on("data", (chunk) => {
      if (!String(chunk).includes(base)) return;
      clearTimeout(timeout);
      resolve();
    });
  });
  const output = existsSync(join(root, "dist", "client", "index.html"))
    ? join(root, "dist", "client")
    : join(root, "dist");
  const precache = JSON.parse(readFileSync(join(output, "precache-manifest.json"), "utf8"));
  const paths = [...precache, "./models/lama-512-int8.onnx", "./models/lama-512-int8.model.json", "./service-worker.js"];
  const results = [];
  for (const path of paths) {
    const response = await fetch(new URL(String(path).replace(/^\.\//, ""), base));
    const wasm = String(path).endsWith(".wasm");
    const magic = wasm ? [...new Uint8Array(await response.arrayBuffer()).subarray(0, 4)] : undefined;
    results.push({ path, status: response.status, type: response.headers.get("content-type"), magic });
    if (!wasm) await response.body?.cancel();
  }
  const failed = results.filter((result) => result.status !== 200);
  if (failed.length) throw new Error(`Nested-path assets failed: ${JSON.stringify(failed)}`);
  const wasm = results.filter((result) => String(result.path).endsWith(".wasm"));
  if (!wasm.length || wasm.some((result) => result.type !== "application/wasm")) {
    throw new Error("Nested-path WASM assets have an invalid MIME type.");
  }
  if (wasm.some((result) => JSON.stringify(result.magic) !== JSON.stringify([0, 97, 115, 109]))) {
    throw new Error("Nested-path WASM response did not contain WebAssembly bytes.");
  }
  console.log(`Nested HTTP verification passed: ${results.length} production assets under /VideoFlow/.`);
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
}
