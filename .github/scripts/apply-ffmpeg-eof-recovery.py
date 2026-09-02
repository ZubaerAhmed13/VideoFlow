from pathlib import Path

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


path = "lib/videoflow/ffmpeg.ts"
text = read(path)
start_marker = "  const close = async (): Promise<void> => {"
end_marker = "  return { sourceSize: blob.size, capture, captureBatch, close };"
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("FFmpeg frame-session structure changed; refusing unguarded EOF migration")
end += len(end_marker)

session_impl = r'''  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await queueTask(async () => {
      if (instance.loaded) await cleanupStagedInputs(instance, [input]);
    });
  };

  const isMissingFrameOutputError = (error: unknown): boolean => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return /ErrnoError|FS error|no such file|empty image|output file|nothing was written|end of file/i.test(message);
  };

  // Seeking exactly to a container duration is outside the presentation range:
  // there is no frame whose timestamp starts at EOF. Try the requested time
  // first, then progressively step back by sub-frame intervals only when FFmpeg
  // produced no image. This mirrors the native decoder's "last decodable frame"
  // behavior without changing resolution, cadence, model input, or source mount.
  const exactCaptureInLane = async (
    timeSeconds: number,
    captureSignal: AbortSignal | undefined,
    logs: string[],
    phase = "Decoding frame with local FFmpeg fallback",
  ): Promise<Blob> => {
    const captureAt = async (seekTime: number): Promise<Blob> => {
      const outputName = uniqueName("frame", "png");
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
          throw new Error(logs.at(-1) || `FFmpeg frame extraction exited with code ${exitCode}.`);
        const data = await instance.readFile(
          outputName,
          undefined,
          captureSignal ? { signal: captureSignal } : undefined,
        );
        const result = bytesToBlob(data, "image/png");
        if (result.size < 128)
          throw new Error("FFmpeg frame extraction returned an empty image.");
        return result;
      } finally {
        if (instance.loaded) await deleteQuietly(instance, [outputName]);
      }
    };

    const safeTime = Math.max(0, Number.isFinite(timeSeconds) ? timeSeconds : 0);
    onProgress?.(0.15, phase);
    try {
      return await captureAt(safeTime);
    } catch (firstError) {
      if (captureSignal?.aborted)
        throw new DOMException("Frame extraction cancelled.", "AbortError");
      if (safeTime <= 0 || !isMissingFrameOutputError(firstError)) throw firstError;

      // The first successful candidate is the closest decodable presentation
      // timestamp to the requested endpoint. The maximum 125 ms backoff is
      // bounded and only reachable when every closer candidate produced no file.
      const eofBackoffs = [1 / 120, 1 / 60, 1 / 30, 1 / 15, 1 / 8] as const;
      let lastError: unknown = firstError;
      for (const backoffSeconds of eofBackoffs) {
        const retryTime = Math.max(0, safeTime - backoffSeconds);
        if (retryTime >= safeTime) continue;
        onProgress?.(
          0.2,
          `Requested timestamp has no presented frame; trying the nearest earlier frame (${Math.round(backoffSeconds * 1000)} ms)`,
        );
        try {
          return await captureAt(retryTime);
        } catch (candidateError) {
          if (captureSignal?.aborted)
            throw new DOMException("Frame extraction cancelled.", "AbortError");
          if (!isMissingFrameOutputError(candidateError)) throw candidateError;
          lastError = candidateError;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
  };

  const capture = async (timeSeconds: number, captureSignal?: AbortSignal): Promise<Blob> =>
    queueTask(async () => {
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
      try {
        const result = await exactCaptureInLane(timeSeconds, captureSignal, logs);
        onProgress?.(1, "Local FFmpeg frame decoded");
        return result;
      } catch (error) {
        if (captureSignal?.aborted)
          throw new DOMException("Frame extraction cancelled.", "AbortError");
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        captureSignal?.removeEventListener("abort", abort);
        instance.off("log", logListener);
      }
    });

  const captureBatch = async (timesSeconds: number[], captureSignal?: AbortSignal): Promise<Blob[]> => {
    if (!timesSeconds.length) return [];
    if (closed) throw new Error("Local FFmpeg frame decoder session is closed.");
    if (captureSignal?.aborted)
      throw new DOMException("Frame extraction cancelled.", "AbortError");

    const ordered = timesSeconds
      .map((time, index) => ({ time: Math.max(0, Number.isFinite(time) ? time : 0), index }))
      .sort((a, b) => a.time - b.time);
    const cadence = ordered.length > 1 ? ordered[1].time - ordered[0].time : 0;
    const tolerance = Math.max(0.002, Math.abs(cadence) * 0.02);
    const regular = ordered.length > 2
      && cadence > 0
      && ordered.slice(2).every((item, index) =>
        Math.abs((item.time - ordered[index + 1].time) - cadence) <= tolerance,
      );

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

      const exactOrdered = async (phase: string): Promise<Blob[]> => {
        const restored = new Array<Blob>(timesSeconds.length);
        for (const item of ordered)
          restored[item.index] = await exactCaptureInLane(item.time, captureSignal, logs, phase);
        return restored;
      };

      // Tiny groups often contain the exact range endpoint; irregular groups
      // have no mathematically safe fps batch representation. Keep both exact,
      // but reuse the same mounted source and one serialized FFmpeg lane.
      if (!regular) {
        try {
          const exact = await exactOrdered("Decoding exact tracking frame with local FFmpeg");
          onProgress?.(1, `Decoded ${exact.length} exact tracking frames`);
          return exact;
        } finally {
          captureSignal?.removeEventListener("abort", abort);
          instance.off("log", logListener);
        }
      }

      const start = ordered[0].time;
      const fps = 1 / cadence;
      const prefix = `tracking-batch-${crypto.randomUUID()}`;
      const pattern = `${prefix}-%05d.png`;
      const outputNames = ordered.map((_item, index) => `${prefix}-${String(index).padStart(5, "0")}.png`);

      try {
        let batchFrames: Blob[] | null = null;
        try {
          onProgress?.(0.15, `Batch decoding ${ordered.length} tracking frames with local FFmpeg`);
          logs.length = 0;
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
        const exactFrames = await exactOrdered("Recovering exact tracking frame with local FFmpeg");
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

  return { sourceSize: blob.size, capture, captureBatch, close };'''

