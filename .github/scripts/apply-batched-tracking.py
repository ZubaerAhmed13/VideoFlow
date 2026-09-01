from pathlib import Path

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    text = read(path)
    actual = text.count(old)
    if actual != expected:
        raise SystemExit(f"{path}: expected {expected} occurrence(s) of {old!r}, found {actual}")
    write(path, text.replace(old, new))


# ---------------------------------------------------------------------------
# 1. FFmpeg frame extraction: preserve exact source/proxy resolution and the
#    existing sampled cadence, but amortize decoder seek/startup over a bounded
#    four-frame batch. Tiny/end-boundary batches use exact seeks on the same
#    mounted session. Larger regular batches verify every produced image and
#    transactionally fall back to exact extraction if image2 omits a boundary
#    frame. A true FS fault still propagates to the decoder's session rebuild.
# ---------------------------------------------------------------------------
replace(
    "lib/videoflow/ffmpeg.ts",
    '''export interface FfmpegFrameExtractionSession {
  readonly sourceSize: number;
  capture(timeSeconds: number, signal?: AbortSignal): Promise<Blob>;
  close(): Promise<void>;
}''',
    '''export interface FfmpegFrameExtractionSession {
  readonly sourceSize: number;
  capture(timeSeconds: number, signal?: AbortSignal): Promise<Blob>;
  captureBatch(timesSeconds: number[], signal?: AbortSignal): Promise<Blob[]>;
  close(): Promise<void>;
}''',
)

marker = '''
  return { sourceSize: blob.size, capture, close };
}'''
text = read("lib/videoflow/ffmpeg.ts")
if text.count(marker) != 1:
    raise SystemExit("lib/videoflow/ffmpeg.ts: frame-session return marker changed")

