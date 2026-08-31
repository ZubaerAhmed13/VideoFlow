import type { AIProvider } from "./types";

export interface AICapabilityReport {
  webgpu: "available" | "unavailable" | "initialization-failed";
  wasm: boolean;
  recommendedProvider: AIProvider;
  detail?: string;
}

export async function detectAICapability(): Promise<AICapabilityReport> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ requestDevice(): Promise<unknown> } | null> } }).gpu;
  if (!gpu) return { webgpu: "unavailable", wasm: typeof WebAssembly !== "undefined", recommendedProvider: "wasm" };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { webgpu: "unavailable", wasm: true, recommendedProvider: "wasm", detail: "No WebGPU adapter returned." };
    await adapter.requestDevice();
    return { webgpu: "available", wasm: true, recommendedProvider: "webgpu" };
  } catch (error) {
    return { webgpu: "initialization-failed", wasm: true, recommendedProvider: "wasm", detail: error instanceof Error ? error.message : String(error) };
  }
}
