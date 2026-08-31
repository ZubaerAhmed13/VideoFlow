import type { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";

import { deploymentAssetUrl } from "./base-url";
import { videoFlowResources } from "./resource-manager";
import {
  FORMAT_INFO,
  buildAudioProcessArgs,
  buildProxyArgs,
  buildStabilizeArgs,
  buildTranscodeArgs,
} from "./ffmpeg-commands.mjs";
import {
  buildDeterministicRenderArgs,
  createRenderPlan,
} from "./render-plan.mjs";
import { makeMp4FragmentArgs } from "./fragmented-mp4.mjs";
import type {
  ExportSettings,
  RuntimeAsset,
  TextStyle,
  VideoFlowProject,
} from "./types";

export type LocalOutputFormat = "webm" | "mp4" | "gif" | "wav" | "mp3" | "opus";
export type ProxyQuality = "low" | "balanced" | "high";

export interface MediaProbe {
  streams: Array<{
    codec_type?: "video" | "audio" | string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    time_base?: string;
    sample_rate?: string;
    channels?: number;
    channel_layout?: string;
    bit_rate?: string;
    pix_fmt?: string;
    bits_per_raw_sample?: string;
    bits_per_sample?: number;
    color_range?: string;
    color_space?: string;
    color_transfer?: string;
    color_primaries?: string;
  }>;
  format?: {
    duration?: string;
    format_name?: string;
    size?: string;
    bit_rate?: string;
  };
}

export interface TranscodeOptions {
  format: LocalOutputFormat;
  bitrate?: number;
  audioBitrate?: number;
  includeAudio?: boolean;
  gifFps?: number;
  gifWidth?: number;
}

export interface AudioFfmpegOptions {
  start: number;
  end: number;
  speed: number;
  pitchSemitones: number;
  gain: number;
  reverse: boolean;
  normalize: boolean;
  equalizer: number[];
  fadeIn?: number;
  fadeOut?: number;
}

type ProgressCallback = (progress: number, phase: string) => void;

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
const WORKER_FS = "WORKERFS" as FFFSType;
// Small inputs are more reliably probed from MEMFS in all three browser
// engines. Larger media must stay blob-backed so reference workflows never
// copy a multi-gigabyte source into the WebAssembly heap.
const MEMFS_INPUT_LIMIT_BYTES = 64 * 1024 * 1024;

interface StagedInput {
  path: string;
  mountPoint: string | null;
  temporaryFile: string | null;
}

const safeExtension = (name: string) =>
  name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "bin";
const uniqueName = (prefix: string, extension: string) =>
  `${prefix}-${crypto.randomUUID()}.${extension}`;

function queueTask<T>(task: () => Promise<T>): Promise<T> {
  return videoFlowResources.run("ffmpeg", task);
}

export function isLocalFfmpegLoaded(): boolean {
  return Boolean(ffmpeg?.loaded);
}

function getLocalWasmUrl(): string {
  return deploymentAssetUrl("vendor/ffmpeg/ffmpeg-core.wasm");
}

async function getFfmpeg(onProgress?: ProgressCallback): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (!loadPromise) {
    onProgress?.(0.01, "Loading local FFmpeg engine");
    loadPromise = (async () => {
      const ffmpegModule = await import("@ffmpeg/ffmpeg");
      const instance = new ffmpegModule.FFmpeg();
      const base = new URL(deploymentAssetUrl("vendor/ffmpeg/"));
      await instance.load({
        coreURL: new URL("ffmpeg-core.js", base).href,
        wasmURL: getLocalWasmUrl(),
      });
      ffmpeg = instance;
      return instance;
    })().catch((error) => {
      ffmpeg = null;
      loadPromise = null;
      throw new Error(
        `The bundled FFmpeg engine could not initialize: ${String(error)}`,
      );
    });
  }
  return loadPromise;
}