batch_impl = r'''

  const captureBatch = async (timesSeconds: number[], captureSignal?: AbortSignal): Promise<Blob[]> => {
    if (!timesSeconds.length) return [];
    if (timesSeconds.length <= 2) {
      // Two-frame groups commonly contain the exact tracking-range endpoint.
      // image2/fps may legally emit only one file when that endpoint is at EOF,
      // so keep these tiny groups exact while still reusing the mounted source.
      const exact: Blob[] = [];
      for (const time of timesSeconds) exact.push(await capture(time, captureSignal));
      return exact;
    }
    if (closed) throw new Error("Local FFmpeg frame decoder session is closed.");
    if (captureSignal?.aborted)
      throw new DOMException("Frame extraction cancelled.", "AbortError");

    const ordered = timesSeconds
      .map((time, index) => ({ time: Math.max(0, Number.isFinite(time) ? time : 0), index }))
      .sort((a, b) => a.time - b.time);
    const cadence = ordered[1].time - ordered[0].time;
    const tolerance = Math.max(0.002, Math.abs(cadence) * 0.02);
    const regular = cadence > 0 && ordered.slice(2).every((item, index) =>
      Math.abs((item.time - ordered[index + 1].time) - cadence) <= tolerance,
    );

    // Irregular timestamp groups retain the original exact-seek semantics.
    if (!regular) {
      const exact: Blob[] = [];
      for (const time of timesSeconds) exact.push(await capture(time, captureSignal));
      return exact;
    }

    return queueTask(async () => {
      if (closed) throw new Error("Local FFmpeg frame decoder session is closed.");
      if (captureSignal?.aborted)
        throw new DOMException("Frame extraction cancelled.", "AbortError");
      if (!instance.loaded || ffmpeg !== instance)
        throw new Error("Local FFmpeg frame decoder was reset and must be reopened.");

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

      const exactCaptureInLane = async (timeSeconds: number): Promise<Blob> => {
        const captureAt = async (seekTime: number): Promise<Blob> => {
          const outputName = uniqueName("tracking-exact", "png");
          logs.length = 0;
          try {
            const exitCode = await instance.exec(
              [
                "-hide_banner",
                "-loglevel", "error",
                "-ss", seekTime.toFixed(6),
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
              throw new Error(logs.at(-1) || `FFmpeg exact tracking extraction exited with code ${exitCode}.`);
            const data = await instance.readFile(
              outputName,
              undefined,
              captureSignal ? { signal: captureSignal } : undefined,
            );
            const frame = bytesToBlob(data, "image/png");
            if (frame.size < 128)
              throw new Error("FFmpeg exact tracking extraction returned an empty image.");
            return frame;
          } finally {
            if (instance.loaded) await deleteQuietly(instance, [outputName]);
          }
        };

        const safeTime = Math.max(0, Number.isFinite(timeSeconds) ? timeSeconds : 0);
        try {
          return await captureAt(safeTime);
        } catch (error) {
          if (captureSignal?.aborted)
            throw new DOMException("Frame extraction cancelled.", "AbortError");
          const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          if (safeTime <= 0 || !/ErrnoError|FS error|empty image|output file|no such file/i.test(message)) throw error;
          // A timeline range may end exactly at media duration, where no frame
          // exists by definition. Native capture already clamps to the last
          // decodable frame; mirror that semantic with one frame-sized retry.
          const previousFrameTime = Math.max(0, safeTime - 1 / 30);
          onProgress?.(0.35, "Tracking endpoint is at media EOF; decoding the last available frame");
          return captureAt(previousFrameTime);
        }
      };

      const start = ordered[0].time;
      const fps = 1 / cadence;
      const prefix = `tracking-batch-${crypto.randomUUID()}`;
      const pattern = `${prefix}-%05d.png`;
      const outputNames = ordered.map((_item, index) => `${prefix}-${String(index).padStart(5, "0")}.png`);

      try {
        let batchFrames: Blob[] | null = null;
        try {
          onProgress?.(0.15, `Batch decoding ${ordered.length} tracking frames with local FFmpeg`);
          const exitCode = await instance.exec(
            [
              "-hide_banner",
              "-loglevel", "error",
              "-ss", start.toFixed(6),
              "-i", input.path,
              "-map", "0:v:0",
              "-vf", `setpts=PTS-STARTPTS,fps=fps=${fps.toFixed(8)}:start_time=0:round=near`,
              "-frames:v", String(ordered.length),
              "-an",
              "-start_number", "0",
              "-c:v", "png",
              "-f", "image2",
              pattern,
            ],
            -1,
            captureSignal ? { signal: captureSignal } : undefined,
          );
          if (captureSignal?.aborted)
            throw new DOMException("Frame extraction cancelled.", "AbortError");
          if (exitCode !== 0)
            throw new Error(logs.at(-1) || `FFmpeg tracking batch extraction exited with code ${exitCode}.`);

          const ascending: Blob[] = [];
          for (const outputName of outputNames) {
            const data = await instance.readFile(
              outputName,
              undefined,
              captureSignal ? { signal: captureSignal } : undefined,
            );
            const frame = bytesToBlob(data, "image/png");
            if (frame.size < 128)
              throw new Error("FFmpeg tracking batch extraction returned an empty image.");
            ascending.push(frame);
          }
          if (ascending.length === ordered.length) batchFrames = ascending;
        } catch (batchError) {
          if (batchError instanceof DOMException && batchError.name === "AbortError") throw batchError;
          // image2/fps can omit a requested boundary output while FFmpeg still
          // exits successfully. Treat the optimized batch as speculative: clean
          // its outputs and retry every timestamp exactly on this same mounted
          // session. If the FS itself is corrupt, exactCaptureInLane fails and
          // the decoder layer rebuilds the whole session once.
          onProgress?.(0.3, "Batch output incomplete; recovering with exact timestamp extraction");
        }

        if (batchFrames) {
          onProgress?.(1, `Decoded ${batchFrames.length} tracking frames in one local FFmpeg pass`);
          const restored = new Array<Blob>(timesSeconds.length);
          for (let index = 0; index < ordered.length; index += 1)
            restored[ordered[index].index] = batchFrames[index];
          return restored;
        }

        await deleteQuietly(instance, outputNames);
        const exactFrames = new Array<Blob>(timesSeconds.length);
        for (const item of ordered)
          exactFrames[item.index] = await exactCaptureInLane(item.time);
        onProgress?.(1, `Decoded ${exactFrames.length} tracking frames with exact local FFmpeg recovery`);
        return exactFrames;
      } catch (error) {
        if (captureSignal?.aborted)
          throw new DOMException("Frame extraction cancelled.", "AbortError");
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        captureSignal?.removeEventListener("abort", abort);
        instance.off("log", logListener);
        if (instance.loaded) await deleteQuietly(instance, outputNames);
      }
    });
  };

  return { sourceSize: blob.size, capture, captureBatch, close };
}'''
write("lib/videoflow/ffmpeg.ts", text.replace(marker, batch_impl))


