import { uid } from "./core.mjs";
import { assessImportStorage, mediaRisk } from "./import-policy.mjs";
import { parseFrameRate, videoColorInfoFromStream } from "./media-quality.mjs";
import type { MediaProbe } from "./ffmpeg";
import type { AudioMediaInfo, MediaFingerprint, MediaKind, MediaStorageMode, RuntimeAsset, VideoColorInfo } from "./types";

type PermissionCapableHandle = FileSystemFileHandle & {
  queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
};

declare global {
  interface Window {
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle>;
  }
}

function readSignature(bytes: Uint8Array): string {
  const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const ascii = new TextDecoder("latin1").decode(bytes.slice(0, 16));
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm/matroska";
  if (ascii.slice(4, 8) === "ftyp") return "iso-base-media";
  if (hex.startsWith("89504e470d0a1a0a")) return "png";
  if (hex.startsWith("ffd8ff")) return "jpeg";
  if (ascii.startsWith("GIF8")) return "gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") return "wave";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "AVI ") return "avi";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "webp";
  if (ascii.startsWith("OggS")) return "ogg";
  if (ascii.startsWith("fLaC")) return "flac";
  if (ascii.startsWith("ID3") || hex.startsWith("fff") || hex.startsWith("ffe")) return "mpeg-audio";
  if (/^(WEBVTT|\d+\s*\r?\n\d{2}:)/.test(ascii)) return "subtitle-text";
  return "unknown";
}

function kindForFile(file: File, signature: string): MediaKind | null {
  if (file.type.startsWith("video/") || ["webm/matroska", "iso-base-media", "avi"].includes(signature)) return "video";
  if (file.type.startsWith("audio/") || ["wave", "ogg", "mpeg-audio", "flac"].includes(signature)) return "audio";
  if (file.type.startsWith("image/") || ["png", "jpeg", "gif", "webp"].includes(signature)) return "image";
  if (/\.(srt|vtt)$/i.test(file.name) || file.type.includes("text") || signature === "subtitle-text") return "subtitle";
  return null;
}

const OPTIONAL_TECHNICAL_PROBE_TIMEOUT_MS = 6_000;

async function optionalTechnicalProbe(file: File): Promise<MediaProbe | undefined> {
  const { probeMediaBlob } = await import("./ffmpeg");
  const controller = new AbortController();
  let timer = 0;
  try {
    return await Promise.race([
      probeMediaBlob(file, file.name, controller.signal),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          // Promise.race alone does not stop ffprobe. Cancelling is essential:
          // otherwise its queued task can block every later export.
          controller.abort();
          reject(new Error("Optional technical metadata probe timed out."));
        }, OPTIONAL_TECHNICAL_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) window.clearTimeout(timer);
    controller.abort();
  }
}

function loadElementMetadata(file: File, kind: MediaKind, url: string): Promise<{ duration: number; width: number; height: number }> {
  if (kind === "subtitle") return Promise.resolve({ duration: 0, width: 0, height: 0 });
  return new Promise((resolve, reject) => {
    const element = kind === "image" ? new Image() : document.createElement(kind === "video" ? "video" : "audio");
    const timeout = window.setTimeout(() => reject(new Error(`Timed out while reading ${file.name}.`)), 8000);
    const done = () => {
      window.clearTimeout(timeout);
      if (element instanceof HTMLImageElement) resolve({ duration: 0, width: element.naturalWidth, height: element.naturalHeight });
      else resolve({ duration: Number.isFinite(element.duration) ? element.duration : 0, width: element instanceof HTMLVideoElement ? element.videoWidth : 0, height: element instanceof HTMLVideoElement ? element.videoHeight : 0 });
    };
    element.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error(`${file.name} could not be decoded by this browser.`));
    };
    if (element instanceof HTMLImageElement) {
      element.onload = done;
      element.src = url;
    } else {
      element.preload = "metadata";
      element.onloadedmetadata = done;
      element.src = url;
    }
  });
}

const PARTIAL_HASH_SAMPLE_BYTES = 4 * 1024 * 1024;

async function partialHashFor(file: File): Promise<NonNullable<MediaFingerprint["partialHash"]>> {
  const sampleSize = Math.min(PARTIAL_HASH_SAMPLE_BYTES, file.size);
  const offsets = [
    0,
    Math.max(0, Math.floor((file.size - sampleSize) / 2)),
    Math.max(0, file.size - sampleSize),
  ];
  const uniqueOffsets = [...new Set(offsets)];
  const chunks: Uint8Array[] = [];
  const sizes: number[] = [];
  for (const offset of uniqueOffsets) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + sampleSize)).arrayBuffer());
    chunks.push(bytes);
    sizes.push(bytes.byteLength);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { combined.set(chunk, cursor); cursor += chunk.byteLength; }
  const digest = await crypto.subtle.digest("SHA-256", combined);
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return { algorithm: "SHA-256", sampleOffsets: uniqueOffsets, sampleSizes: sizes, digest: hex };
}

