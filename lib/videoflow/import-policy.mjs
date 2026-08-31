export const MEBIBYTE = 1024 * 1024;
export const GIBIBYTE = 1024 * MEBIBYTE;
export const LARGE_MEDIA_BYTES = 100 * MEBIBYTE;
export const REFERENCE_MEDIA_BYTES = 500 * MEBIBYTE;
export const MULTI_GIGABYTE_TARGET = 3 * GIBIBYTE;

/** @typedef {"normal" | "large" | "very-large"} MediaRisk */
/** @typedef {"persisted" | "reference" | "session"} MediaStorageMode */
/** @typedef {{ mode: MediaStorageMode, risk: MediaRisk, reason?: string }} ImportStorageDecision */

/** @returns {MediaRisk} */
export function mediaRisk(size) {
  if (size >= REFERENCE_MEDIA_BYTES) return "very-large";
  if (size >= LARGE_MEDIA_BYTES) return "large";
  return "normal";
}

/**
 * Choose a storage mode without copying large originals into IndexedDB.
 * Reference mode is selected only when the caller confirms a persistent
 * FileSystemFileHandle exists; otherwise large media is session-attached.
 *
 * @param {number} size
 * @param {{ quota?: number, usage?: number }} [estimate]
 * @param {{ hasPersistentHandle?: boolean, forceReference?: boolean }} [options]
 * @returns {ImportStorageDecision}
 */
export function assessImportStorage(size, estimate = {}, options = {}) {
  const risk = mediaRisk(size);
  if (options.forceReference || (size >= REFERENCE_MEDIA_BYTES && options.hasPersistentHandle)) {
    return {
      mode: "reference",
      risk,
      reason: "The original stays outside browser storage and is reopened through a persistent file reference.",
    };
  }
  if (size >= REFERENCE_MEDIA_BYTES) {
    return {
      mode: "session",
      risk,
      reason: "This browser session can use the original without duplicating it into IndexedDB. Re-link after restart unless a reference import is used.",
    };
  }

  const quota = Number(estimate.quota);
  const usage = Number(estimate.usage);
  if (Number.isFinite(quota) && Number.isFinite(usage)) {
    const available = Math.max(0, quota - usage);
    const required = Math.ceil(size * 1.25) + 64 * MEBIBYTE;
    if (available < required) {
      if (options.hasPersistentHandle) {
        return {
          mode: "reference",
          risk,
          reason: "Browser storage lacks headroom, so the original remains reference-based.",
        };
      }
      return {
        mode: "session",
        risk,
        reason: "Browser storage lacks enough headroom for a durable source copy.",
      };
    }
  }

  return { mode: "persisted", risk };
}

/**
 * Structural render-risk estimate used before local export.
 * @param {{width:number,height:number,fps:number,duration:number,videoBitrate:number,effectComplexity?:number,clipCount?:number,aiEffects?:boolean,directDiskAvailable?:boolean,deviceMemoryGb?:number}} input
 */
export function assessRenderRisk(input) {
  const pixels = Math.max(1, input.width * input.height);
  const duration = Math.max(0, input.duration);
  const bitrate = Math.max(0, input.videoBitrate);
  const estimatedBytes = Math.ceil((bitrate / 8) * duration * 1.12);
  const pixelRate = pixels * Math.max(1, input.fps);
  const aiEffects = Boolean(input.aiEffects);
  const complexity = Math.max(1, input.effectComplexity ?? 1) * (aiEffects ? 1.55 : 1);
  const clipFactor = 1 + Math.min(4, Math.max(0, (input.clipCount ?? 1) - 1) * 0.08);
  const score = (pixelRate / (1920 * 1080 * 30)) * complexity * clipFactor;
  const directDisk = Boolean(input.directDiskAvailable);
  const fourK = input.width >= 3840 || input.height >= 2160;

  let memoryRisk = "LOW";
  if (estimatedBytes >= 1024 * MEBIBYTE || score >= 8 || (fourK && aiEffects)) memoryRisk = "VERY HIGH";
  else if (estimatedBytes >= 500 * MEBIBYTE || score >= 4 || aiEffects) memoryRisk = "HIGH";
  else if (estimatedBytes >= 250 * MEBIBYTE || score >= 2 || fourK) memoryRisk = "MEDIUM";

  // There is no universal safe Blob size in browsers. Keep the default
  // conservative and expand it only when the browser reports meaningful
  // device-memory headroom. 4K/AI workloads reserve extra space for decode,
  // ROI tensors and encoder buffers. Direct-to-disk is an alternative path,
  // not a reason to allocate a larger in-memory Blob.
  const deviceMemory = Number(input.deviceMemoryGb);
  let inMemoryLimitBytes = 512 * MEBIBYTE;
  if (Number.isFinite(deviceMemory)) {
    if (deviceMemory <= 4) inMemoryLimitBytes = 384 * MEBIBYTE;
    else if (deviceMemory >= 16) inMemoryLimitBytes = 1024 * MEBIBYTE;
    else if (deviceMemory >= 8) inMemoryLimitBytes = 768 * MEBIBYTE;
  }
  if (fourK) inMemoryLimitBytes *= 0.85;
  if (aiEffects) inMemoryLimitBytes *= 0.72;
  if (score >= 8) inMemoryLimitBytes *= 0.75;
  inMemoryLimitBytes = Math.round(Math.max(256 * MEBIBYTE, Math.min(1024 * MEBIBYTE, inMemoryLimitBytes)));
  const inMemoryAllowed = estimatedBytes <= inMemoryLimitBytes;
  const largeOutputWarning = estimatedBytes >= 500 * MEBIBYTE || memoryRisk === "HIGH" || memoryRisk === "VERY HIGH";

  const level = memoryRisk === "VERY HIGH" ? "very-high" : memoryRisk === "HIGH" ? "high" : memoryRisk === "MEDIUM" ? "moderate" : "normal";
  const segmentSeconds = level === "very-high" ? (aiEffects ? 8 : 60) : level === "high" ? (aiEffects ? 8 : 120) : level === "moderate" ? (aiEffects ? 8 : 300) : (aiEffects ? 8 : 600);
  const recommendation = !inMemoryAllowed && directDisk
    ? `Estimated output exceeds the ${Math.round(inMemoryLimitBytes / MEBIBYTE)} MiB capability-aware memory budget. Use direct-to-disk segmented export.`
    : !inMemoryAllowed
      ? `Estimated output exceeds the ${Math.round(inMemoryLimitBytes / MEBIBYTE)} MiB capability-aware memory budget. Shorten the range or use a browser with direct-to-disk output.`
      : largeOutputWarning && directDisk
        ? "High local workload: direct-to-disk segmented export is recommended."
        : largeOutputWarning
          ? "High local workload: keep the export bounded and close other heavy media/AI jobs."
          : "Standard bounded export is appropriate.";
  return { level, memoryRisk, estimatedBytes, segmentSeconds, score, recommendation, inMemoryLimitBytes, inMemoryAllowed, largeOutputWarning };
}
