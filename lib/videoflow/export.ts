import { projectDuration } from "./core.mjs";
import { projectForExportRange } from "./export-range.mjs";
import { FORMAT_INFO } from "./ffmpeg-commands.mjs";
import {
  assertCompatibleFragmentInit,
  createFragmentedMp4State,
  mediaChunksForSegment,
} from "./fragmented-mp4.mjs";
import {
  probeMediaBlob,
  renderTimelineFragmentWithFfmpeg,
  renderTimelineWithFfmpeg,
  streamCopyMedia,
} from "./ffmpeg";
import { assessSmartCopy, frameRatesMatch, parseFrameRate, videoColorInfoFromStream } from "./media-quality.mjs";
import { assessRenderRisk } from "./import-policy.mjs";
import { prepareAIAssetsForExport } from "./ai/VideoInpainter";
import { DEFAULT_AI_SETTINGS, effectiveAISettings } from "./ai/AIManager";
import type {
  ExportJob,
  ExportSettings,
  RuntimeAsset,
  VideoFlowProject,
} from "./types";

type Validation = NonNullable<ExportJob["validation"]>;

export interface RenderExportResult {
  blob?: Blob;
  validation: Validation;
  filename: string;
  diskBacked: boolean;
  fileSize: number;
  segmentCount?: number;
}

export function exportFilename(
  projectName: string,
  settings: ExportSettings,
): string {
  const base =
    projectName.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") ||
    "videoflow-export";
  return `${base}.${FORMAT_INFO[settings.format].extension}`;
}

function streamDuration(
  stream: { duration?: string },
  fallback: number,
): number {
  const duration = Number(stream.duration ?? fallback);
  return Number.isFinite(duration) ? duration : fallback;
}

export async function validateExport(
  blob: Blob,
  filename: string,
  settings: ExportSettings,
  expectedDuration: number,
  signal: AbortSignal,
  exportMode: "smart-copy" | "re-encode" = "re-encode",
): Promise<Validation> {
  if (blob.size < 1024)
    throw new Error("Output validation failed: the encoded file is empty.");
  const probe = await probeMediaBlob(blob, filename, signal);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const audioOnly = ["wav", "mp3", "opus"].includes(settings.format);
  const expectsVideo = !audioOnly;
  const expectsAudio =
    audioOnly || (settings.includeAudio && settings.format !== "gif");
  if (expectsVideo && !video)
    throw new Error("Output validation failed: the video stream is missing.");
  if (expectsAudio && !audio)
    throw new Error("Output validation failed: the audio stream is missing.");
  if (!expectsAudio && audio)
    throw new Error(
      "Output validation failed: an audio stream was present after Remove Audio.",
    );
  const duration = Number(
    probe.format?.duration ??
      streamDuration(video ?? audio ?? {}, expectedDuration),
  );
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error(
      "Output validation failed: duration metadata is unreadable.",
    );
  if (
    expectedDuration > 0 &&
    Math.abs(duration - expectedDuration) > Math.max(2, expectedDuration * 0.02)
  ) {
    throw new Error(
      `Output validation failed: duration ${duration.toFixed(2)}s differs from the ${expectedDuration.toFixed(2)}s timeline.`,
    );
  }
  if (
    video &&
    settings.format !== "gif" &&
    (video.width !== settings.width || video.height !== settings.height)
  ) {
    throw new Error(
      `Output validation failed: expected ${settings.width}×${settings.height}, received ${video.width ?? 0}×${video.height ?? 0}.`,
    );
  }
  const actualFps = parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate);
  if (video && settings.format !== "gif" && !frameRatesMatch(actualFps, settings.fps)) {
    throw new Error(`Output validation failed: expected ${settings.fps.toFixed(3)} fps, received ${actualFps?.toFixed(3) ?? "unknown"} fps.`);
  }
  const colorInfo = video ? videoColorInfoFromStream(video as unknown as Record<string, unknown>) : undefined;
  const expectedColor = settings.sourceColorInfo;
  if (video && settings.colorMode === "preserve" && expectedColor && !expectedColor.hdr) {
    for (const [field, expected, actual] of [
      ["primaries", expectedColor.primaries, colorInfo?.primaries],
      ["transfer", expectedColor.transfer, colorInfo?.transfer],
      ["matrix", expectedColor.matrix, colorInfo?.matrix],
      ["range", expectedColor.range === "unknown" ? undefined : expectedColor.range, colorInfo?.range],
    ]) {
      if (expected && expected !== actual) throw new Error(`Output validation failed: colour ${field} expected ${expected}, received ${actual ?? "unspecified"}.`);
    }
  }
  const audioDuration = audio ? streamDuration(audio, duration) : undefined;
  const audioSampleRate = Number(audio?.sample_rate) || undefined;
  if (audio && settings.audioSampleRate && audioSampleRate !== settings.audioSampleRate) {
    throw new Error(`Output validation failed: expected ${settings.audioSampleRate} Hz audio, received ${audioSampleRate ?? "unknown"} Hz.`);
  }
  if (audioDuration && Math.abs(audioDuration - duration) > Math.max(0.12, duration * 0.01)) {
    throw new Error(`Output validation failed: audio duration ${audioDuration.toFixed(3)}s is not aligned with video duration ${duration.toFixed(3)}s.`);
  }
  return {
    duration,
    width: video?.width,
    height: video?.height,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    fps: actualFps,
    pixelFormat: video?.pix_fmt,
    colorInfo,
    audioSampleRate,
    audioChannels: audio?.channels,
    audioDuration,
    exportMode,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

function renderRiskFor(
  project: VideoFlowProject,
  settings: ExportSettings,
  duration: number,
) {
  return assessRenderRisk({
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    duration,
    videoBitrate: settings.videoBitrate,
    clipCount: project.clips.length,
    effectComplexity: project.clips.some(
      (clip) => clip.watermarkMasks.length || clip.keyframes.length,
    )
      ? 1.6
      : 1,
    aiEffects: project.clips.some((clip) => clip.watermarkMasks.some((mask) => mask.method === "ai")),
    directDiskAvailable: typeof window !== "undefined" && typeof window.showSaveFilePicker === "function",
    deviceMemoryGb: typeof navigator !== "undefined" ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) : undefined,
  });
}