async function fingerprintFor(file: File, signature: string, metadata: { duration: number; width: number; height: number }, technical: { frameRate?: number; videoCodec?: string; colorInfo?: VideoColorInfo; audioInfo?: AudioMediaInfo } = {}): Promise<MediaFingerprint> {
  return {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    signature,
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    ...technical,
    partialHash: await partialHashFor(file),
  };
}

export async function inspectFile(
  file: File,
  projectId: string,
  options: { fileHandle?: FileSystemFileHandle; storageMode?: MediaStorageMode } = {},
): Promise<RuntimeAsset> {
  if (!file.size) throw new Error(`${file.name} is empty.`);
  const signature = readSignature(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
  const kind = kindForFile(file, signature);
  if (!kind) throw new Error(`${file.name} is not a supported video, audio, image, SRT, or WebVTT file.`);
  const url = URL.createObjectURL(file);
  try {
    let nativeDecodable = true;
    let metadata: { duration: number; width: number; height: number };
    let probe: MediaProbe | undefined;
    try {
      metadata = await loadElementMetadata(file, kind, url);
    } catch (nativeError) {
      if (kind === "image" || kind === "subtitle") throw nativeError;
      const { probeMediaBlob } = await import("./ffmpeg");
      probe = await probeMediaBlob(file, file.name);
      const video = probe.streams.find((stream) => stream.codec_type === "video");
      const audio = probe.streams.find((stream) => stream.codec_type === "audio");
      const duration = Number(probe.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
      if (!Number.isFinite(duration) || duration <= 0) throw nativeError;
      metadata = { duration, width: Number(video?.width ?? 0), height: Number(video?.height ?? 0) };
      nativeDecodable = false;
    }
    if ((kind === "video" || kind === "audio") && !probe) {
      try {
        probe = await optionalTechnicalProbe(file);
      } catch {
        // Browser metadata remains usable. Unknown technical metadata is never fabricated.
        // Import must not wait indefinitely for optional FFmpeg probing on slower engines.
      }
    }
    const videoStream = probe?.streams.find((stream) => stream.codec_type === "video");
    const audioStream = probe?.streams.find((stream) => stream.codec_type === "audio");
    const frameRate = parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate);
    const colorInfo = videoStream ? videoColorInfoFromStream(videoStream as unknown as Record<string, unknown>) : undefined;
    const audioInfo: AudioMediaInfo | undefined = audioStream ? {
      sampleRate: Number(audioStream.sample_rate) || undefined,
      channels: Number(audioStream.channels) || undefined,
      channelLayout: audioStream.channel_layout || undefined,
      bitrate: Number(audioStream.bit_rate) || undefined,
      codec: audioStream.codec_name || undefined,
    } : undefined;
    const technical = { frameRate, videoCodec: videoStream?.codec_name, colorInfo, audioInfo };
    const mode =
      options.storageMode ??
      assessImportStorage(file.size, {}, { hasPersistentHandle: Boolean(options.fileHandle) }).mode;
    return {
      id: uid("asset"),
      projectId,
      name: file.name.replace(/[<>]/g, ""),
      kind,
      mime: file.type || "application/octet-stream",
      size: file.size,
      signature,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      ...technical,
      createdAt: new Date().toISOString(),
      nativeDecodable,
      storageMode: mode,
      risk: mediaRisk(file.size),
      sourceLastModified: file.lastModified,
      fingerprint: await fingerprintFor(file, signature, metadata, technical),
      fileHandle: options.fileHandle,
      offline: false,
      blob: file,
      url,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function decideFileStorage(
  fileSize: number,
  options: { hasPersistentHandle?: boolean; forceReference?: boolean } = {},
) {
  let estimate: StorageEstimate | undefined;
  try {
    estimate = await navigator.storage?.estimate?.();
  } catch {
    estimate = undefined;
  }
  return assessImportStorage(fileSize, estimate, options);
}

export function supportsReferenceImport(): boolean {
  return typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
}

export async function pickReferenceFiles(): Promise<Array<{ file: File; handle: FileSystemFileHandle }>> {
  if (!supportsReferenceImport()) throw new Error("Persistent file references are not supported by this browser.");
  const handles = await window.showOpenFilePicker!({
    multiple: true,
    types: [
      { description: "VideoFlow media", accept: {
        "video/*": [".mp4", ".webm", ".mov", ".mkv", ".avi"],
        "audio/*": [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"],
        "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif"],
      } },
    ],
  });
  const output: Array<{ file: File; handle: FileSystemFileHandle }> = [];
  for (const handle of handles) output.push({ file: await handle.getFile(), handle });
  return output;
}

async function ensureReadPermission(handle: PermissionCapableHandle, request: boolean): Promise<boolean> {
  try {
    const current = await handle.queryPermission?.({ mode: "read" });
    if (!current || current === "granted") return true;
    if (current === "denied" && !request) return false;
    if (!request) return false;
    return (await handle.requestPermission?.({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
}

function closeUrl(asset: Pick<RuntimeAsset, "url">): void {
  if (asset.url) URL.revokeObjectURL(asset.url);
}

export function fingerprintMatches(asset: Pick<RuntimeAsset, "fingerprint" | "name" | "size" | "signature" | "sourceLastModified">, file: File, signature?: string): { match: boolean; confidence: "high" | "medium" | "low"; reason: string } {
  const expected = asset.fingerprint;
  const nameMatch = (expected?.name ?? asset.name) === file.name;
  const sizeMatch = (expected?.size ?? asset.size) === file.size;
  const modifiedMatch = !expected?.lastModified || expected.lastModified === file.lastModified;
  const signatureMatch = !signature || signature === (expected?.signature ?? asset.signature);
  const score = [nameMatch, sizeMatch, modifiedMatch, signatureMatch].filter(Boolean).length;
  return {
    match: sizeMatch && signatureMatch && score >= 3,
    confidence: score === 4 ? "high" : score === 3 ? "medium" : "low",
    reason: `name ${nameMatch ? "matches" : "differs"}, size ${sizeMatch ? "matches" : "differs"}, modified date ${modifiedMatch ? "matches" : "differs"}, signature ${signatureMatch ? "matches" : "differs"}`,
  };
}


export async function fingerprintMatchesAsync(asset: Pick<RuntimeAsset, "fingerprint" | "name" | "size" | "signature" | "sourceLastModified">, file: File, signature?: string): Promise<{ match: boolean; confidence: "high" | "medium" | "low"; reason: string }> {
  const structural = fingerprintMatches(asset, file, signature);
  const expectedHash = asset.fingerprint?.partialHash;
  if (!structural.match || !expectedHash) return structural;
  const actualHash = await partialHashFor(file);
  const hashMatch = actualHash.algorithm === expectedHash.algorithm && actualHash.digest === expectedHash.digest;
  return {
    match: structural.match && hashMatch,
    confidence: hashMatch ? "high" : "low",
    reason: `${structural.reason}, partial SHA-256 ${hashMatch ? "matches" : "differs"}`,
  };
}

export async function reconnectAssetFromHandle(asset: RuntimeAsset, requestPermission = false): Promise<RuntimeAsset> {
  const handle = asset.fileHandle as PermissionCapableHandle | undefined;
  if (!handle) return { ...asset, blob: undefined, url: undefined, offline: true };
  if (!(await ensureReadPermission(handle, requestPermission))) {
    return { ...asset, blob: undefined, url: undefined, offline: true };
  }
  try {
    const file = await handle.getFile();
    const signature = readSignature(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
    const comparison = await fingerprintMatchesAsync(asset, file, signature);
    if (!comparison.match) return { ...asset, blob: undefined, url: undefined, offline: true };
    closeUrl(asset);
    return {
      ...asset,
      blob: file,
      url: URL.createObjectURL(file),
      sourceLastModified: file.lastModified,
      offline: false,
    };
  } catch {
    return { ...asset, blob: undefined, url: undefined, offline: true };
  }
}

export async function relinkRuntimeAsset(asset: RuntimeAsset, file: File, handle?: FileSystemFileHandle): Promise<{ asset: RuntimeAsset; confidence: "high" | "medium" | "low"; reason: string }> {
  const signature = readSignature(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
  const comparison = await fingerprintMatchesAsync(asset, file, signature);
  if (!comparison.match) {
    throw new Error(`Selected file does not appear to match ${asset.name}: ${comparison.reason}.`);
  }
  closeUrl(asset);
  return {
    asset: {
      ...asset,
      name: file.name.replace(/[<>]/g, ""),
      blob: file,
      url: URL.createObjectURL(file),
      fileHandle: handle,
      storageMode: handle ? "reference" : "session",
      sourceLastModified: file.lastModified,
      fingerprint: await fingerprintFor(file, signature, {
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
      }),
      offline: false,
    },
    confidence: comparison.confidence,
    reason: comparison.reason,
  };
}


export function supportsDiskBackedExport(): boolean {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

export async function pickExportFileHandle(
  suggestedName: string,
  mime = "video/mp4",
): Promise<FileSystemFileHandle> {
  if (!supportsDiskBackedExport()) {
    throw new Error("Direct disk-backed saving is not supported by this browser.");
  }
  const extension = `.${suggestedName.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "mp4"}`;
  return window.showSaveFilePicker!({
    suggestedName,
    types: [{ description: "VideoFlow export", accept: { [mime]: [extension] } }],
  });
}

export async function saveBlobToDisk(blob: Blob, suggestedName: string): Promise<boolean> {
  if (typeof window === "undefined" || typeof window.showSaveFilePicker !== "function") return false;
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [{ description: "VideoFlow export", accept: { [blob.type || "application/octet-stream"]: [`.${suggestedName.split(".").pop() ?? "bin"}`] } }],
  });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  return true;
}

export function revokeAssets(assets: RuntimeAsset[]): void {
  for (const asset of assets) {
    if (asset.url) URL.revokeObjectURL(asset.url);
    if (asset.proxyUrl) URL.revokeObjectURL(asset.proxyUrl);
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
