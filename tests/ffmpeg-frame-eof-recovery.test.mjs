import test from "node:test";
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
