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

function recoverableFfmpegFrameError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /ErrnoError|FS error|filesystem|frame decoder was reset|session is closed/i.test(message);
}

async function captureFfmpegFrame(session: FrameExtractionSession, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
  await openFfmpegFallback(session, signal);
  try {
    const image = await session.ffmpegSession!.capture(time, signal);
    return bitmapFromImageBlob(image, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (!recoverableFfmpegFrameError(error) || !session.sourceBlob) throw error;

    // A persistent ffmpeg.wasm filesystem can occasionally become invalid
    // after many seek/capture cycles. Rebuild the decoder session once from
    // the same Blob/WORKERFS source instead of retrying against corrupt state.
    session.onPhase?.("Local FFmpeg filesystem state fault; rebuilding decoder session…");
    const failedSession = session.ffmpegSession;
    session.ffmpegSession = null;
    await failedSession?.close().catch(() => undefined);
    abortIfRequested(signal);
    await openFfmpegFallback(session, signal);
    const image = await session.ffmpegSession!.capture(time, signal);
    return bitmapFromImageBlob(image, signal);
  }
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
