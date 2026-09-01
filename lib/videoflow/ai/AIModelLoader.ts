import { DEFAULT_AI_MODEL } from "./AIModelRegistry";
import { deploymentAssetUrl } from "../base-url";
import type { AIModelDescriptor, AIModelInstallRecord } from "./types";

const MODEL_CACHE = "videoflow-ai-models-v2";
const LEGACY_MODEL_CACHE = "videoflow-ai-models-v1";
const MODEL_RECORD = "videoflow-ai-model-record";
const modelUrl = (id: string) => deploymentAssetUrl(`models/${id}.onnx`);

async function digestHex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function clearLegacyModelCache(): Promise<void> {
  await caches.delete(LEGACY_MODEL_CACHE).catch(() => false);
}

async function storeVerifiedModel(bytes: ArrayBuffer, descriptor: AIModelDescriptor): Promise<AIModelInstallRecord> {
  if (bytes.byteLength !== descriptor.size) throw new Error(`AI model validation failed. Expected ${descriptor.size} bytes, received ${bytes.byteLength}.`);
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    const available = Math.max(0, Number(estimate.quota ?? 0) - Number(estimate.usage ?? 0));
    const required = Math.ceil(bytes.byteLength * 1.2) + 64 * 1024 * 1024;
    if (estimate.quota && available < required) {
      throw new Error(`AI model installation needs about ${Math.ceil(required / 1024 / 1024)} MiB of free browser storage; only ${Math.floor(available / 1024 / 1024)} MiB is available.`);
    }
  }
  const checksum = await digestHex(bytes);
  if (checksum !== descriptor.sha256) throw new Error(`AI model validation failed. Expected ${descriptor.sha256}, received ${checksum}.`);
  const cache = await caches.open(MODEL_CACHE);
  await cache.put(modelUrl(descriptor.id), new Response(bytes, { headers: { "content-type": "application/octet-stream", "x-videoflow-sha256": checksum } }));
  await clearLegacyModelCache();
  const record: AIModelInstallRecord = { descriptor, state: "installed", installedAt: new Date().toISOString(), verifiedAt: new Date().toISOString() };
  localStorage.setItem(MODEL_RECORD, JSON.stringify(record));
  return record;
}

export async function installBundledAIModel(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<AIModelInstallRecord> {
  const response = await fetch(modelUrl(descriptor.id), { cache: "no-store" });
  if (!response.ok) throw new Error("Bundled AI model pack is not available in this build.");
  return storeVerifiedModel(await response.arrayBuffer(), descriptor);
}

export async function bundledAIModelAvailable(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<boolean> {
  try {
    const response = await fetch(modelUrl(descriptor.id), { method: "HEAD", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

export async function installAIModel(file: File, descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<AIModelInstallRecord> {
  return storeVerifiedModel(await file.arrayBuffer(), descriptor);
}

export function getAIModelRecord(): AIModelInstallRecord {
  try {
    const record = JSON.parse(localStorage.getItem(MODEL_RECORD) ?? "null") as AIModelInstallRecord | null;
    if (!record || record.descriptor?.id !== DEFAULT_AI_MODEL.id) {
      if (record) localStorage.removeItem(MODEL_RECORD);
      return { descriptor: DEFAULT_AI_MODEL, state: "not-installed" };
    }
    return record;
  } catch {
    return { descriptor: DEFAULT_AI_MODEL, state: "error", error: "Stored AI model metadata is invalid." };
  }
}

export async function getAIModelBytes(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<ArrayBuffer | null> {
  const response = await (await caches.open(MODEL_CACHE)).match(modelUrl(descriptor.id));
  if (!response) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== descriptor.size) throw new Error("AI model validation failed. Cached model size mismatch.");
  const checksum = await digestHex(bytes);
  if (checksum !== descriptor.sha256) throw new Error("AI model validation failed. Cached checksum mismatch.");
  return bytes;
}

export async function removeAIModel(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<void> {
  await (await caches.open(MODEL_CACHE)).delete(modelUrl(descriptor.id));
  await clearLegacyModelCache();
  localStorage.removeItem(MODEL_RECORD);
}
