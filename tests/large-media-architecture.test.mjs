import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GIBIBYTE,
  assessImportStorage,
  assessRenderRisk,
} from "../lib/videoflow/import-policy.mjs";
import { projectForExportRange } from "../lib/videoflow/export-range.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("3 GB sources select reference mode when a persistent handle exists", () => {
  const size = 3 * GIBIBYTE;
  assert.equal(assessImportStorage(size).mode, "session");
  assert.equal(
    assessImportStorage(size, {}, { hasPersistentHandle: true }).mode,
    "reference",
  );
});

test("non-persisted originals are stripped from IndexedDB records while proxies remain eligible", async () => {
  const db = await read("lib/videoflow/db.ts");
  assert.match(db, /if \(stored\.storageMode !== "persisted"\) delete stored\.blob/);
  assert.doesNotMatch(db, /delete stored\.proxyBlob/);
  const app = await read("components/videoflow/VideoFlowApp.tsx");
  assert.match(app, /Proxies are persisted independently from the original source mode/);
  assert.match(app, /await saveAsset\(updated\)/);
});

test("reference reopen keeps offline state and persisted proxy instead of deleting timeline media", async () => {
  const app = await read("components/videoflow/VideoFlowApp.tsx");
  assert.match(app, /reconnectAssetFromHandle/);
  assert.match(app, /offline: !row\.blob/);
  assert.match(app, /proxyUrl: URL\.createObjectURL\(row\.proxyBlob\)/);
  assert.match(app, /Relink offline originals/);
});

test("large output preflight identifies unsafe multi-gigabyte browser output", () => {
  const risk = assessRenderRisk({
    width: 3840,
    height: 2160,
    fps: 30,
    duration: 3600,
    videoBitrate: 20_000_000,
    effectComplexity: 1.5,
    clipCount: 4,
  });
  assert.ok(risk.estimatedBytes > 1.5 * GIBIBYTE);
  assert.equal(risk.level, "very-high");
  assert.ok(risk.segmentSeconds <= 120);
});

test("range export remaps timeline and source offsets deterministically", () => {
  const project = {
    id: "p",
    name: "range",
    settings: { width: 1920, height: 1080, fps: 30 },
    clips: [
      {
        id: "c",
        timelineStart: 10,
        sourceStart: 20,
        sourceEnd: 80,
        speed: 2,
      },
    ],
    subtitles: [{ id: "s", start: 15, end: 17, text: "hello" }],
  };
  const sliced = projectForExportRange(project, 14, 18);
  assert.equal(sliced.clips.length, 1);
  assert.equal(sliced.clips[0].timelineStart, 0);
  assert.equal(sliced.clips[0].sourceStart, 28);
  assert.equal(sliced.clips[0].sourceEnd, 36);
  assert.deepEqual(
    sliced.subtitles.map(({ start, end }) => [start, end]),
    [[1, 3]],
  );
});

test("segmented range export preserves interpolated keyframe and watermark state at boundaries", () => {
  const project = {
    id: "p2",
    name: "animated-range",
    settings: { width: 1920, height: 1080, fps: 30 },
    tracks: [],
    subtitles: [],
    clips: [{
      id: "c2",
      timelineStart: 0,
      sourceStart: 0,
      sourceEnd: 20,
      speed: 1,
      gain: 1,
      opacity: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      keyframes: [
        { id: "x0", property: "x", time: 0, value: 0, easing: "linear" },
        { id: "x10", property: "x", time: 10, value: 1, easing: "linear" },
      ],
      watermarkMasks: [{
        id: "m1", start: 0, end: 20, x: 0.1, y: 0.1, width: 0.2, height: 0.1,
        keyframes: [
          { time: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.1, easing: "linear" },
          { time: 10, x: 0.5, y: 0.3, width: 0.2, height: 0.1, easing: "linear" },
        ],
      }],
    }],
  };
  const sliced = projectForExportRange(project, 5, 8);
  const xFrames = sliced.clips[0].keyframes.filter((entry) => entry.property === "x");
  assert.equal(xFrames[0].time, 0);
  assert.ok(Math.abs(xFrames[0].value - 0.5) < 0.0001);
  assert.equal(xFrames.at(-1).time, 3);
  assert.ok(Math.abs(xFrames.at(-1).value - 0.8) < 0.0001);
  const mask = sliced.clips[0].watermarkMasks[0];
  assert.equal(mask.start, 0);
  assert.equal(mask.end, 3);
  assert.ok(Math.abs(mask.keyframes[0].x - 0.3) < 0.0001);
  assert.ok(Math.abs(mask.keyframes.at(-1).x - 0.42) < 0.0001);
});

test("source contains direct-to-disk segmented export instead of only a giant Blob guard", async () => {
  const source = await read("lib/videoflow/export.ts");
  assert.match(source, /renderDiskBackedMp4/);
  assert.match(source, /createWritable\(\)/);
  assert.match(source, /mediaChunksForSegment/);
  assert.match(source, /Wrote segment/);
  const controls = await read("components/videoflow/ExportControls.tsx");
  assert.match(controls, /Direct-to-disk segmented MP4/);
  assert.match(controls, /pickExportFileHandle/);
});
