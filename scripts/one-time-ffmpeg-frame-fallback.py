from pathlib import Path
import re
import textwrap

ffmpeg_path = Path("lib/videoflow/ffmpeg.ts")
ffmpeg = ffmpeg_path.read_text()
anchor = "export async function transcodeMedia(\n"
if ffmpeg.count(anchor) != 1:
    raise SystemExit(f"Expected one transcodeMedia anchor, found {ffmpeg.count(anchor)}")
if "createFfmpegFrameExtractionSession" in ffmpeg:
    raise SystemExit("FFmpeg frame session already exists; refusing duplicate patch")

frame_session = r'''
export interface FfmpegFrameExtractionSession {
  readonly sourceSize: number;
  capture(timeSeconds: number, signal?: AbortSignal): Promise<Blob>;
  close(): Promise<void>;
}

export async function createFfmpegFrameExtractionSession(
  blob: Blob,
  sourceName: string,
  signal?: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<FfmpegFrameExtractionSession> {
  if (signal?.aborted)
    throw new DOMException("Frame extraction cancelled.", "AbortError");

  let mountedInstance: FFmpeg | null = null;
  let stagedInput: StagedInput | null = null;
  await queueTask(async () => {
    const instance = await getFfmpeg(onProgress, signal);
    onProgress?.(0.03, "Mounting media for local frame decoding");
    const mounted = await mountInput(instance, blob, sourceName, signal);
    mountedInstance = instance;
    stagedInput = mounted;
  });

  if (!mountedInstance || !stagedInput)
    throw new Error("Local FFmpeg frame decoder could not mount the source media.");

  const instance: FFmpeg = mountedInstance;
  const input: StagedInput = stagedInput;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await queueTask(async () => {
      if (instance.loaded) await cleanupStagedInputs(instance, [input]);
    });
  };

  const capture = async (timeSeconds: number, captureSignal?: AbortSignal): Promise<Blob> =>
    queueTask(async () => {
      if (closed) throw new Error("Local FFmpeg frame decoder session is closed.");
      if (captureSignal?.aborted)
        throw new DOMException("Frame extraction cancelled.", "AbortError");
      if (!instance.loaded || ffmpeg !== instance)
        throw new Error("Local FFmpeg frame decoder was reset and must be reopened.");

      const outputName = uniqueName("frame", "png");
      const logs: string[] = [];
      const logListener = ({ message }: { message: string }) => {
        logs.push(message);
        if (logs.length > 12) logs.shift();
      };
      const abort = () => {
        closed = true;
        if (ffmpeg === instance) {
          instance.terminate();
          ffmpeg = null;
          loadPromise = null;
        }
      };
      captureSignal?.addEventListener("abort", abort, { once: true });
      instance.on("log", logListener);
      try {
        const safeTime = Math.max(0, Number.isFinite(timeSeconds) ? timeSeconds : 0);
        onProgress?.(0.15, "Decoding frame with local FFmpeg fallback");
        const exitCode = await instance.exec(
          [
            "-hide_banner",
            "-loglevel", "error",
            "-ss", safeTime.toFixed(6),
            "-i", input.path,
            "-map", "0:v:0",
            "-frames:v", "1",
            "-an",
            "-c:v", "png",
            "-f", "image2",
            outputName,
          ],
          -1,
          captureSignal ? { signal: captureSignal } : undefined,
        );
        if (captureSignal?.aborted)
          throw new DOMException("Frame extraction cancelled.", "AbortError");
        if (exitCode !== 0)
          throw new Error(logs.at(-1) || `FFmpeg frame extraction exited with code ${exitCode}.`);
        const data = await instance.readFile(
          outputName,
          undefined,
          captureSignal ? { signal: captureSignal } : undefined,
        );
        const result = bytesToBlob(data, "image/png");
        if (result.size < 128)
          throw new Error("FFmpeg frame extraction returned an empty image.");
        onProgress?.(1, "Local FFmpeg frame decoded");
        return result;
      } catch (error) {
        if (captureSignal?.aborted)
          throw new DOMException("Frame extraction cancelled.", "AbortError");
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        captureSignal?.removeEventListener("abort", abort);
        instance.off("log", logListener);
        if (instance.loaded) await deleteQuietly(instance, [outputName]);
      }
    });

  return { sourceSize: blob.size, capture, close };
}

'''
ffmpeg = ffmpeg.replace(anchor, textwrap.dedent(frame_session) + anchor, 1)
ffmpeg_path.write_text(ffmpeg)