function bytesToBlob(data: Uint8Array | string, mime: string): Blob {
  if (typeof data === "string") return new Blob([data], { type: mime });
  // Avoid an explicit second Uint8Array copy. The FFmpeg MEMFS result still
  // exists in memory until cleanup, so large-output preflight must keep this
  // pathway below the configured browser-risk threshold.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Blob([copy.buffer], { type: mime });
}

async function deleteQuietly(instance: FFmpeg, names: string[]): Promise<void> {
  for (const name of names) await instance.deleteFile(name).catch(() => false);
}

async function mountInput(
  instance: FFmpeg,
  blob: Blob,
  sourceName: string,
  signal?: AbortSignal,
): Promise<StagedInput> {
  const extension = safeExtension(sourceName);
  if (blob.size <= MEMFS_INPUT_LIMIT_BYTES) {
    const temporaryFile = uniqueName("input", extension);
    await instance.writeFile(
      temporaryFile,
      new Uint8Array(await blob.arrayBuffer()),
      signal ? { signal } : undefined,
    );
    return { path: temporaryFile, mountPoint: null, temporaryFile };
  }
  const mountPoint = `/input-${crypto.randomUUID()}`;
  const filename = `source.${extension}`;
  const sourceFile = blob instanceof File && blob.name === filename
    ? blob
    : new File([blob], filename, { type: blob.type });
  await instance.createDir(mountPoint);
  try {
    // `files` is the documented WORKERFS mount form. A File wraps the source
    // Blob without materialising its contents as a Uint8Array.
    await instance.mount(WORKER_FS, { files: [sourceFile] }, mountPoint);
    return {
      path: `${mountPoint}/${filename}`,
      mountPoint,
      temporaryFile: null,
    };
  } catch (error) {
    await instance.deleteDir(mountPoint).catch(() => false);
    throw error;
  }
}

async function cleanupStagedInputs(
  instance: FFmpeg,
  inputs: StagedInput[],
): Promise<void> {
  await deleteQuietly(
    instance,
    inputs.flatMap((input) => input.temporaryFile ? [input.temporaryFile] : []),
  );
  await unmountQuietly(
    instance,
    inputs.flatMap((input) => input.mountPoint ? [input.mountPoint] : []),
  );
}

async function unmountQuietly(instance: FFmpeg, mountPoints: string[]): Promise<void> {
  for (const mountPoint of mountPoints) {
    await instance.unmount(mountPoint).catch(() => false);
    await instance.deleteDir(mountPoint).catch(() => false);
  }
}