write(path, text[:start] + session_impl + text[end:])

write("tests/ffmpeg-frame-eof-recovery.test.mjs", r'''import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("single and batched FFmpeg frame capture share bounded EOF recovery without media-quality sacrifice", async () => {
  const source = await read("lib/videoflow/ffmpeg.ts");
  assert.match(source, /const exactCaptureInLane = async/);
  assert.match(source, /const isMissingFrameOutputError/);
  assert.match(source, /\[1 \/ 120, 1 \/ 60, 1 \/ 30, 1 \/ 15, 1 \/ 8\] as const/);
  assert.match(source, /await exactCaptureInLane\(timeSeconds, captureSignal, logs\)/);
  assert.match(source, /restored\[item\.index\] = await exactCaptureInLane\(item\.time, captureSignal, logs, phase\)/);
  assert.match(source, /Batch output incomplete; recovering with exact timestamp extraction/);
  assert.match(source, /if \(!regular\)/);
  assert.match(source, /Local FFmpeg frame decoder was reset and must be reopened/);

  const sessionStart = source.indexOf("export async function createFfmpegFrameExtractionSession");
  const sessionEnd = source.indexOf("export async function transcodeMedia", sessionStart);
  const session = source.slice(sessionStart, sessionEnd > sessionStart ? sessionEnd : undefined);
  assert.doesNotMatch(session, /\bscale\s*=/, "Frame fallback must preserve the selected source/proxy resolution.");
  assert.doesNotMatch(session, /mountInput\([^\n]*\)[\s\S]*mountInput\(/,
    "Frame retries must reuse the existing mounted source instead of remounting per attempt.");
});
''')

print("central EOF-aware FFmpeg frame recovery applied")