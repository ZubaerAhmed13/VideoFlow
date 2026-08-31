import assert from "node:assert/strict";
import test from "node:test";

import {
  calculatePsnr,
  calculateSsim,
  outsideRoiMeanAbsoluteError,
  temporalInstability,
  trackingMetrics,
} from "../lib/videoflow/ai/quality-metrics.mjs";

test("controlled AI quality metrics distinguish exact, close and damaged reconstructions", () => {
  const reference = Uint8Array.from({ length: 256 }, (_, index) => index);
  const close = Uint8Array.from(reference, (value, index) => Math.max(0, Math.min(255, value + (index % 3) - 1)));
  const damaged = Uint8Array.from(reference, (value) => 255 - value);
  assert.equal(calculatePsnr(reference, reference), Number.POSITIVE_INFINITY);
  assert.ok(calculatePsnr(close, reference) > 45);
  assert.ok(calculatePsnr(damaged, reference) < 10);
  assert.ok(calculateSsim(close, reference) > 0.99);
  assert.ok(calculateSsim(damaged, reference) < 0);
});

test("outside-ROI and temporal metrics catch unrelated edits and flicker", () => {
  const reference = new Uint8Array(4 * 4 * 4).fill(100);
  const insideOnly = new Uint8Array(reference);
  for (let y = 1; y < 3; y += 1) for (let x = 1; x < 3; x += 1) insideOnly[(y * 4 + x) * 4] = 220;
  assert.equal(outsideRoiMeanAbsoluteError(insideOnly, reference, 4, 4, { x: 1, y: 1, width: 2, height: 2 }), 0);
  const alteredOutside = new Uint8Array(insideOnly);
  alteredOutside[0] = 180;
  assert.ok(outsideRoiMeanAbsoluteError(alteredOutside, reference, 4, 4, { x: 1, y: 1, width: 2, height: 2 }) > 0);
  assert.equal(temporalInstability([reference, reference, reference]), 0);
  assert.ok(temporalInstability([reference, damagedFrame(reference), reference]) > 0);
});

test("moving-watermark tracking metrics report center error and IoU", () => {
  const expected = [0, 1, 2].map((index) => ({ x: 0.1 + index * 0.05, y: 0.1, width: 0.2, height: 0.1 }));
  const actual = expected.map((box) => ({ ...box, x: box.x + 0.004, y: box.y - 0.003 }));
  const metrics = trackingMetrics(actual, expected);
  assert.ok(metrics.meanCenterError < 0.006);
  assert.ok(metrics.meanIoU > 0.9);
});

function damagedFrame(source) {
  return Uint8Array.from(source, (value, index) => index % 4 === 3 ? value : Math.min(255, value + 30));
}
