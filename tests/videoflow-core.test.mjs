import assert from "node:assert/strict";
import test from "node:test";

import {
  clipDuration, cuesToSrt, formatTime, interpolateKeyframes, migrateProject,
  normalizeCrop, parseSrt, parseTime, projectDuration, resolveWatermarkMask,
  snapTime, upsertWatermarkKeyframe,
} from "../lib/videoflow/core.mjs";
import {
  REFERENCE_MEDIA_BYTES,
  assessImportStorage,
  mediaRisk,
} from "../lib/videoflow/import-policy.mjs";

test("formats and parses media time deterministically", () => {
  assert.equal(formatTime(3723.456), "01:02:03.456");
  assert.equal(parseTime("01:02:03.456"), 3723.456);
  assert.equal(parseTime("00:00:01,500"), 1.5);
  assert.equal(parseTime("not-time"), null);
});

test("calculates speed-adjusted clip and project durations", () => {
  const clip = { sourceStart: 2, sourceEnd: 12, speed: 2, timelineStart: 3 };
  assert.equal(clipDuration(clip), 5);
  assert.equal(projectDuration({ clips: [clip, { ...clip, timelineStart: 10, speed: 1 }] }), 20);
});

test("snaps only inside the threshold", () => {
  assert.equal(snapTime(4.93, [0, 5, 10], 0.1), 5);
  assert.equal(snapTime(4.8, [5], 0.1), 4.8);
});

test("normalizes crop rectangles inside the frame", () => {
  assert.deepEqual(normalizeCrop({ x: .9, y: -.2, width: .5, height: 2 }), { x: .5, y: 0, width: .5, height: 1 });
});

test("interpolates numeric and object keyframes", () => {
  assert.equal(interpolateKeyframes([{ time: 0, value: 0 }, { time: 10, value: 100 }], 2.5), 25);
  assert.deepEqual(interpolateKeyframes([{ time: 0, value: { x: 0, y: 10 } }, { time: 2, value: { x: 10, y: 20 } }], 1), { x: 5, y: 15 });
});

test("adds and linearly interpolates watermark mask keyframes", () => {
  const mask = { x: .1, y: .2, width: .2, height: .1, keyframes: [] };
  const first = upsertWatermarkKeyframe(mask, 0);
  const second = upsertWatermarkKeyframe(first, 10, { x: .5, y: .6 });
  assert.equal(second.keyframes.length, 2);
  const resolved = resolveWatermarkMask(second, 5);
  assert.ok(Math.abs(resolved.x - .3) < 1e-9);
  assert.ok(Math.abs(resolved.y - .4) < 1e-9);
  assert.equal(resolved.width, .2);
  assert.equal(resolved.height, .1);
});

test("round-trips sanitized subtitle cues", () => {
  const cues = parseSrt("1\n00:00:01,000 --> 00:00:03,500\nHello <b>world</b>");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Hello bworld/b");
  assert.match(cuesToSrt(cues), /00:00:01,000 --> 00:00:03,500/);
});

test("migrates supported backups and rejects future schemas", () => {
  const project = migrateProject({ format: "videoflow-project", project: { id: "p1", schemaVersion: 1 } });
  assert.equal(project.revision, 0);
  assert.equal(project.schemaVersion, 3);
  assert.throws(() => migrateProject({ schemaVersion: 4 }), /newer VideoFlow/);
});

test("keeps very large media session-first without rejecting the source", () => {
  const multiGigabyte = 3 * 1024 * 1024 * 1024;
  assert.equal(mediaRisk(multiGigabyte), "very-large");
  assert.deepEqual(assessImportStorage(multiGigabyte).mode, "session");
  assert.deepEqual(assessImportStorage(REFERENCE_MEDIA_BYTES - 1).mode, "persisted");
});

test("falls back to session media when browser storage lacks headroom", () => {
  const decision = assessImportStorage(80 * 1024 * 1024, {
    quota: 200 * 1024 * 1024,
    usage: 100 * 1024 * 1024,
  });
  assert.equal(decision.mode, "session");
});
