import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  combineFragmentedMp4Segments,
  createFragmentedMp4State,
  inspectFragmentedMp4,
  makeMp4FragmentArgs,
  mediaChunksForSegment,
} from "../lib/videoflow/fragmented-mp4.mjs";

const fixture = (index) => readFileSync(new URL(`./fixtures/generated/fragment-seg${index}.mp4`, import.meta.url));

test("fragmented MP4 helper detects init and media fragments", () => {
  const info = inspectFragmentedMp4(fixture(0));
  assert.equal(info.hasInit, true);
  assert.ok(info.fragmentCount >= 1);
  assert.ok(info.mediaDataCount >= 1);
});

test("fragmented MP4 helper patches sequence/timestamps and creates a decodable 6 second file", () => {
  const joined = combineFragmentedMp4Segments([fixture(0), fixture(1), fixture(2)], [0, 2, 4]);
  const dir = mkdtempSync(join(tmpdir(), "videoflow-fmp4-"));
  const output = join(dir, "joined.mp4");
  try {
    writeFileSync(output, joined);
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-show_streams", "-show_format", "-of", "json", output,
    ], { encoding: "utf8" }));
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    assert.ok(video);
    assert.ok(audio);
    assert.ok(Number(probe.format.duration) >= 5.9);
    assert.ok(Number(probe.format.duration) <= 6.2);
    execFileSync("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"], { stdio: "ignore" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("media chunks can be streamed one segment at a time", () => {
  const first = fixture(0);
  const state = createFragmentedMp4State(first);
  const firstChunks = mediaChunksForSegment(first, state, 0);
  const secondChunks = mediaChunksForSegment(fixture(1), state, 2);
  assert.ok(state.initSegment.byteLength > 0);
  assert.ok(firstChunks.length >= 2);
  assert.ok(secondChunks.length >= 2);
  assert.ok(state.nextSequence >= 3);
});

test("fragmented MP4 render arguments replace faststart and force a segment-stable GOP", () => {
  const args = makeMp4FragmentArgs([
    "-i", "in.mp4", "-c:v", "libx264", "-movflags", "+faststart", "-t", "2", "out.mp4",
  ], 30, 2);
  assert.equal(args.at(-1), "out.mp4");
  assert.ok(args.includes("+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset"));
  assert.ok(args.includes("-sc_threshold"));
  assert.equal(args.includes("+faststart"), false);
});
