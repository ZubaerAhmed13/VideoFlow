import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeterministicRenderArgs,
  createRenderPlan,
  linearExpression,
} from "../lib/videoflow/render-plan.mjs";

const clip = (id, start) => ({
  id,
  assetId: "asset-1",
  trackId: "v1",
  kind: "video",
  name: id,
  timelineStart: start,
  sourceStart: 0,
  sourceEnd: 2,
  speed: 1,
  gain: 1,
  opacity: 1,
  fadeIn: 0,
  fadeOut: 0,
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
});

const project = {
  id: "p1",
  revision: 2,
  tracks: [
    {
      id: "v1",
      kind: "video",
      index: 1,
      visible: true,
      muted: false,
      solo: false,
      gain: 1,
    },
  ],
  clips: [clip("clip-a", 0), clip("clip-b", 0.5)],
  subtitles: [],
  settings: {
    width: 1280,
    height: 720,
    fps: 30,
    masterGain: 1,
    backgroundColor: "#080a0f",
  },
};

test("compiles piecewise linear property keyframes", () => {
  const expression = linearExpression(
    [
      { property: "x", time: 0, value: 0 },
      { property: "x", time: 2, value: 1 },
    ],
    "x",
    0,
  );
  assert.match(expression, /if\(lt\(t,2\)/);
  assert.match(expression, /\(t-0\)\/2/);
});

test("splits one source for overlapping clips in deterministic graph", () => {
  const plan = createRenderPlan(project, [
    { id: "asset-1", kind: "video" },
  ]);
  const { args, filterComplex } = buildDeterministicRenderArgs({
    plan,
    inputs: [
      {
        id: "asset-1",
        filename: "source.mp4",
        kind: "video",
        hasVideo: true,
        hasAudio: true,
      },
    ],
    output: "output.mp4",
    settings: {
      format: "mp4",
      includeAudio: true,
      audioSampleRate: 48000,
      videoBitrate: 4_000_000,
      audioBitrate: 160_000,
    },
  });
  assert.match(filterComplex, /\[0:v\]split=2/);
  assert.match(filterComplex, /\[0:a\]asplit=2/);
  assert.equal(args.includes("-filter_complex"), true);
  assert.equal(args.includes("libx264"), true);
});

test("mute and solo decisions are compiled into the audio plan", () => {
  const muted = structuredClone(project);
  muted.tracks[0].muted = true;
  assert.equal(createRenderPlan(muted, [{ id: "asset-1", kind: "video" }]).audioClips.length, 0);
  const soloMismatch = structuredClone(project);
  soloMismatch.tracks.push({
    id: "a1",
    kind: "audio",
    index: 0,
    visible: true,
    muted: false,
    solo: true,
    gain: 1,
  });
  assert.equal(createRenderPlan(soloMismatch, [{ id: "asset-1", kind: "video" }]).audioClips.length, 0);
});
