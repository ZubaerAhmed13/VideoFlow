import { clipDuration, resolveWatermarkMask, uid } from "../core.mjs";
import { concatenateMp4Batches, encodeImageFramesToMp4 } from "../ffmpeg";
import type { ExportSettings, RuntimeAsset, Track, VideoFlowProject, WatermarkMask } from "../types";
import { DEFAULT_AI_SETTINGS, effectiveAISettings, reconstructFrame } from "./AIManager";
import { compositeInpaintedROI } from "./inpainting/InpaintPostprocessor";
import { blendBidirectionalContext, SlidingTemporalWindow, type TemporalFrame } from "./temporal/TemporalContext";
import type { AIFrameResult, AISettings, TrackingPoint } from "./types";
import { updateAIDiagnostics } from "./AIDiagnostics";

function seekVideo(video: HTMLVideoElement, time: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("AI render cancelled.", "AbortError"));
  const target = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : time, time));
  if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.0005) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException("AI render cancelled.", "AbortError")); };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("Could not decode an AI source frame.")); };
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      video.removeEventListener("seeked", loaded);
      video.removeEventListener("error", failed);
    };
    signal.addEventListener("abort", abort, { once: true });
    video.addEventListener("seeked", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.currentTime = target;
  });
}

function toIntermediateFrame(canvas: HTMLCanvasElement, format: "png-lossless" | "jpeg-fallback"): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Could not encode AI frame.")),
    format === "png-lossless" ? "image/png" : "image/jpeg",
    format === "png-lossless" ? undefined : 0.96,
  ));
}

function trackingAt(points: TrackingPoint[] | undefined, time: number): TrackingPoint | null {
  if (!points?.length) return null;
  const sorted = [...points].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) return sorted[0];
  if (time >= sorted.at(-1)!.time) return sorted.at(-1)!;
  const nextIndex = sorted.findIndex((point) => point.time >= time);
  const before = sorted[nextIndex - 1], after = sorted[nextIndex];
  const span = Math.max(0.000001, after.time - before.time);
  const ratio = (time - before.time) / span;
  return {
    time,
    x: before.x + (after.x - before.x) * ratio,
    y: before.y + (after.y - before.y) * ratio,
    width: before.width + (after.width - before.width) * ratio,
    height: before.height + (after.height - before.height) * ratio,
    confidence: Math.min(before.confidence ?? 1, after.confidence ?? 1),
    method: before.manual || after.manual ? "manual" : "template",
  };
}

function resolvedAIMask(mask: WatermarkMask, timelineTime: number): WatermarkMask {
  const base = resolveWatermarkMask(mask, timelineTime) as WatermarkMask;
  const tracked = trackingAt(mask.ai?.tracking, timelineTime);
  return tracked ? { ...base, x: tracked.x, y: tracked.y, width: tracked.width, height: tracked.height } : base;
}

function aiSettings(mask: WatermarkMask): AISettings {
  return { ...DEFAULT_AI_SETTINGS, ...(mask.ai ?? {}) } as AISettings;
}

type PatchRecord = {
  maskId: string;
  mask: WatermarkMask;
  settings: AISettings;
  result: AIFrameResult;
};

type FrameEntry = {
  index: number;
  timelineTime: number;
  sourceTime: number;
  patches: PatchRecord[];
};

function temporalFrame(entry: FrameEntry | undefined, maskId: string): TemporalFrame | null {
  const patch = entry?.patches.find((candidate) => candidate.maskId === maskId);
  return patch ? {
    source: patch.result.sourceROI,
    reconstruction: patch.result.imageData,
    index: entry?.index,
    time: entry?.timelineTime,
  } : null;
}

function maximumRadius(clip: VideoFlowProject["clips"][number]): number {
  return clip.watermarkMasks
    .filter((mask) => mask.enabled && mask.method === "ai")
    .reduce((maximum, mask) => Math.max(maximum, Math.floor(effectiveAISettings(aiSettings(mask)).temporalWindow / 2)), 0);
}

function microBatchSize(width: number, height: number, clip: VideoFlowProject["clips"][number]): number {
  if (width * height >= 3840 * 2160) return 2;
  const quality = clip.watermarkMasks.find((mask) => mask.method === "ai")?.ai?.quality ?? "balanced";
  return quality === "maximum" ? 5 : quality === "high" ? 8 : quality === "balanced" ? 12 : 16;
}

