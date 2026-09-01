const MEDIA_METADATA_TIMEOUT_MS = 8_000;
const MEDIA_PASSIVE_DECODE_TIMEOUT_MS = 1_500;
const MEDIA_PLAY_PRIME_TIMEOUT_MS = 2_500;
const MEDIA_SEEK_PRIME_TIMEOUT_MS = 2_500;
const FRAME_DECODE_TIMEOUT_MS = 8_000;
const FRAME_CAPTURE_RETRIES = 4;
const FRAME_RETRY_DELAY_MS = 80;
const PRIME_SEEK_SECONDS = 1 / 30;

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

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

  if (await waitForMediaState(video, () => decodedFrameReady(video), MEDIA_PASSIVE_DECODE_TIMEOUT_MS, signal))
    return;

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
    try { video.currentTime = probeTarget; } catch { /* The bounded state wait below produces the final diagnostic. */ }
    if (await waitForMediaState(video, () => decodedFrameReady(video), MEDIA_SEEK_PRIME_TIMEOUT_MS, signal))
      return;
  }

  throw new Error("Media metadata loaded, but no decoded video frame became available after passive load, muted playback priming, and seek priming.");
}

export async function openFrameExtractionVideo(sourceUrl: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  abortIfRequested(signal);
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

  try {
    const metadataReady = waitForMediaState(
      video,
      () => video.readyState >= HTMLMediaElement.HAVE_METADATA,
      MEDIA_METADATA_TIMEOUT_MS,
      signal,
    );
    video.src = sourceUrl;
    video.load();
    if (!await metadataReady)
      throw new Error("Timed out while opening media metadata for AI frame extraction.");
    await primeDecodedFrame(video, signal);
    return video;
  } catch (error) {
    releaseFrameExtractionVideo(video);
    throw error;
  }
}

async function waitForDecodedTarget(video: HTMLVideoElement, target: number, signal?: AbortSignal): Promise<void> {
  abortIfRequested(signal);
  await primeDecodedFrame(video, signal);
  const targetReady = () => decodedFrameReady(video) && Math.abs(video.currentTime - target) <= 0.05;
  if (!targetReady()) {
    try { video.currentTime = target; }
    catch (error) { throw error; }
    if (!await waitForMediaState(video, targetReady, FRAME_DECODE_TIMEOUT_MS, signal))
      throw new Error(`Timed out while decoding the selected AI frame at ${target.toFixed(3)} s.`);
  }
  await waitForFramePresentation(video, signal);
}

export async function captureVideoFrame(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
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
          const onAbort = () => {
            cleanup();
            reject(new DOMException("AI job cancelled.", "AbortError"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          timer = window.setTimeout(finish, FRAME_RETRY_DELAY_MS);
        });
      }
    }
  }
  throw new Error(`Could not capture the decoded AI frame after ${FRAME_CAPTURE_RETRIES} attempts: ${String(lastError)}`);
}

export function releaseFrameExtractionVideo(video: HTMLVideoElement): void {
  try { video.pause(); } catch { /* Best-effort release. */ }
  video.removeAttribute("src");
  try { video.load(); } catch { /* Best-effort release. */ }
  video.remove();
}