decoder_path = Path("lib/videoflow/ai/VideoFrameDecoder.ts")
old_decoder = decoder_path.read_text()
required_old = [
    "MEDIA_PASSIVE_DECODE_TIMEOUT_MS = 1_500",
    "primeDecodedFrame",
    "openFrameExtractionVideo",
    "captureVideoFrame",
]
missing = [value for value in required_old if value not in old_decoder]
if missing:
    raise SystemExit(f"Decoder guard failed; missing expected legacy markers: {missing}")

decoder_path.write_text(textwrap.dedent(r'''
import {
  createFfmpegFrameExtractionSession,
  type FfmpegFrameExtractionSession,
} from "../ffmpeg";

const MEDIA_METADATA_TIMEOUT_MS = 8_000;
const MEDIA_PASSIVE_DECODE_TIMEOUT_MS = 1_500;
const MEDIA_PLAY_PRIME_TIMEOUT_MS = 2_500;
const MEDIA_SEEK_PRIME_TIMEOUT_MS = 2_500;
const FRAME_DECODE_TIMEOUT_MS = 8_000;
const FRAME_CAPTURE_RETRIES = 4;
const FRAME_RETRY_DELAY_MS = 80;
const PRIME_SEEK_SECONDS = 1 / 30;

type PhaseCallback = (phase: string) => void;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface FrameExtractionSession {
  nativeVideo: HTMLVideoElement | null;
  ffmpegSession: FfmpegFrameExtractionSession | null;
  sourceBlob?: Blob;
  sourceName: string;
  onPhase?: PhaseCallback;
}

const nativeDecodeFailures = new WeakSet<Blob>();

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("AI job cancelled.", "AbortError");
}

function decodedFrameReady(video: HTMLVideoElement): boolean {
  return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0;
}

function mediaError(video: HTMLVideoElement, fallback: string): Error {
  const code = video.error?.code;
  return new Error(code ? `${fallback} Media error code ${code}.` : fallback);
}

function waitForMediaState(
  video: HTMLVideoElement,
  predicate: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("AI job cancelled.", "AbortError"));
  if (predicate()) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let timer = 0;
    let settled = false;
    const events = ["loadedmetadata", "loadeddata", "canplay", "seeked", "timeupdate", "playing", "durationchange"];
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      for (const event of events) video.removeEventListener(event, onState);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onState = () => { if (predicate()) finish(true); };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(mediaError(video, "Could not decode media for AI frame extraction."));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("AI job cancelled.", "AbortError"));
    };
    for (const event of events) video.addEventListener(event, onState);
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => finish(predicate()), timeoutMs);
    onState();
  });
}

function waitForFramePresentation(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("AI job cancelled.", "AbortError"));
  const frameVideo = video as VideoWithFrameCallback;
  return new Promise((resolve, reject) => {
    let timeout = 0;
    let raf = 0;
    let frameHandle: number | undefined;
    const cleanup = () => {
      if (timeout) window.clearTimeout(timeout);
      if (raf) window.cancelAnimationFrame(raf);
      if (frameHandle !== undefined) frameVideo.cancelVideoFrameCallback?.(frameHandle);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(new DOMException("AI job cancelled.", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(finish, FRAME_RETRY_DELAY_MS * 2);
    if (typeof frameVideo.requestVideoFrameCallback === "function")
      frameHandle = frameVideo.requestVideoFrameCallback(() => finish());
    else raf = window.requestAnimationFrame(() => finish());
  });
}

async function primeDecodedFrame(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  abortIfRequested(signal);
  if (decodedFrameReady(video)) return;
  if (await waitForMediaState(video, () => decodedFrameReady(video), MEDIA_PASSIVE_DECODE_TIMEOUT_MS, signal)) return;

  let decodedByPlayback = false;
  try {
    try { void video.play().catch(() => undefined); } catch { /* Continue to bounded seek priming. */ }
    decodedByPlayback = await waitForMediaState(video, () => decodedFrameReady(video), MEDIA_PLAY_PRIME_TIMEOUT_MS, signal);
  } finally {
    video.pause();
  }
  if (decodedByPlayback) return;

  const durationLimit = Number.isFinite(video.duration) && video.duration > 0
    ? Math.max(0, video.duration - 0.001)
    : 0;
  if (durationLimit > 0) {
    const probeTarget = Math.min(durationLimit, Math.max(PRIME_SEEK_SECONDS, video.currentTime + PRIME_SEEK_SECONDS));
    try { video.currentTime = probeTarget; } catch { /* Bounded state wait below provides final diagnostic. */ }
    if (await waitForMediaState(video, () => decodedFrameReady(video), MEDIA_SEEK_PRIME_TIMEOUT_MS, signal)) return;
  }
  throw new Error("Media metadata loaded, but no decoded video frame became available after passive load, muted playback priming, and seek priming.");
}

function createNativeVideo(sourceUrl: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.controls = false;
  video.tabIndex = -1;
  video.setAttribute("aria-hidden", "true");
  video.style.position = "fixed";
  video.style.left = "-2px";
  video.style.top = "-2px";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  document.body.appendChild(video);
  video.src = sourceUrl;
  return video;
}

function releaseNativeVideo(video: HTMLVideoElement): void {
  try { video.pause(); } catch { /* Best-effort release. */ }
  video.removeAttribute("src");
  try { video.load(); } catch { /* Best-effort release. */ }
  video.remove();
}

async function openNativeVideo(sourceUrl: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  const video = createNativeVideo(sourceUrl);
  try {
    const metadataReady = waitForMediaState(
      video,
      () => video.readyState >= HTMLMediaElement.HAVE_METADATA,
      MEDIA_METADATA_TIMEOUT_MS,
      signal,
    );
    video.load();
    if (!await metadataReady)
      throw new Error("Timed out while opening media metadata for AI frame extraction.");
    await primeDecodedFrame(video, signal);
    return video;
  } catch (error) {
    releaseNativeVideo(video);
    throw error;
  }
}

async function openFfmpegFallback(session: FrameExtractionSession, signal?: AbortSignal): Promise<void> {
  if (session.ffmpegSession) return;
  if (!session.sourceBlob)
    throw new Error("Native frame decoding failed and no local media Blob is available for FFmpeg fallback.");
  session.onPhase?.("Native decoder unavailable; switching to local FFmpeg frame decoder…");
  session.ffmpegSession = await createFfmpegFrameExtractionSession(
    session.sourceBlob,
    session.sourceName,
    signal,
    (_progress, phase) => session.onPhase?.(phase),
  );
}

export async function openFrameExtractionSession(
  sourceUrl: string,
  sourceBlob: Blob | undefined,
  sourceName: string,
  signal?: AbortSignal,
  onPhase?: PhaseCallback,
): Promise<FrameExtractionSession> {
  abortIfRequested(signal);
  const session: FrameExtractionSession = {
    nativeVideo: null,
    ffmpegSession: null,
    sourceBlob,
    sourceName,
    onPhase,
  };

  if (sourceBlob && nativeDecodeFailures.has(sourceBlob)) {
    await openFfmpegFallback(session, signal);
    return session;
  }

  try {
    onPhase?.("Opening and priming native media decoder…");
    session.nativeVideo = await openNativeVideo(sourceUrl, signal);
    return session;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (!sourceBlob) throw error;
    nativeDecodeFailures.add(sourceBlob);
    await openFfmpegFallback(session, signal);
    return session;
  }
}

async function waitForDecodedTarget(video: HTMLVideoElement, target: number, signal?: AbortSignal): Promise<void> {
  abortIfRequested(signal);
  await primeDecodedFrame(video, signal);
  const targetReady = () => decodedFrameReady(video) && Math.abs(video.currentTime - target) <= 0.05;
  if (!targetReady()) {
    video.currentTime = target;
    if (!await waitForMediaState(video, targetReady, FRAME_DECODE_TIMEOUT_MS, signal))
      throw new Error(`Timed out while decoding the selected AI frame at ${target.toFixed(3)} s.`);
  }
  await waitForFramePresentation(video, signal);
}

async function captureNativeFrame(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
  abortIfRequested(signal);
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Math.max(0, time);
  const finalFrame = Math.max(0, duration - 0.001);
  const target = Math.max(0, Math.min(finalFrame, time));
  await waitForDecodedTarget(video, target, signal);

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas frame capture is unavailable.");

  let lastError: unknown;
  for (let attempt = 0; attempt < FRAME_CAPTURE_RETRIES; attempt += 1) {
    abortIfRequested(signal);
    try {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return await createImageBitmap(canvas);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < FRAME_CAPTURE_RETRIES) {
        await waitForFramePresentation(video, signal);
        await new Promise<void>((resolve, reject) => {
          let timer = 0;
          const cleanup = () => {
            if (timer) window.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          };
          const finish = () => { cleanup(); resolve(); };
          const onAbort = () => { cleanup(); reject(new DOMException("AI job cancelled.", "AbortError")); };
          signal?.addEventListener("abort", onAbort, { once: true });
          timer = window.setTimeout(finish, FRAME_RETRY_DELAY_MS);
        });
      }
    }
  }
  throw new Error(`Could not capture the decoded AI frame after ${FRAME_CAPTURE_RETRIES} attempts: ${String(lastError)}`);
}

async function bitmapFromImageBlob(blob: Blob, signal?: AbortSignal): Promise<ImageBitmap> {
  abortIfRequested(signal);
  try {
    return await createImageBitmap(blob);
  } catch (bitmapError) {
    abortIfRequested(signal);
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = "async";
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          image.removeEventListener("load", onLoad);
          image.removeEventListener("error", onError);
          signal?.removeEventListener("abort", onAbort);
        };
        const onLoad = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(bitmapError); };
        const onAbort = () => { cleanup(); reject(new DOMException("AI job cancelled.", "AbortError")); };
        image.addEventListener("load", onLoad, { once: true });
        image.addEventListener("error", onError, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
        image.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas image fallback is unavailable.");
      context.drawImage(image, 0, 0);
      return await createImageBitmap(canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function captureFfmpegFrame(session: FrameExtractionSession, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
  await openFfmpegFallback(session, signal);
  const image = await session.ffmpegSession!.capture(time, signal);
  return bitmapFromImageBlob(image, signal);
}

export async function captureVideoFrame(
  session: FrameExtractionSession,
  time: number,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  abortIfRequested(signal);
  if (session.nativeVideo) {
    try {
      return await captureNativeFrame(session.nativeVideo, time, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (!session.sourceBlob) throw error;
      nativeDecodeFailures.add(session.sourceBlob);
      releaseNativeVideo(session.nativeVideo);
      session.nativeVideo = null;
      session.onPhase?.("Native frame capture failed; switching to local FFmpeg frame decoder…");
    }
  }
  return captureFfmpegFrame(session, time, signal);
}

export async function releaseFrameExtractionSession(session: FrameExtractionSession): Promise<void> {
  if (session.nativeVideo) {
    releaseNativeVideo(session.nativeVideo);
    session.nativeVideo = null;
  }
  const fallback = session.ffmpegSession;
  session.ffmpegSession = null;
  if (fallback) await fallback.close();
}
''').lstrip())