function aiTemporalOverlapSeconds(project: VideoFlowProject, settings: ExportSettings): number {
  const maximumRadius = project.clips.reduce((clipMaximum, clip) => Math.max(
    clipMaximum,
    ...clip.watermarkMasks
      .filter((mask) => mask.enabled && mask.method === "ai")
      .map((mask) => Math.floor(effectiveAISettings({ ...DEFAULT_AI_SETTINGS, ...(mask.ai ?? {}) }).temporalWindow / 2)),
  ), 0);
  return maximumRadius / Math.max(1, settings.fps);
}

async function writeBytesToDisk(
  writable: FileSystemWritableFileStream,
  bytes: Uint8Array,
): Promise<void> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  await writable.write(copy.buffer);
}

async function clearFailedDiskOutput(handle: FileSystemFileHandle): Promise<void> {
  try {
    const writable = await handle.createWritable();
    await writable.truncate(0);
    await writable.close();
  } catch {
    // The original render error remains primary. A browser may revoke write
    // permission between the failed render and cleanup.
  }
}

async function renderDiskBackedMp4(
  project: VideoFlowProject,
  assets: RuntimeAsset[],
  settings: ExportSettings,
  targetHandle: FileSystemFileHandle,
  signal: AbortSignal,
  onProgress: (progress: number, phase: string) => void,
): Promise<RenderExportResult> {
  if (settings.format !== "mp4") {
    throw new Error(
      "Direct disk-backed segmented export currently supports MP4/H.264 only. Use standard export for other formats.",
    );
  }
  const duration = projectDuration(project);
  const risk = renderRiskFor(project, settings, duration);
  const hasAI = project.clips.some((clip) => clip.watermarkMasks.some((mask) => mask.enabled && mask.method === "ai"));
  const segmentSeconds = hasAI
    ? Math.min(8, Math.max(2, risk.segmentSeconds))
    : Math.max(
        5,
        Math.min(
          300,
          risk.level === "very-high" ? Math.min(60, risk.segmentSeconds) : risk.segmentSeconds,
        ),
      );
  const segmentCount = Math.max(1, Math.ceil(duration / segmentSeconds));
  const temporalOverlap = hasAI ? aiTemporalOverlapSeconds(project, settings) : 0;
  const filename = exportFilename(project.name, settings);
  let writable: Awaited<ReturnType<FileSystemFileHandle["createWritable"]>> | null = null;
  let closed = false;
  let bytesWritten = 0;
  let state: ReturnType<typeof createFragmentedMp4State> | null = null;

  try {
    onProgress(0.01, `Preparing bounded export • ${segmentCount} segment${segmentCount === 1 ? "" : "s"}`);
    writable = await targetHandle.createWritable();
    for (let index = 0; index < segmentCount; index += 1) {
      if (signal.aborted) throw new DOMException("Export cancelled.", "AbortError");
      const start = index * segmentSeconds;
      const end = Math.min(duration, start + segmentSeconds);
      const expandedStart = Math.max(0, start - temporalOverlap);
      const expandedEnd = Math.min(duration, end + temporalOverlap);
      const segmentProject = projectForExportRange(project, expandedStart, expandedEnd);
      const baseProgress = index / segmentCount;
      const aiPrepared = await prepareAIAssetsForExport(
        segmentProject,
        assets,
        settings,
        signal,
        (aiProgress, phase) => onProgress(0.02 + (baseProgress + aiProgress / segmentCount) * 0.36, phase),
      );
      let segmentBlob: Blob;
      try {
        const coreProject = temporalOverlap > 0
          ? projectForExportRange(aiPrepared.project, start - expandedStart, end - expandedStart)
          : aiPrepared.project;
        segmentBlob = await renderTimelineFragmentWithFfmpeg(
          coreProject,
          aiPrepared.assets,
          settings,
          signal,
          (segmentProgress, phase) => {
            const overall = 0.02 + (baseProgress + segmentProgress / segmentCount) * 0.86;
            onProgress(
              Math.min(0.88, overall),
              `Segment ${index + 1}/${segmentCount} • temporal overlap ${temporalOverlap.toFixed(3)}s • ${phase}`,
            );
          },
        );
      } finally {
        aiPrepared.cleanup();
      }
      const segmentBytes = new Uint8Array(await segmentBlob.arrayBuffer());
      if (!state) {
        state = createFragmentedMp4State(segmentBytes);
        await writeBytesToDisk(writable, state.initSegment);
        bytesWritten += state.initSegment.byteLength;
      } else {
        assertCompatibleFragmentInit(segmentBytes, state);
      }
      const chunks = mediaChunksForSegment(segmentBytes, state, start);
      for (const chunk of chunks) {
        if (signal.aborted) throw new DOMException("Export cancelled.", "AbortError");
        await writeBytesToDisk(writable, chunk);
        bytesWritten += chunk.byteLength;
      }
      onProgress(
        0.02 + ((index + 1) / segmentCount) * 0.86,
        `Wrote segment ${index + 1}/${segmentCount} directly to disk`,
      );
    }
    await writable.close();
    closed = true;
    onProgress(0.9, "Validating disk-backed MP4");
    const outputFile = await targetHandle.getFile();
    const validation = await validateExport(
      outputFile,
      filename,
      settings,
      duration,
      signal,
    );
    onProgress(1, "Complete • saved directly to disk");
    return {
      validation,
      filename,
      diskBacked: true,
      fileSize: outputFile.size || bytesWritten,
      segmentCount,
    };
  } catch (error) {
    if (writable && !closed) {
      try {
        const abortable = writable as typeof writable & { abort?: (reason?: unknown) => Promise<void> };
        if (typeof abortable.abort === "function") await abortable.abort(error);
        else await writable.close();
      } catch {
        // Cleanup is best-effort; the thrown render error is more useful.
      }
    }
    await clearFailedDiskOutput(targetHandle);
    if (signal.aborted) throw new DOMException("Export cancelled.", "AbortError");
    throw error;
  }
}