async function executeWithInput(
  blob: Blob,
  sourceName: string,
  outputExtension: string,
  outputMime: string,
  buildArgs: (inputName: string, outputName: string) => string[],
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  return queueTask(async () => {
    if (signal.aborted)
      throw new DOMException("Processing cancelled.", "AbortError");
    const instance = await getFfmpeg(onProgress);
    const outputName = uniqueName("output", outputExtension);
    let stagedInput: StagedInput | null = null;
    const logs: string[] = [];
    const progressListener = ({ progress }: { progress: number }) =>
      onProgress?.(
        Math.min(0.98, Math.max(0.02, progress)),
        "Processing with local FFmpeg",
      );
    const logListener = ({ message }: { message: string }) => {
      logs.push(message);
      if (logs.length > 12) logs.shift();
    };
    const abort = () => {
      if (ffmpeg === instance) {
        instance.terminate();
        ffmpeg = null;
        loadPromise = null;
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    instance.on("progress", progressListener);
    instance.on("log", logListener);
    try {
      onProgress?.(0.03, "Preparing local media");
      const mounted = await mountInput(instance, blob, sourceName, signal);
      stagedInput = mounted;
      const exitCode = await instance.exec(
        buildArgs(mounted.path, outputName),
        -1,
        { signal },
      );
      if (signal.aborted)
        throw new DOMException("Processing cancelled.", "AbortError");
      if (exitCode !== 0)
        throw new Error(logs.at(-1) || `FFmpeg exited with code ${exitCode}.`);
      onProgress?.(0.99, "Reading local output");
      const data = await instance.readFile(outputName, undefined, { signal });
      const result = bytesToBlob(data, outputMime);
      if (result.size < 128)
        throw new Error("FFmpeg returned an empty output.");
      onProgress?.(1, "Complete");
      return result;
    } catch (error) {
      if (signal.aborted)
        throw new DOMException("Processing cancelled.", "AbortError");
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      signal.removeEventListener("abort", abort);
      instance.off("progress", progressListener);
      instance.off("log", logListener);
      if (instance.loaded) {
        await deleteQuietly(instance, [outputName]);
        if (stagedInput) await cleanupStagedInputs(instance, [stagedInput]);
      }
    }
  });
}

export async function transcodeMedia(
  blob: Blob,
  sourceName: string,
  options: TranscodeOptions,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const info = FORMAT_INFO[options.format];
  return executeWithInput(
    blob,
    sourceName,
    info.extension,
    info.mime,
    (input, output) => buildTranscodeArgs({ ...options, input, output }),
    signal,
    onProgress,
  );
}

export async function streamCopyMedia(
  blob: Blob,
  sourceName: string,
  format: "mp4" | "webm",
  includeAudio: boolean,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const info = FORMAT_INFO[format];
  return executeWithInput(
    blob,
    sourceName,
    info.extension,
    info.mime,
    (input, output) => [
      "-i", input,
      "-map", "0:v:0",
      ...(includeAudio ? ["-map", "0:a?"] : ["-an"]),
      "-c:v", "copy",
      ...(includeAudio ? ["-c:a", "copy"] : []),
      ...(format === "mp4" ? ["-movflags", "+faststart"] : []),
      output,
    ],
    signal,
    onProgress,
  );
}

export async function createProxy(
  blob: Blob,
  sourceName: string,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
  quality: ProxyQuality = "balanced",
): Promise<Blob> {
  const settings =
    quality === "low"
      ? { width: 640, height: 360, fps: 24, crf: 32 }
      : quality === "high"
        ? { width: 1280, height: 720, fps: 30, crf: 27 }
        : { width: 960, height: 540, fps: 30, crf: 30 };
  return videoFlowResources.run("proxy", () =>
    executeWithInput(
      blob,
      sourceName,
      "mp4",
      "video/mp4",
      (input, output) => buildProxyArgs(input, output, settings),
      signal,
      onProgress,
    ),
  );
}

export async function stabilizeMedia(
  blob: Blob,
  sourceName: string,
  strength: number,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  return executeWithInput(
    blob,
    sourceName,
    "mp4",
    "video/mp4",
    (input, output) =>
      buildStabilizeArgs({ input, output, strength, includeAudio: true }),
    signal,
    onProgress,
  );
}

export async function processAudioWithFfmpeg(
  blob: Blob,
  sourceName: string,
  options: AudioFfmpegOptions,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  return executeWithInput(
    blob,
    sourceName,
    "wav",
    "audio/wav",
    (input, output) => buildAudioProcessArgs({ ...options, input, output }),
    signal,
    onProgress,
  );
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not rasterize text overlay."))),
      "image/png",
    ),
  );
}

function wrapLines(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const paragraphs = text.replace(/[<>]/g, "").slice(0, 2_000).split(/\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    lines.push(line || " ");
  }
  return lines.slice(0, 8);
}