controls_path = Path("components/videoflow/AIWatermarkControls.tsx")
controls = controls_path.read_text()
old_import = 'import { captureVideoFrame, openFrameExtractionVideo, releaseFrameExtractionVideo } from "@/lib/videoflow/ai/VideoFrameDecoder";'
new_import = 'import { captureVideoFrame, openFrameExtractionSession, releaseFrameExtractionSession, type FrameExtractionSession } from "@/lib/videoflow/ai/VideoFrameDecoder";'
if controls.count(old_import) != 1:
    raise SystemExit(f"Expected one legacy decoder import, found {controls.count(old_import)}")
controls = controls.replace(old_import, new_import, 1)

old_var = '    let video: HTMLVideoElement | null = null;'
if controls.count(old_var) != 2:
    raise SystemExit(f"Expected two legacy video session vars, found {controls.count(old_var)}")
controls = controls.replace(old_var, '    let frameSession: FrameExtractionSession | null = null;')

old_open = '''      const extractionVideo = await openFrameExtractionVideo(sourceUrl, controller.signal);
      video = extractionVideo;'''
if controls.count(old_open) != 2:
    raise SystemExit(f"Expected two decoder open blocks, found {controls.count(old_open)}")
new_open = '''      const extractionSession = await openFrameExtractionSession(
        sourceUrl,
        asset.proxyBlob ?? asset.blob,
        asset.proxyBlob ? `videoflow-proxy-${asset.id}.mp4` : asset.name,
        controller.signal,
        setProgress,
      );
      frameSession = extractionSession;'''
