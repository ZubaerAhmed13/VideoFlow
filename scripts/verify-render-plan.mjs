import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildDeterministicRenderArgs,
  createRenderPlan,
} from "../lib/videoflow/render-plan.mjs";

const directory = mkdtempSync(join(tmpdir(), "videoflow-render-plan-"));
const source = join(directory, "source.mp4");
const output = join(directory, "output.mp4");

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
};

run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=s=320x180:r=24:d=3",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000:duration=3",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-shortest",
  source,
]);

const baseClip = {
  assetId: "fixture",
  trackId: "v1",
  kind: "video",
  name: "Fixture",
  sourceStart: 0,
  sourceEnd: 2,
  speed: 1,
  gain: 0.7,
  opacity: 1,
  fadeIn: 0.15,
  fadeOut: 0.15,
  keyframes: [],
  transform: {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  },
  watermarkMasks: [],
};
const project = {
  id: "render-verifier",
  revision: 1,
  tracks: [
    {
      id: "v1",
      kind: "video",
      index: 1,
      visible: true,
      muted: false,
      solo: false,
      gain: 0.8,
    },
  ],
  clips: [
    { ...baseClip, id: "clip_a", timelineStart: 0 },
    {
      ...structuredClone(baseClip),
      id: "clip_b",
      timelineStart: 0.5,
      transform: { ...baseClip.transform, x: 0.18, scale: 0.55 },
      keyframes: [
        { id: "x0", property: "x", time: 0.5, value: -0.18, easing: "linear" },
        { id: "x1", property: "x", time: 2.5, value: 0.18, easing: "linear" },
      ],
    },
  ],
  subtitles: [],
  settings: {
    width: 640,
    height: 360,
    fps: 24,
    masterGain: 0.9,
    backgroundColor: "#080a0f",
  },
};
const settings = {
  format: "mp4",
  includeAudio: true,
  audioSampleRate: 48000,
  videoBitrate: 1_800_000,
  audioBitrate: 128_000,
  gifFps: 12,
  gifWidth: 320,
  aspectStrategy: "fit",
};
const plan = createRenderPlan(project, [{ id: "fixture", kind: "video" }]);
const { args, filterComplex } = buildDeterministicRenderArgs({
  plan,
  inputs: [
    {
      id: "fixture",
      filename: source,
      kind: "video",
      hasVideo: true,
      hasAudio: true,
    },
  ],
  output,
  settings,
});
assert.match(filterComplex, /split=2/);
assert.match(filterComplex, /asplit=2/);
run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const probe = JSON.parse(
  run("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    output,
  ]),
);
assert.ok(probe.streams.some((stream) => stream.codec_type === "video"));
assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));
assert.equal(probe.streams.find((stream) => stream.codec_type === "video").width, 640);
assert.ok(readFileSync(output).byteLength > 10_000);
console.log(`Deterministic render verified: ${output}`);