export async function renderExport(
  project: VideoFlowProject,
  assets: RuntimeAsset[],
  settings: ExportSettings,
  signal: AbortSignal,
  onProgress: (progress: number, phase: string) => void,
  targetHandle?: FileSystemFileHandle,
): Promise<RenderExportResult> {
  const rangedProject = projectForExportRange(
    project,
    settings.rangeStart ?? 0,
    settings.rangeEnd ?? projectDuration(project),
  );
  const configuredProject: VideoFlowProject = {
    ...rangedProject,
    settings: {
      ...rangedProject.settings,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
    },
  };
  const duration = projectDuration(configuredProject);
  if (duration <= 0) throw new Error("The timeline is empty.");

  const smartCopy = assessSmartCopy(configuredProject, assets, settings);
  if (!targetHandle && smartCopy.eligible && smartCopy.asset?.blob && (settings.format === "mp4" || settings.format === "webm")) {
    onProgress(0.05, "Smart Copy • preserving original compressed streams");
    const blob = await streamCopyMedia(
      smartCopy.asset.blob,
      smartCopy.asset.name,
      settings.format,
      settings.includeAudio,
      signal,
      (progress, phase) => onProgress(0.05 + progress * 0.85, phase),
    );
    const filename = exportFilename(project.name, settings);
    const validation = await validateExport(blob, filename, settings, duration, signal, "smart-copy");
    onProgress(1, "Complete • Smart Copy");
    return { blob, validation, filename, diskBacked: false, fileSize: blob.size };
  }

  if (targetHandle) {
    return renderDiskBackedMp4(
      configuredProject,
      assets,
      settings,
      targetHandle,
      signal,
      onProgress,
    );
  }

  const risk = renderRiskFor(configuredProject, settings, duration);
  if (!risk.inMemoryAllowed) {
    throw new Error(risk.recommendation);
  }

  onProgress(0.01, "Preparing sources");
  const aiPrepared = await prepareAIAssetsForExport(
    configuredProject,
    assets,
    settings,
    signal,
    (progress, phase) => onProgress(0.02 + progress * 0.42, phase),
  );
  let blob: Blob;
  try {
    blob = await renderTimelineWithFfmpeg(
      aiPrepared.project,
      aiPrepared.assets,
      settings,
      signal,
      (progress, phase) => onProgress(0.44 + progress * 0.48, phase),
    );
  } finally {
    aiPrepared.cleanup();
  }
  const filename = exportFilename(project.name, settings);
  onProgress(0.94, "Validating container and streams");
  const validation = await validateExport(
    blob,
    filename,
    settings,
    duration,
    signal,
  );
  onProgress(1, "Complete");
  return {
    blob,
    validation,
    filename,
    diskBacked: false,
    fileSize: blob.size,
  };
}