# ---------------------------------------------------------------------------
# 2. Decoder facade: expose batched frame capture with the same FFmpeg-session
#    recovery semantics as single-frame capture. Native video still uses the
#    established exact-seek path; batching is an optimization only once local
#    FFmpeg fallback is active.
# ---------------------------------------------------------------------------
decoder = read("lib/videoflow/ai/VideoFrameDecoder.ts")
release_marker = '''export async function releaseFrameExtractionSession(session: FrameExtractionSession): Promise<void> {'''
if decoder.count(release_marker) != 1:
    raise SystemExit("VideoFrameDecoder release marker changed")

batch_decoder = r'''export async function captureVideoFrames(
  session: FrameExtractionSession,
  times: number[],
  signal?: AbortSignal,
): Promise<ImageBitmap[]> {
  abortIfRequested(signal);
  if (!times.length) return [];

  // Keep native decoding on its proven exact-seek path. If native capture
  // fails, captureVideoFrame transitions the shared session to FFmpeg and the
  // next requested chunk automatically benefits from batch extraction.
  if (session.nativeVideo) {
    const nativeFrames: ImageBitmap[] = [];
    for (const time of times) nativeFrames.push(await captureVideoFrame(session, time, signal));
    return nativeFrames;
  }

  await openFfmpegFallback(session, signal);
  const decodeBatch = async (): Promise<ImageBitmap[]> => {
    const images = await session.ffmpegSession!.captureBatch(times, signal);
    const frames: ImageBitmap[] = [];
    try {
      for (const image of images) frames.push(await bitmapFromImageBlob(image, signal));
      return frames;
    } catch (error) {
      for (const frame of frames) frame.close();
      throw error;
    }
  };

  try {
    return await decodeBatch();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (!recoverableFfmpegFrameError(error) || !session.sourceBlob) throw error;

    session.onPhase?.("Local FFmpeg batch decoder state fault; rebuilding decoder session…");
    const failedSession = session.ffmpegSession;
    session.ffmpegSession = null;
    await failedSession?.close().catch(() => undefined);
    abortIfRequested(signal);
    await openFfmpegFallback(session, signal);
    return decodeBatch();
  }
}

'''
write("lib/videoflow/ai/VideoFrameDecoder.ts", decoder.replace(release_marker, batch_decoder + release_marker))


# ---------------------------------------------------------------------------
# 3. Tracking UI: prefetch at most four FFmpeg-fallback frames per batch. The
#    tracker still receives every scheduled timestamp and operates at the same
#    decoded source/proxy resolution. Unconsumed frames are explicitly closed.
# ---------------------------------------------------------------------------
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    'import { captureVideoFrame, openFrameExtractionSession, releaseFrameExtractionSession, type FrameExtractionSession } from "@/lib/videoflow/ai/VideoFrameDecoder";',
    'import { captureVideoFrame, captureVideoFrames, openFrameExtractionSession, releaseFrameExtractionSession, type FrameExtractionSession } from "@/lib/videoflow/ai/VideoFrameDecoder";',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    'type StillPreview = { before: string; after: string };',
    'type StillPreview = { before: string; after: string };\nconst TRACKING_FFMPEG_BATCH_SIZE = 4;',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    '''    let frameSession: FrameExtractionSession | null = null;
    try {
      setProgress("Opening and priming local media decoder for tracking…");''',
    '''    let frameSession: FrameExtractionSession | null = null;
    let trackingBatchStart = -1;
    let trackingBatch: Array<ImageBitmap | null> = [];
    const releaseTrackingBatch = () => {
      for (const frame of trackingBatch) frame?.close();
      trackingBatch = [];
      trackingBatchStart = -1;
    };
    try {
      setProgress("Opening and priming local media decoder for tracking…");''',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    '''      if (Math.abs(times.at(-1)! - (mode === "backward" ? start : end)) > 0.001) times.push(mode === "backward" ? start : end);
      const resolved = resolveWatermarkMask(mask, anchor) as WatermarkMask;''',
    '''      if (Math.abs(times.at(-1)! - (mode === "backward" ? start : end)) > 0.001) times.push(mode === "backward" ? start : end);
      const sourceTimes = times.map((timelineTime) =>
        clip.sourceStart + Math.max(0, timelineTime - clip.timelineStart) * clip.speed,
      );
      const provideTrackingFrame = async (timelineTime: number, index: number): Promise<ImageBitmap> => {
        const sourceTime = sourceTimes[index]
          ?? clip.sourceStart + Math.max(0, timelineTime - clip.timelineStart) * clip.speed;
        if (!extractionSession.ffmpegSession) {
          return captureVideoFrame(extractionSession, sourceTime, controller.signal);
        }

        const batchStart = Math.floor(index / TRACKING_FFMPEG_BATCH_SIZE) * TRACKING_FFMPEG_BATCH_SIZE;
        if (trackingBatchStart != batchStart) {
          releaseTrackingBatch();
          const batchTimes = sourceTimes.slice(batchStart, batchStart + TRACKING_FFMPEG_BATCH_SIZE);
          trackingBatch = (await captureVideoFrames(extractionSession, batchTimes, controller.signal))
            .map((frame) => frame as ImageBitmap | null);
          trackingBatchStart = batchStart;
        }
        const offset = index - trackingBatchStart;
        const frame = trackingBatch[offset];
        if (!frame) throw new Error(`Tracking frame ${index + 1} is unavailable after local batch decode.`);
        trackingBatch[offset] = null;
        return frame;
      };
      const resolved = resolveWatermarkMask(mask, anchor) as WatermarkMask;''',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    '''        async (timelineTime) => captureVideoFrame(extractionSession, clip.sourceStart + Math.max(0, timelineTime - clip.timelineStart) * clip.speed, controller.signal),''',
    '''        provideTrackingFrame,''',
)
replace(
    "components/videoflow/AIWatermarkControls.tsx",
    '''    } finally { if (jobController.current === controller) jobController.current = null; setBusy(false); if (frameSession) await releaseFrameExtractionSession(frameSession); }
  };''',
    '''    } finally {
      releaseTrackingBatch();
      if (jobController.current === controller) jobController.current = null;
      setBusy(false);
      if (frameSession) await releaseFrameExtractionSession(frameSession);
    }
  };''',
)


