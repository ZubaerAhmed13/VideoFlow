import assert from "node:assert/strict";
import test from "node:test";

import {
  atempoFilters, buildAudioProcessArgs, buildProxyArgs, buildStabilizeArgs, buildTranscodeArgs,
} from "../lib/videoflow/ffmpeg-commands.mjs";

test("chains pitch-preserving tempo filters across the supported range", () => {
  assert.deepEqual(atempoFilters(.25), ["atempo=0.5", "atempo=0.5"]);
  assert.deepEqual(atempoFilters(4), ["atempo=2", "atempo=2"]);
  assert.deepEqual(atempoFilters(1), ["atempo=1"]);
});

test("builds MP4 stream removal and GIF palette commands", () => {
  const silent = buildTranscodeArgs({ format: "mp4", input: "in.webm", output: "out.mp4", includeAudio: false });
  assert.ok(silent.includes("-an"));
  assert.ok(!silent.includes("0:a?"));
  assert.ok(silent.includes("libx264"));
  const gif = buildTranscodeArgs({ format: "gif", input: "in.webm", output: "out.gif", gifFps: 12, gifWidth: 640 });
  assert.match(gif.join(" "), /palettegen/);
  assert.match(gif.join(" "), /paletteuse/);
});

test("builds proxy, stabilization and independent pitch commands", () => {
  assert.match(buildProxyArgs().join(" "), /960:h=540/);
  assert.match(buildStabilizeArgs({ strength: 16 }).join(" "), /deshake=rx=16:ry=16/);
  const audio = buildAudioProcessArgs({ speed: 1, pitchSemitones: 12, start: 0, end: 2, equalizer: [] });
  assert.match(audio.join(" "), /asetrate=96000/);
  assert.match(audio.join(" "), /atempo=0.5/);
});
