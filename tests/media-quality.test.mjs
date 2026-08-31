import assert from "node:assert/strict";
import test from "node:test";

import {
  FPS_PRESETS,
  RESOLUTION_PRESETS,
  assessSmartCopy,
  colorMetadataArgs,
  encodingPolicy,
  finalSdrPixelFilter,
  frameRatesMatch,
  parseFrameRate,
  recommendedVideoBitrate,
  videoColorInfoFromStream,
} from "../lib/videoflow/media-quality.mjs";
import { buildDeterministicRenderArgs, createRenderPlan } from "../lib/videoflow/render-plan.mjs";

test("professional resolution presets include horizontal, DCI, vertical and social outputs", () => {
  assert.deepEqual(RESOLUTION_PRESETS["480p"], { width: 854, height: 480 });
  assert.deepEqual(RESOLUTION_PRESETS["1440p"], { width: 2560, height: 1440 });
  assert.deepEqual(RESOLUTION_PRESETS["2k-dci"], { width: 2048, height: 1080 });
  assert.deepEqual(RESOLUTION_PRESETS["4k-uhd"], { width: 3840, height: 2160 });
  assert.deepEqual(RESOLUTION_PRESETS["4k-dci"], { width: 4096, height: 2160 });
  assert.deepEqual(RESOLUTION_PRESETS["vertical-2160"], { width: 2160, height: 3840 });
  assert.deepEqual(RESOLUTION_PRESETS.square, { width: 1080, height: 1080 });
});

test("fractional NTSC rates remain exact rationals and are not rounded", () => {
  assert.equal(FPS_PRESETS["23.976"], 24000 / 1001);
  assert.equal(FPS_PRESETS["29.97"], 30000 / 1001);
  assert.equal(FPS_PRESETS["59.94"], 60000 / 1001);
  assert.equal(parseFrameRate("60000/1001"), 60000 / 1001);
  assert.equal(frameRatesMatch(parseFrameRate("30000/1001"), FPS_PRESETS["29.97"]), true);
  assert.equal(frameRatesMatch(FPS_PRESETS["29.97"], 30), false);
});

test("Rec.709 full and limited range metadata and conversion policy remain distinct", () => {
  const limited = videoColorInfoFromStream({ color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709", color_range: "tv", pix_fmt: "yuv420p" });
  const full = videoColorInfoFromStream({ color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709", color_range: "pc", pix_fmt: "yuvj420p" });
  assert.equal(limited.range, "limited");
  assert.equal(full.range, "full");
  assert.deepEqual(colorMetadataArgs(limited), ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]);
  assert.match(finalSdrPixelFilter(limited), /out_range=tv/);
  assert.match(finalSdrPixelFilter(full), /out_range=pc/);
});

test("HDR is detected and never routed through the SDR colour metadata helper", () => {
  const hdr = videoColorInfoFromStream({ color_primaries: "bt2020", color_transfer: "smpte2084", color_space: "bt2020nc", color_range: "tv", pix_fmt: "yuv420p10le" });
  assert.equal(hdr.hdr, true);
  assert.equal(hdr.bitDepth, 10);
  assert.deepEqual(colorMetadataArgs(hdr), []);
});

test("quality modes map to real codec controls and scale bitrate with pixels and cadence", () => {
  assert.deepEqual(encodingPolicy({ format: "mp4", videoCodec: "h264", qualityMode: "visually-lossless" }), { mode: "crf", crf: 14, preset: "slow" });
  assert.equal(encodingPolicy({ format: "webm", videoCodec: "vp9", qualityMode: "balanced" }).crf, 28);
  assert.ok(recommendedVideoBitrate(3840, 2160, FPS_PRESETS["59.94"], "h264", "high") > recommendedVideoBitrate(1280, 720, 30, "h264", "high") * 6);
});

const project = {
  id: "quality-project", revision: 1, subtitles: [],
  tracks: [{ id: "v", kind: "video", index: 0, visible: true, muted: false, solo: false, gain: 1 }],
  clips: [{
    id: "clip", assetId: "asset", trackId: "v", kind: "video", name: "source", timelineStart: 0,
    sourceStart: 0, sourceEnd: 2, speed: 1, gain: 1, opacity: 1, fadeIn: 0, fadeOut: 0,
    keyframes: [], watermarkMasks: [],
    transform: { x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false, crop: { x: 0, y: 0, width: 1, height: 1 } },
  }],
  settings: { width: 1920, height: 1080, fps: 30000 / 1001, masterGain: 1, backgroundColor: "#000000" },
};
const asset = { id: "asset", name: "source.mp4", kind: "video", signature: "iso-base-media", duration: 2, width: 1920, height: 1080, frameRate: 30000 / 1001, audioInfo: { codec: "aac", sampleRate: 48000, channels: 2 }, blob: new Blob([new Uint8Array(2048)]), offline: false };

test("Smart Copy is limited to an untouched complete compatible source", () => {
  const settings = { qualityMode: "smart-copy", format: "mp4", width: 1920, height: 1080, fps: 30000 / 1001, includeAudio: true };
  assert.equal(assessSmartCopy(project, [asset], settings).eligible, true);
  const changed = structuredClone(project);
  changed.clips[0].transform.crop.width = 0.9;
  assert.equal(assessSmartCopy(changed, [asset], settings).eligible, false);
});

test("deterministic render graph carries Rec.709 range, fractional FPS, CRF and source audio rate", () => {
  const plan = createRenderPlan(project, [asset]);
  const settings = {
    format: "mp4", includeAudio: true, audioSampleRate: 48000, audioBitrate: 320000,
    videoBitrate: 12_000_000, videoCodec: "h264", qualityMode: "high", aspectStrategy: "fit",
    sourceColorInfo: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "limited", hdr: false },
  };
  const compiled = buildDeterministicRenderArgs({ plan, inputs: [{ id: "asset", filename: "source.mp4", kind: "video", hasVideo: true, hasAudio: true }], output: "out.mp4", settings });
  assert.match(compiled.filterComplex, /fps=29\.97003/);
  assert.match(compiled.filterComplex, /out_range=tv/);
  assert.equal(compiled.args[compiled.args.indexOf("-crf") + 1], "18");
  assert.equal(compiled.args[compiled.args.indexOf("-color_range") + 1], "tv");
  assert.equal(compiled.args[compiled.args.indexOf("-ar") + 1], "48000");
});