# ---------------------------------------------------------------------------
# 4. Regression coverage: no resolution sacrifice, no point-density sacrifice,
#    bounded four-frame memory window, irregular timestamps preserve exact-seek,
#    and incomplete image2 batches recover transactionally on the same mount.
# ---------------------------------------------------------------------------
write("tests/tracking-batch-extraction.test.mjs", r'''import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Firefox FFmpeg tracking amortizes seeks in bounded full-resolution batches", async () => {
  const ffmpeg = await read("lib/videoflow/ffmpeg.ts");
  const decoder = await read("lib/videoflow/ai/VideoFrameDecoder.ts");
  const controls = await read("components/videoflow/AIWatermarkControls.tsx");

  assert.match(ffmpeg, /captureBatch\(timesSeconds: number\[\]/);
  assert.match(ffmpeg, /timesSeconds\.length <= 2/);
  assert.match(ffmpeg, /setpts=PTS-STARTPTS,fps=fps=/);
  assert.match(ffmpeg, /start_time=0:round=near/);
  assert.match(ffmpeg, /"-start_number", "0"/);
  assert.match(ffmpeg, /FFmpeg tracking batch extraction/);
  assert.match(ffmpeg, /Batch output incomplete; recovering with exact timestamp extraction/);
  assert.match(ffmpeg, /exactCaptureInLane/);
  assert.match(ffmpeg, /safeTime - 1 \/ 30/);
  assert.match(ffmpeg, /if \(!regular\)[\s\S]*exact\.push\(await capture\(time, captureSignal\)\)/);

  const batchStart = ffmpeg.indexOf("const captureBatch = async");
  const batchEnd = ffmpeg.indexOf("return { sourceSize: blob.size, capture, captureBatch, close }", batchStart);
  assert.ok(batchStart >= 0 && batchEnd > batchStart);
  const batchSource = ffmpeg.slice(batchStart, batchEnd);
  assert.doesNotMatch(batchSource, /\bscale\s*=/, "Tracking batch extraction must not downscale source/proxy frames.");

  assert.match(decoder, /export async function captureVideoFrames/);
  assert.match(decoder, /captureBatch\(times, signal\)/);
  assert.match(decoder, /Local FFmpeg batch decoder state fault; rebuilding decoder session/);

  assert.match(controls, /TRACKING_FFMPEG_BATCH_SIZE = 4/);
  assert.match(controls, /const sourceTimes = times\.map/);
  assert.match(controls, /sourceTimes\.slice\(batchStart, batchStart \+ TRACKING_FFMPEG_BATCH_SIZE\)/);
  assert.match(controls, /provideTrackingFrame/);
  assert.match(controls, /releaseTrackingBatch\(\)/);
  assert.doesNotMatch(controls, /times\s*=\s*times\.filter|times\.splice/,
    "Tracking optimization must not reduce the scheduled tracking-point density.");
});
''')

print("bounded FFmpeg tracking batch migration applied")