async function makeOverlayBlob(
  plan: ReturnType<typeof createRenderPlan>,
  sourceId: string,
): Promise<Blob> {
  const clip = plan.visualClips.find((entry) => entry.renderAssetId === sourceId);
  if (!clip) throw new Error(`Generated render source ${sourceId} is missing.`);
  const subtitle = clip.sourceKind === "subtitle";
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = subtitle ? Math.max(120, Math.round(plan.height * 0.24)) : plan.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas text rasterization is unavailable.");
  const style: TextStyle = clip.textStyle ?? {
    fontFamily: "system-ui",
    fontWeight: 600,
    italic: false,
    align: "center",
    lineHeight: 1.15,
    letterSpacing: 0,
    strokeColor: "rgba(0,0,0,.78)",
    strokeWidth: subtitle ? 3 : 2,
    shadowColor: "rgba(0,0,0,.45)",
    shadowBlur: subtitle ? 8 : 4,
    backgroundOpacity: subtitle ? 0.74 : 0,
    padding: 18,
  };
  const fontSize = Math.max(
    12,
    Math.min(240, subtitle ? plan.height * 0.044 : (clip.fontSize ?? 52)),
  );
  context.font = `${style.italic ? "italic " : ""}${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
  context.textAlign = style.align;
  context.textBaseline = "middle";
  const lines = wrapLines(context, clip.text ?? clip.name ?? "Text", canvas.width * 0.88);
  const lineHeight = fontSize * style.lineHeight;
  const blockHeight = lines.length * lineHeight + style.padding * 2;
  const widest = Math.max(...lines.map((line) => context.measureText(line).width), 1);
  const blockWidth = Math.min(canvas.width * 0.94, widest + style.padding * 2);
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  if (style.backgroundOpacity > 0 || (clip.background && clip.background !== "transparent")) {
    context.fillStyle =
      clip.background && clip.background !== "transparent"
        ? clip.background
        : `rgba(0,0,0,${style.backgroundOpacity})`;
    context.fillRect(
      centerX - blockWidth / 2,
      centerY - blockHeight / 2,
      blockWidth,
      blockHeight,
    );
  }
  context.shadowColor = style.shadowColor;
  context.shadowBlur = style.shadowBlur;
  context.lineWidth = style.strokeWidth;
  context.strokeStyle = style.strokeColor;
  context.fillStyle = clip.color ?? "#ffffff";
  lines.forEach((line, index) => {
    const y = centerY + (index - (lines.length - 1) / 2) * lineHeight;
    if (style.strokeWidth > 0) context.strokeText(line, centerX, y);
    context.fillText(line, centerX, y);
  });
  return canvasBlob(canvas);
}

async function probeWrittenFile(
  instance: FFmpeg,
  filename: string,
  signal: AbortSignal,
): Promise<MediaProbe> {
  const outputName = uniqueName("render-probe", "json");
  try {
    const exitCode = await instance.ffprobe(
      ["-v", "error", "-i", filename, "-show_streams", "-show_format", "-of", "json", "-o", outputName],
      -1,
      { signal },
    );
    if (exitCode !== 0) throw new Error(`FFmpeg could not inspect ${filename}.`);
    const raw = await instance.readFile(outputName, "utf8", { signal });
    return JSON.parse(
      typeof raw === "string" ? raw : new TextDecoder().decode(raw),
    ) as MediaProbe;
  } finally {
    if (instance.loaded) await instance.deleteFile(outputName).catch(() => false);
  }
}

async function renderTimelineInternal(
  project: VideoFlowProject,
  assets: RuntimeAsset[],
  settings: ExportSettings,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
  options: { fragmentedMp4?: boolean } = {},
): Promise<Blob> {
  const plan = createRenderPlan(project, assets);
  if (plan.duration <= 0) throw new Error("The timeline is empty.");
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const sourceSampleRate = assets.find((asset) => asset.audioInfo?.sampleRate)?.audioInfo?.sampleRate;
  const matchedSampleRate = sourceSampleRate === 44_100 || sourceSampleRate === 48_000 ? sourceSampleRate : 48_000;
  const sourceColorInfo = settings.sourceColorInfo ?? assets.find((asset) => asset.kind === "video" && asset.colorInfo)?.colorInfo;
  const normalizedSettings: ExportSettings = {
    ...settings,
    audioSampleRate: settings.audioSampleRate || matchedSampleRate,
    sourceColorInfo,
    videoCodec: settings.videoCodec ?? (settings.format === "webm" ? "vp9" : "h264"),
    audioCodec: settings.audioCodec ?? (settings.format === "webm" || settings.format === "opus" ? "opus" : "aac"),
    aspectStrategy: settings.aspectStrategy ?? "fit",
  };
  return queueTask(async () => {
    if (signal.aborted) throw new DOMException("Export cancelled.", "AbortError");
    const instance = await getFfmpeg(onProgress);
    const createdFiles: string[] = [];
    const stagedInputs: StagedInput[] = [];
    const inputs: Array<{
      id: string;
      filename: string;
      kind: string;
      hasVideo: boolean;
      hasAudio: boolean;
    }> = [];
    const outputInfo = FORMAT_INFO[settings.format];
    const outputName = uniqueName("timeline", outputInfo.extension);
    const logs: string[] = [];
    const progressListener = ({ progress }: { progress: number }) =>
      onProgress?.(0.16 + Math.max(0, Math.min(1, progress)) * 0.82, options.fragmentedMp4 ? "Encoding bounded MP4 segment" : "Encoding deterministic timeline");
    const logListener = ({ message }: { message: string }) => {
      logs.push(message);
      if (logs.length > 24) logs.shift();
    };
    const abort = () => {
      if (ffmpeg === instance) {
        instance.terminate();
        ffmpeg = null;
        loadPromise = null;
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    instance.on("progress", progressListener);
    instance.on("log", logListener);
    try {
      for (let index = 0; index < plan.sources.length; index += 1) {
        const sourceId = plan.sources[index];
        const generated = sourceId.startsWith("text:") || sourceId.startsWith("subtitle:");
        const asset = generated ? null : assetById.get(sourceId);
        if (!generated && !asset)
          throw new Error(`A timeline source is missing from storage: ${sourceId}`);
        const sourceBlob: Blob | undefined = generated
          ? await makeOverlayBlob(plan, sourceId)
          : asset!.blob;
        if (!sourceBlob) {
          if (!generated) {
            throw new Error(`Original media is offline: ${asset!.name}. Relink the original before final export.`);
          }
          throw new Error(`Generated overlay source is unavailable: ${sourceId}`);
        }
        const kind = generated ? (sourceId.startsWith("text:") ? "text" : "subtitle") : asset!.kind;
        const extension = generated ? "png" : safeExtension(asset!.name);
        onProgress?.(0.03 + (index / Math.max(1, plan.sources.length)) * 0.1, `Preparing source ${index + 1} of ${plan.sources.length}`);
        let filename: string;
        if (generated) {
          filename = uniqueName(`source-${index}`, extension);
          await instance.writeFile(filename, new Uint8Array(await sourceBlob.arrayBuffer()), { signal });
          createdFiles.push(filename);
        } else {
          const mounted = await mountInput(instance, sourceBlob, asset!.name, signal);
          filename = mounted.path;
          stagedInputs.push(mounted);
        }
        if (generated || kind === "image") {
          inputs.push({ id: sourceId, filename, kind, hasVideo: true, hasAudio: false });
        } else {
          const probe = await probeWrittenFile(instance, filename, signal);
          inputs.push({
            id: sourceId,
            filename,
            kind,
            hasVideo: probe.streams.some((stream) => stream.codec_type === "video"),
            hasAudio: probe.streams.some((stream) => stream.codec_type === "audio"),
          });
        }
      }
      const compiled = buildDeterministicRenderArgs({
        plan,
        inputs,
        output: outputName,
        settings: normalizedSettings,
      });
      const args = options.fragmentedMp4
        ? makeMp4FragmentArgs(compiled.args, plan.frameRate, plan.duration)
        : compiled.args;
      if (options.fragmentedMp4 && settings.format !== "mp4") {
        throw new Error("Bounded fragmented rendering currently supports MP4/H.264 exports only.");
      }
      createdFiles.push(outputName);
      onProgress?.(0.15, "Compiling deterministic render graph");
      const exitCode = await instance.exec(args, -1, { signal });
      if (signal.aborted) throw new DOMException("Export cancelled.", "AbortError");
      if (exitCode !== 0)
        throw new Error(logs.at(-1) || `FFmpeg exited with code ${exitCode}.`);
      const data = await instance.readFile(outputName, undefined, { signal });
      const result = bytesToBlob(data, outputInfo.mime);
      if (result.size < 128) throw new Error("FFmpeg returned an empty output.");
      onProgress?.(1, "Timeline encoded");
      return result;
    } catch (error) {
      if (signal.aborted) throw new DOMException("Export cancelled.", "AbortError");
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      signal.removeEventListener("abort", abort);
      instance.off("progress", progressListener);
      instance.off("log", logListener);
      if (instance.loaded) {
        await deleteQuietly(instance, createdFiles);
        await cleanupStagedInputs(instance, stagedInputs);
      }
    }
  });
}


export async function renderTimelineWithFfmpeg(
  project: VideoFlowProject,
  assets: RuntimeAsset[],
  settings: ExportSettings,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  return renderTimelineInternal(project, assets, settings, signal, onProgress);
}

export async function renderTimelineFragmentWithFfmpeg(
  project: VideoFlowProject,
  assets: RuntimeAsset[],
  settings: ExportSettings,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (settings.format !== "mp4") {
    throw new Error("Disk-backed segmented export is currently available for MP4 only.");
  }
  return renderTimelineInternal(project, assets, settings, signal, onProgress, { fragmentedMp4: true });
}

export async function probeMediaBlob(
  blob: Blob,
  sourceName: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<MediaProbe> {
  return queueTask(async () => {
    if (signal.aborted)
      throw new DOMException("Media inspection cancelled.", "AbortError");
    const instance = await getFfmpeg();
    const outputName = uniqueName("probe", "json");
    let stagedInput: StagedInput | null = null;
    const abort = () => {
      if (ffmpeg === instance) {
        instance.terminate();
        ffmpeg = null;
        loadPromise = null;
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const mounted = await mountInput(instance, blob, sourceName, signal);
      stagedInput = mounted;
      const exitCode = await instance.ffprobe(
        [
          "-v",
          "error",
          "-i",
          mounted.path,
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          "-o",
          outputName,
        ],
        -1,
        { signal },
      );
      if (exitCode !== 0)
        throw new Error("FFmpeg could not inspect this media container.");
      const raw = await instance.readFile(outputName, "utf8", { signal });
      return JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      ) as MediaProbe;
    } finally {
      signal.removeEventListener("abort", abort);
      if (instance.loaded) {
        await deleteQuietly(instance, [outputName]);
        if (stagedInput) await cleanupStagedInputs(instance, [stagedInput]);
      }
    }
  });
}

function testWave(): Blob {
  const sampleRate = 8_000;
  const frames = 1_600;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((character, index) =>
      view.setUint8(offset + index, character.charCodeAt(0)),
    );
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let index = 0; index < frames; index += 1)
    view.setInt16(
      44 + index * 2,
      Math.sin((index / sampleRate) * 440 * Math.PI * 2) * 6000,
      true,
    );
  return new Blob([buffer], { type: "audio/wav" });
}

export async function runFfmpegSelfTest(
  onProgress?: ProgressCallback,
): Promise<{ size: number; probe: MediaProbe }> {
  const controller = new AbortController();
  const output = await executeWithInput(
    testWave(),
    "self-test.wav",
    "mp4",
    "video/mp4",
    (input, result) => [
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=160x90:d=0.2:r=10",
      "-i",
      input,
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      result,
    ],
    controller.signal,
    onProgress,
  );
  const probe = await probeMediaBlob(
    output,
    "self-test.mp4",
    controller.signal,
  );
  if (!probe.streams.some((stream) => stream.codec_type === "video"))
    throw new Error("FFmpeg self-test output has no video stream.");
  if (!probe.streams.some((stream) => stream.codec_type === "audio"))
    throw new Error("FFmpeg self-test output has no audio stream.");
  return { size: output.size, probe };
}

export async function encodeImageFramesToMp4(
  frames: Blob[],
  fps: number,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (!frames.length) throw new Error("AI frame encoder received no frames.");
  const lossless = frames.every((frame) => frame.type === "image/png");
  const extension = lossless ? "png" : "jpg";
  return queueTask(async () => {
    const instance = await getFfmpeg(onProgress);
    const prefix = `ai-${crypto.randomUUID()}`;
    const output = `${prefix}-output.mp4`;
    const names: string[] = [];
    const abort = () => {
      if (ffmpeg === instance) {
        instance.terminate();
        ffmpeg = null;
        loadPromise = null;
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (let index = 0; index < frames.length; index += 1) {
        if (signal.aborted) throw new DOMException("AI encoding cancelled.", "AbortError");
        const name = `${prefix}-${String(index).padStart(5, "0")}.${extension}`;
        names.push(name);
        await instance.writeFile(name, new Uint8Array(await frames[index].arrayBuffer()), { signal });
        onProgress?.(0.05 + (index / frames.length) * 0.35, `Staging AI frame ${index + 1}/${frames.length}`);
      }
      const exitCode = await instance.exec([
        "-framerate", String(fps),
        "-i", `${prefix}-%05d.${extension}`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        output,
      ], -1, { signal });
      if (exitCode !== 0) throw new Error(`AI frame encoding failed with FFmpeg exit code ${exitCode}.`);
      const data = await instance.readFile(output, undefined, { signal });
      const blob = bytesToBlob(data, "video/mp4");
      if (blob.size < 1024) throw new Error("AI frame encoder returned an empty MP4.");
      onProgress?.(1, "AI frame sequence encoded");
      return blob;
    } finally {
      signal.removeEventListener("abort", abort);
      if (instance.loaded) await deleteQuietly(instance, [...names, output]);
    }
  });
}

/** @deprecated Use encodeImageFramesToMp4; retained for compatible callers. */
export const encodeJpegFramesToMp4 = encodeImageFramesToMp4;

/**
 * Concatenate already encoded, codec-compatible AI micro-batches. Only the
 * compressed batch outputs are retained; decoded 4K frames are released after
 * every bounded batch.
 */
export async function concatenateMp4Batches(
  batches: Blob[],
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (!batches.length) throw new Error("AI batch concatenation received no segments.");
  if (batches.length === 1) return batches[0];
  return queueTask(async () => {
    const instance = await getFfmpeg(onProgress);
    const prefix = `ai-batches-${crypto.randomUUID()}`;
    const listName = `${prefix}.txt`;
    const output = `${prefix}-output.mp4`;
    const names: string[] = [];
    const abort = () => {
      if (ffmpeg === instance) {
        instance.terminate();
        ffmpeg = null;
        loadPromise = null;
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (let index = 0; index < batches.length; index += 1) {
        if (signal.aborted) throw new DOMException("AI encoding cancelled.", "AbortError");
        const name = `${prefix}-${String(index).padStart(4, "0")}.mp4`;
        names.push(name);
        await instance.writeFile(name, new Uint8Array(await batches[index].arrayBuffer()), { signal });
        onProgress?.((index / batches.length) * 0.35, `Staging AI batch ${index + 1}/${batches.length}`);
      }
      await instance.writeFile(listName, names.map((name) => `file '${name}'`).join("\n"));
      const exitCode = await instance.exec([
        "-f", "concat",
        "-safe", "0",
        "-i", listName,
        "-c", "copy",
        "-movflags", "+faststart",
        output,
      ], -1, { signal });
      if (exitCode !== 0) throw new Error(`AI batch concatenation failed with FFmpeg exit code ${exitCode}.`);
      const data = await instance.readFile(output, undefined, { signal });
      const blob = bytesToBlob(data, "video/mp4");
      if (blob.size < 1024) throw new Error("AI batch concatenation returned an empty MP4.");
      onProgress?.(1, "AI micro-batches joined");
      return blob;
    } finally {
      signal.removeEventListener("abort", abort);
      if (instance.loaded) await deleteQuietly(instance, [...names, listName, output]);
    }
  });
}