controls = controls.replace(old_open, new_open)

capture_token = 'captureVideoFrame(extractionVideo,'
if controls.count(capture_token) != 2:
    raise SystemExit(f"Expected two extractionVideo capture sites, found {controls.count(capture_token)}")
controls = controls.replace(capture_token, 'captureVideoFrame(extractionSession,')

old_cleanup = 'if (video) releaseFrameExtractionVideo(video);'
if controls.count(old_cleanup) != 2:
    raise SystemExit(f"Expected two legacy decoder cleanup sites, found {controls.count(old_cleanup)}")
controls = controls.replace(old_cleanup, 'if (frameSession) await releaseFrameExtractionSession(frameSession);')
if "openFrameExtractionVideo" in controls or "releaseFrameExtractionVideo" in controls or "extractionVideo" in controls:
    raise SystemExit("Legacy decoder API references remain in AI controls")
controls_path.write_text(controls)

test_path = Path("tests/final-browser-regressions.test.mjs")
tests = test_path.read_text()
start = tests.find('  const aiControls = await read("components/videoflow/AIWatermarkControls.tsx");')
end_token = 'assert.doesNotMatch(decoder, /createImageBitmap\\(video\\)/);'
end = tests.find(end_token, start)
if start < 0 or end < 0:
    raise SystemExit("Could not locate decoder regression assertion block")
