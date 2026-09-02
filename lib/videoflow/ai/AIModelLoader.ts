import { AI_MODELS, DEFAULT_AI_MODEL } from "./AIModelRegistry";
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

async function validateModelBytes(bytes: ArrayBuffer, descriptor: AIModelDescriptor): Promise<void> {
  if (bytes.byteLength !== descriptor.size) {
    throw new Error(`AI model validation failed. Expected ${descriptor.size} bytes, received ${bytes.byteLength}.`);
  }
  const checksum = await digestHex(bytes);
  if (checksum !== descriptor.sha256) {
    throw new Error(`AI model validation failed. Expected ${descriptor.sha256}, received ${checksum}.`);
  }
}

async function ensureStorageHeadroom(additionalBytes: number): Promise<void> {
  if (!additionalBytes || typeof navigator === "undefined" || !navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  const available = Math.max(0, Number(estimate.quota ?? 0) - Number(estimate.usage ?? 0));
  const required = Math.ceil(additionalBytes * 1.2) + 64 * 1024 * 1024;
  if (estimate.quota && available < required) {
    throw new Error(`AI model installation needs about ${Math.ceil(required / 1024 / 1024)} MiB of free browser storage; only ${Math.floor(available / 1024 / 1024)} MiB is available.`);
  }
}

async function verifiedCachedBytes(descriptor: AIModelDescriptor): Promise<ArrayBuffer | null> {
  const cache = await caches.open(MODEL_CACHE);
  const response = await cache.match(modelUrl(descriptor.id));
  if (!response) return null;
  const bytes = await response.arrayBuffer();
  try {
    await validateModelBytes(bytes, descriptor);
    return bytes;
  } catch {
    await cache.delete(modelUrl(descriptor.id));
    return null;
  }
}

async function writePackRecord(installedModelIds: string[]): Promise<AIModelInstallRecord> {
  const timestamp = new Date().toISOString();
  const record: AIModelInstallRecord = {
    descriptor: DEFAULT_AI_MODEL,
    state: "installed",
    installedAt: timestamp,
    verifiedAt: timestamp,
    installedModelIds,
  };
  localStorage.setItem(MODEL_RECORD, JSON.stringify(record));
  return record;
}

export async function installBundledAIModel(): Promise<AIModelInstallRecord> {
  const cache = await caches.open(MODEL_CACHE);
  const entries: Array<{ descriptor: AIModelDescriptor; bytes: ArrayBuffer; needsWrite: boolean }> = [];
  let additionalBytes = 0;

  // Validate every model before mutating the installed-pack record. A partially
  // downloaded pack is never reported as installed.
  for (const descriptor of AI_MODELS) {
    const cached = await verifiedCachedBytes(descriptor);
    if (cached) {
      entries.push({ descriptor, bytes: cached, needsWrite: false });
      continue;
    }
    const response = await fetch(modelUrl(descriptor.id), { cache: "no-store" });
    if (!response.ok) throw new Error(`Bundled AI model is unavailable: ${descriptor.name}.`);
    const bytes = await response.arrayBuffer();
    await validateModelBytes(bytes, descriptor);
    additionalBytes += bytes.byteLength;
    entries.push({ descriptor, bytes, needsWrite: true });
  }

  await ensureStorageHeadroom(additionalBytes);
  for (const entry of entries) {
    if (!entry.needsWrite) continue;
    await cache.put(modelUrl(entry.descriptor.id), new Response(entry.bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "x-videoflow-sha256": entry.descriptor.sha256,
      },
    }));
  }
  await caches.delete(LEGACY_MODEL_CACHE).catch(() => false);
  return writePackRecord(AI_MODELS.map((model) => model.id));
}

export async function bundledAIModelAvailable(): Promise<boolean> {
  try {
    const results = await Promise.all(AI_MODELS.map(async (descriptor) => {
      const response = await fetch(modelUrl(descriptor.id), { method: "HEAD", cache: "no-store" });
      return response.ok;
    }));
    return results.every(Boolean);
  } catch {
    return false;
  }
}

export async function installAIModel(file: File, descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<AIModelInstallRecord> {
  const bytes = await file.arrayBuffer();
  await validateModelBytes(bytes, descriptor);
  await ensureStorageHeadroom(bytes.byteLength);
  const cache = await caches.open(MODEL_CACHE);
  await cache.put(modelUrl(descriptor.id), new Response(bytes, {
    headers: { "content-type": "application/octet-stream", "x-videoflow-sha256": descriptor.sha256 },
  }));
  const installed = [descriptor.id];
  for (const candidate of AI_MODELS) {
    if (candidate.id === descriptor.id) continue;
    if (await verifiedCachedBytes(candidate)) installed.push(candidate.id);
  }
  await caches.delete(LEGACY_MODEL_CACHE).catch(() => false);
  return writePackRecord(installed);
}

export function getAIModelRecord(): AIModelInstallRecord {
  try {
    const record = JSON.parse(localStorage.getItem(MODEL_RECORD) ?? "null") as AIModelInstallRecord | null;
    if (!record || record.descriptor?.id !== DEFAULT_AI_MODEL.id) {
      if (record) localStorage.removeItem(MODEL_RECORD);
      return { descriptor: DEFAULT_AI_MODEL, state: "not-installed", installedModelIds: [] };
    }
    return { ...record, installedModelIds: record.installedModelIds ?? [record.descriptor.id] };
  } catch {
    return { descriptor: DEFAULT_AI_MODEL, state: "error", installedModelIds: [], error: "Stored AI model metadata is invalid." };
  }
}

export function isAIModelInstalled(modelId: string): boolean {
  const record = getAIModelRecord();
  return (record.state === "installed" || record.state === "ready")
    && (record.installedModelIds ?? [record.descriptor.id]).includes(modelId);
}

export async function getAIModelBytes(descriptor: AIModelDescriptor = DEFAULT_AI_MODEL): Promise<ArrayBuffer | null> {
  return verifiedCachedBytes(descriptor);
}

export async function removeAIModel(): Promise<void> {
  await Promise.all([
    caches.delete(MODEL_CACHE),
    caches.delete(LEGACY_MODEL_CACHE),
  ]);
  localStorage.removeItem(MODEL_RECORD);
}
