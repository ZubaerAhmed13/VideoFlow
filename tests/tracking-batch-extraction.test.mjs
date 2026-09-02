import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Firefox FFmpeg tracking amortizes seeks in bounded full-resolution batches", async () => {
  const ffmpeg = await read("lib/videoflow/ffmpeg.ts");
  const decoder = await read("lib/videoflow/ai/VideoFrameDecoder.ts");
  const controls = await read("components/videoflow/AIWatermarkControls.tsx");

  assert.match(ffmpeg, /captureBatch\(timesSeconds: number\[\]/);
  assert.match(ffmpeg, /const regular = ordered\.length > 2/);
  assert.match(ffmpeg, /setpts=PTS-STARTPTS,fps=fps=/);
  assert.match(ffmpeg, /start_time=0:round=near/);
  assert.match(ffmpeg, /"-start_number", "0"/);
  assert.match(ffmpeg, /FFmpeg tracking batch extraction/);
  assert.match(ffmpeg, /Batch output incomplete; recovering with exact timestamp extraction/);
  assert.match(ffmpeg, /exactCaptureInLane/);
  assert.match(ffmpeg, /const eofBackoffs = \[1 \/ 120, 1 \/ 60, 1 \/ 30, 1 \/ 15, 1 \/ 8\] as const/);
  assert.match(ffmpeg, /if \(!regular\)[\s\S]*exactOrdered\("Decoding exact tracking frame with local FFmpeg"\)/);

  const batchStart = ffmpeg.indexOf("const captureBatch = async");
  const batchEnd = ffmpeg.indexOf("return { sourceSize: blob.size, capture, captureBatch, close }", batchStart);
  assert.ok(batchStart >= 0 && batchEnd > batchStart);
  const batchSource = ffmpeg.slice(batchStart, batchEnd);
  assert.doesNotMatch(batchSource, /\bscale\s*=/, "Tracking batch extraction must not downscale source/proxy frames.");

  assert.match(decoder, /export async function captureVideoFrames/);
  assert.match(decoder, /captureBatch\(times, signal\)/);
  assert.match(decoder, /Local FFmpeg batch decoder state fault; rebuilding decoder session/);

  assert.match(controls, /TRACKING_FFMPEG_MAX_BATCH_SIZE = 4/);
  assert.match(controls, /TRACKING_BATCH_PIXEL_BUDGET = 16_000_000/);
  assert.match(controls, /function trackingFfmpegBatchSize/);
  assert.match(controls, /const sourceTimes = times\.map/);
  assert.match(controls, /sourceTimes\.slice\(batchStart, batchStart \+ trackingBatchSize\)/);
  assert.match(controls, /trackingBatchStart !== batchStart \|\| !trackingBatch\[offset\]/);
  assert.match(controls, /provideTrackingFrame/);
  assert.match(controls, /releaseTrackingBatch\(\)/);
  assert.doesNotMatch(controls, /times\s*=\s*times\.filter|times\.splice/,
    "Tracking optimization must not reduce the scheduled tracking-point density.");
});