async function renderAIClip(
  project: Pick<VideoFlowProject, "id" | "settings">,
  clip: VideoFlowProject["clips"][number],
  asset: RuntimeAsset,
  exportSettings: ExportSettings,
  signal: AbortSignal,
  onProgress: (progress: number, phase: string) => void,
): Promise<RuntimeAsset> {
  const sourceUrl = asset.url ?? (asset.blob ? URL.createObjectURL(asset.blob) : undefined);
  if (!sourceUrl || asset.offline) throw new Error(`AI source ${asset.name} is offline. Relink the original before export.`);
  const revoke = !asset.url && Boolean(asset.blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = sourceUrl;
  const batchFrames: Blob[] = [];
  const encodedBatches: Blob[] = [];
  let intermediate: "png-lossless" | "jpeg-fallback" = "png-lossless";
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error(`Could not decode ${asset.name} for AI reconstruction.`));
    });
    const width = asset.width || video.videoWidth || project.settings.width;
    const height = asset.height || video.videoHeight || project.settings.height;
    const fps = Math.max(1, Math.min(exportSettings.fps || project.settings.fps, 60));
    const duration = clipDuration(clip);
    const frameCount = Math.max(1, Math.ceil(duration * fps));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("AI composition canvas is unavailable.");
    const radius = maximumRadius(clip);
    const window = new SlidingTemporalWindow<FrameEntry>(radius);
    const maxBatch = microBatchSize(width, height, clip);
    let nextDecodeIndex = 0;

    const decodeEntry = async (index: number): Promise<FrameEntry> => {
      const localTime = Math.min(duration, index / fps);
      const timelineTime = clip.timelineStart + localTime;
      const sourceTime = clip.sourceStart + localTime * clip.speed;
      await seekVideo(video, sourceTime, signal);
      const patches: PatchRecord[] = [];
      const activeMasks = clip.watermarkMasks.filter((entry) => entry.enabled && entry.method === "ai" && timelineTime >= entry.start && timelineTime <= entry.end);
      for (const mask of activeMasks) {
        if (signal.aborted) throw new DOMException("AI render cancelled.", "AbortError");
        const resolved = resolvedAIMask(mask, timelineTime);
        const settings = effectiveAISettings(aiSettings(mask));
        const result = await reconstructFrame(video, width, height, resolved, settings, null, signal);
        patches.push({ maskId: mask.id, mask: resolved, settings, result });
      }
      return { index, timelineTime, sourceTime, patches };
    };

    const flushBatch = async () => {
      if (!batchFrames.length) return;
      const frames = batchFrames.splice(0, batchFrames.length);
      const batchNumber = encodedBatches.length + 1;
      const encoded = await encodeImageFramesToMp4(frames, fps, signal, (_progress, phase) => {
        onProgress(Math.min(0.94, nextDecodeIndex / Math.max(1, frameCount) * 0.9), `AI micro-batch ${batchNumber} • ${phase}`);
      });
      frames.length = 0;
      encodedBatches.push(encoded);
    };

    for (let targetIndex = 0; targetIndex < frameCount; targetIndex += 1) {
      if (signal.aborted) throw new DOMException("AI render cancelled.", "AbortError");
      const lookAhead = Math.min(frameCount - 1, targetIndex + radius);
      while (nextDecodeIndex <= lookAhead) {
        window.set(nextDecodeIndex, await decodeEntry(nextDecodeIndex));
        nextDecodeIndex += 1;
        onProgress(nextDecodeIndex / Math.max(1, frameCount) * 0.72, `AI lookahead ${nextDecodeIndex}/${frameCount} • window ≤ ${radius * 2 + 1} frames`);
      }
      const target = window.get(targetIndex);
      if (!target) throw new Error("AI sliding window lost its target frame.");
      await seekVideo(video, target.sourceTime, signal);
      context.filter = "none";
      context.globalAlpha = 1;
      context.drawImage(video, 0, 0, width, height);
      for (const patch of target.patches) {
        const patchRadius = Math.floor(patch.settings.temporalWindow / 2);
        const past: TemporalFrame[] = [];
        const future: TemporalFrame[] = [];
        for (let offset = 1; offset <= patchRadius; offset += 1) {
          const pastFrame = temporalFrame(window.get(targetIndex - offset), patch.maskId);
          const futureFrame = temporalFrame(window.get(targetIndex + offset), patch.maskId);
          if (pastFrame) past.unshift(pastFrame);
          if (futureFrame) future.push(futureFrame);
        }
        const temporal = blendBidirectionalContext(
          patch.result.imageData,
          patch.result.sourceROI,
          { past, future },
          patch.settings.consistencyStrength,
        );
        compositeInpaintedROI(context, temporal.imageData, patch.result.roi, patch.mask, patch.settings.feather, patch.settings.blendingStrength);
      }
      let frame: Blob;
      try {
        frame = await toIntermediateFrame(canvas, intermediate);
      } catch (error) {
        if (intermediate === "jpeg-fallback") throw error;
        await flushBatch();
        intermediate = "jpeg-fallback";
        updateAIDiagnostics({ intermediate });
        frame = await toIntermediateFrame(canvas, intermediate);
      }
      updateAIDiagnostics({ intermediate });
      batchFrames.push(frame);
      if (batchFrames.length >= maxBatch) await flushBatch();
      window.discardBefore(targetIndex);
      onProgress(0.72 + ((targetIndex + 1) / frameCount) * 0.18, `AI frame ${targetIndex + 1}/${frameCount} • past + future context`);
    }
    await flushBatch();
    window.clear();
    const blob = await concatenateMp4Batches(encodedBatches, signal, (progress, phase) => onProgress(0.9 + progress * 0.1, phase));
    encodedBatches.length = 0;
    return {
      id: uid("ai-asset"), projectId: project.id, name: `${clip.name}-ai.mp4`, kind: "video", mime: "video/mp4", size: blob.size,
      duration, width, height, createdAt: new Date().toISOString(), signature: "iso-base-media", nativeDecodable: true,
      storageMode: "session", risk: "normal", offline: false, blob, url: URL.createObjectURL(blob),
    };
  } finally {
    batchFrames.length = 0;
    encodedBatches.length = 0;
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (revoke) URL.revokeObjectURL(sourceUrl);
  }
}