end += len(end_token)
replacement = r'''  const aiControls = await read("components/videoflow/AIWatermarkControls.tsx");
  assert.match(aiControls, /aria-label="Run AI preview"/);
  assert.equal((aiControls.match(/await openFrameExtractionSession\(/g) ?? []).length, 2);
  assert.equal((aiControls.match(/releaseFrameExtractionSession\(frameSession\)/g) ?? []).length, 2);
  assert.match(aiControls, /asset\.proxyBlob \?\? asset\.blob/);
  assert.match(aiControls, /captureVideoFrame\(extractionSession, sourceTime/);
  const decoder = await read("lib/videoflow/ai/VideoFrameDecoder.ts");
  assert.match(decoder, /MEDIA_METADATA_TIMEOUT_MS = 8_000/);
  assert.match(decoder, /MEDIA_PASSIVE_DECODE_TIMEOUT_MS = 1_500/);
  assert.match(decoder, /MEDIA_PLAY_PRIME_TIMEOUT_MS = 2_500/);
  assert.match(decoder, /MEDIA_SEEK_PRIME_TIMEOUT_MS = 2_500/);
  assert.match(decoder, /FRAME_DECODE_TIMEOUT_MS = 8_000/);
  assert.match(decoder, /FRAME_CAPTURE_RETRIES = 4/);
  assert.match(decoder, /nativeDecodeFailures = new WeakSet<Blob>\(\)/);
  assert.match(decoder, /createFfmpegFrameExtractionSession/);
  assert.match(decoder, /Native decoder unavailable; switching to local FFmpeg frame decoder/);
  assert.match(decoder, /Native frame capture failed; switching to local FFmpeg frame decoder/);
  assert.match(decoder, /document\.body\.appendChild\(video\)/);
  assert.match(decoder, /context\.drawImage\(video, 0, 0, canvas\.width, canvas\.height\)/);
  assert.doesNotMatch(decoder, /createImageBitmap\(video\)/);
  assert.doesNotMatch(decoder, /navigator\.userAgent|\bFirefox\b|\bGecko\b/);
  assert.match(ffmpeg, /export interface FfmpegFrameExtractionSession/);
  assert.match(ffmpeg, /createFfmpegFrameExtractionSession/);
  assert.match(ffmpeg, /MEMFS_INPUT_LIMIT_BYTES = 64 \* 1024 \* 1024/);
  assert.match(ffmpeg, /instance\.mount\(WORKER_FS/);
  assert.match(ffmpeg, /"-ss", safeTime\.toFixed\(6\)/);
  assert.match(ffmpeg, /"-frames:v", "1"/);
  assert.match(ffmpeg, /bytesToBlob\(data, "image\/png"\)/);'''
tests = tests[:start] + replacement + tests[end:]
test_path.write_text(tests)
