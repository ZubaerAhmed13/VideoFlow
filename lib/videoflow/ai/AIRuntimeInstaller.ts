import { deploymentAssetUrl } from "../base-url";
const RUNTIME_CACHE = "videoflow-ai-runtime-v1";
const REQUIRED_RUNTIME_FILES = [
  "ort.wasm.bundle.min.mjs",
  "ort.webgpu.bundle.min.mjs",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jspi.mjs",
  "ort-wasm-simd-threaded.jspi.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
] as const;

function runtimeUrl(name: string): string {
  return deploymentAssetUrl(`vendor/onnx/${name}`);
}

export async function installAIRuntime(files: FileList | File[]): Promise<{ installed: string[]; missing: string[] }> {
  const byName = new Map(Array.from(files).map((file) => [file.name, file]));
  const cache = await caches.open(RUNTIME_CACHE);
  const installed: string[] = [];
  for (const name of REQUIRED_RUNTIME_FILES) {
    const file = byName.get(name);
    if (!file) continue;
    await cache.put(runtimeUrl(name), new Response(file, { headers: { "content-type": name.endsWith(".wasm") ? "application/wasm" : "text/javascript" } }));
    installed.push(name);
  }
  const missing = REQUIRED_RUNTIME_FILES.filter((name) => !byName.has(name));
  localStorage.setItem("videoflow-ai-runtime", JSON.stringify({ installed, installedAt: new Date().toISOString() }));
  return { installed, missing };
}

export async function runtimeAvailability(): Promise<{ ready: boolean; files: Record<string, boolean> }> {
  const cache = await caches.open(RUNTIME_CACHE);
  const files: Record<string, boolean> = {};
  for (const name of REQUIRED_RUNTIME_FILES) {
    const url = runtimeUrl(name);
    if (await cache.match(url)) { files[name] = true; continue; }
    // Bundled runtime assets may live in the PWA shell cache rather than the
    // optional protected runtime cache. Check Cache Storage before using a
    // network HEAD request so offline AI remains discoverable after reload.
    if (await caches.match(url)) { files[name] = true; continue; }
    try {
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      files[name] = response.ok;
    } catch {
      files[name] = false;
    }
  }
  return { ready: REQUIRED_RUNTIME_FILES.every((name) => files[name]), files };
}

export async function removeAIRuntime(): Promise<void> {
  await caches.delete(RUNTIME_CACHE);
  localStorage.removeItem("videoflow-ai-runtime");
}

export { REQUIRED_RUNTIME_FILES };