export async function renderAIPreviewSegment(
  clip: VideoFlowProject["clips"][number],
  mask: WatermarkMask,
  asset: RuntimeAsset,
  timelineStart: number,
  duration: number,
  signal: AbortSignal,
  onProgress: (progress: number, phase: string) => void,
): Promise<Blob> {
  const boundedDuration = Math.max(0.1, Math.min(10, duration, clip.timelineStart + clipDuration(clip) - timelineStart));
  const localOffset = Math.max(0, timelineStart - clip.timelineStart);
  const previewClip = {
    ...structuredClone(clip),
    timelineStart,
    sourceStart: clip.sourceStart + localOffset * clip.speed,
    sourceEnd: clip.sourceStart + (localOffset + boundedDuration) * clip.speed,
    watermarkMasks: [{ ...structuredClone(mask), start: timelineStart, end: timelineStart + boundedDuration }],
  };
  const width = asset.width || 1280;
  const height = asset.height || 720;
  const fps = Math.max(1, Math.min(30, asset.proxy?.fps || 24));
  const result = await renderAIClip(
    { id: "ai-preview", settings: { width, height, fps, snapping: false, snapSeconds: 0.1, previewQuality: "full", masterGain: 1, backgroundColor: "#000000" } },
    previewClip,
    asset,
    {
      preset: "balanced", format: "mp4", width, height, fps,
      videoBitrate: 8_000_000, audioBitrate: 128_000, audioSampleRate: 48000,
      videoCodec: "h264", audioCodec: "none", includeAudio: false,
      gifFps: 15, gifWidth: 720, aspectStrategy: "fit",
    },
    signal,
    onProgress,
  );
  if (!result.blob) throw new Error("AI preview encoder returned no media.");
  if (result.url) URL.revokeObjectURL(result.url);
  return result.blob;
}

export async function prepareAIAssetsForExport(
  project: VideoFlowProject,
  assets: RuntimeAsset[],
  settings: ExportSettings,
  signal: AbortSignal,
  onProgress: (progress: number, phase: string) => void,
): Promise<{ project: VideoFlowProject; assets: RuntimeAsset[]; cleanup: () => void }> {
  const aiClips = project.clips.filter((clip) => clip.kind === "video" && clip.watermarkMasks.some((mask) => mask.enabled && mask.method === "ai"));
  if (!aiClips.length) return { project, assets, cleanup: () => undefined };
  const nextProject = structuredClone(project);
  const nextAssets = [...assets];
  const generated: RuntimeAsset[] = [];
  const audioTrackId = uid("ai-audio-track");
  const audioTrack: Track = { id: audioTrackId, name: "AI source audio", kind: "audio", index: nextProject.tracks.length, muted: false, solo: false, locked: false, visible: true, gain: 1 };
  let addedAudioTrack = false;
  for (let index = 0; index < aiClips.length; index += 1) {
    const sourceClip = aiClips[index];
    const sourceAsset = assets.find((asset) => asset.id === sourceClip.assetId);
    if (!sourceAsset) throw new Error(`AI source asset for ${sourceClip.name} is unavailable.`);
    onProgress(index / aiClips.length * 0.9, `AI preprocessing ${sourceClip.name}`);
    const aiAsset = await renderAIClip(project, sourceClip, sourceAsset, settings, signal, (progress, phase) => onProgress((index + progress) / aiClips.length * 0.9, phase));
    generated.push(aiAsset);
    nextAssets.push(aiAsset);
    const clipIndex = nextProject.clips.findIndex((entry) => entry.id === sourceClip.id);
    const duration = clipDuration(sourceClip);
    const originalAudio = structuredClone(nextProject.clips[clipIndex]);
    originalAudio.id = uid("ai-audio");
    originalAudio.kind = "audio";
    originalAudio.trackId = audioTrackId;
    originalAudio.watermarkMasks = [];
    originalAudio.keyframes = originalAudio.keyframes.filter((keyframe) => keyframe.property === "volume");
    nextProject.clips[clipIndex] = { ...nextProject.clips[clipIndex], assetId: aiAsset.id, sourceStart: 0, sourceEnd: duration, speed: 1, watermarkMasks: nextProject.clips[clipIndex].watermarkMasks.filter((mask) => mask.method !== "ai") };
    nextProject.clips.push(originalAudio);
    addedAudioTrack = true;
  }
  if (addedAudioTrack) nextProject.tracks.push(audioTrack);
  return { project: nextProject, assets: nextAssets, cleanup: () => generated.forEach((asset) => asset.url && URL.revokeObjectURL(asset.url)) };
}
