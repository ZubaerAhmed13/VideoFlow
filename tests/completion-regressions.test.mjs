import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildAudioProcessArgs, buildProxyArgs } from "../lib/videoflow/ffmpeg-commands.mjs";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("proxy quality compiler accepts bounded low/balanced/high-sized targets", () => {
  const low = buildProxyArgs("in.mp4", "out.mp4", { width: 640, height: 360, fps: 24, crf: 32 });
  const high = buildProxyArgs("in.mp4", "out.mp4", { width: 1280, height: 720, fps: 30, crf: 27 });
  assert.ok(low.includes("scale=w=640:h=360:force_original_aspect_ratio=decrease,fps=24"));
  assert.ok(high.includes("scale=w=1280:h=720:force_original_aspect_ratio=decrease,fps=30"));
  assert.equal(low[low.indexOf("-crf") + 1], "32");
  assert.equal(high[high.indexOf("-crf") + 1], "27");
});

test("audio compiler includes real fade filters", () => {
  const args = buildAudioProcessArgs({ start: 2, end: 12, speed: 1, fadeIn: 1.25, fadeOut: 2.5 });
  const filter = args[args.indexOf("-af") + 1];
  assert.match(filter, /afade=t=in:st=0:d=1\.25/);
  assert.match(filter, /afade=t=out:st=7\.5:d=2\.5/);
});

test("storage manager exposes proxy, unused-media and reset cleanup operations", async () => {
  const source = await read("lib/videoflow/db.ts");
  assert.match(source, /deleteProjectProxies/);
  assert.match(source, /removeUnusedMedia/);
  assert.match(source, /resetDatabase/);
  assert.match(source, /storageBreakdown/);
});

test("PWA update lifecycle saves the project before SKIP_WAITING", async () => {
  const source = await read("components/videoflow/VideoFlowApp.tsx");
  const saveAt = source.indexOf("await saveProject(safeProject)");
  const skipAt = source.indexOf('postMessage({ type: "SKIP_WAITING" })');
  assert.ok(saveAt >= 0 && skipAt > saveAt);
  assert.match(source, /Restart & Update/);
  assert.match(source, />Later</);
});

test("recorder includes device selection, pause/resume, meter and post-recording workflow", async () => {
  const source = await read("components/videoflow/VideoFlowApp.tsx");
  for (const marker of [
    "enumerateDevices",
    "Default microphone",
    "Default camera",
    "recorder.pause()",
    "recorder.resume()",
    "Recording Complete",
    "Open in Editor",
    "Save Recording",
    "Record Again",
    "vf-audio-meter",
  ]) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("waveform generation uses persisted proxy first and multiple resolutions", async () => {
  const source = await read("components/videoflow/VideoFlowApp.tsx");
  assert.match(source, /selected\.proxyBlob \?\? selected\.blob/);
  assert.match(source, /waveformPyramid\(previewBlob, \[120, 480, 1920\]\)/);
});

test("dashboard quick-tool catalog exposes every required completion workflow", async () => {
  const source = await readFile(new URL("../components/videoflow/VideoFlowApp.tsx", import.meta.url), "utf8");
  for (const label of [
    "Trim & split",
    "Merge clips",
    "Crop & resize",
    "Rotate & flip",
    "Speed",
    "Volume & audio",
    "Add audio",
    "Add image",
    "Text & subtitles",
    "Remove logo",
    "Compress",
    "Extract audio",
    "Remove audio",
  ]) assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /function QuickWorkflowDialog/);
  assert.match(source, /Simplified local workflow/);
  assert.match(source, /onQueue\(quick, makeSettings\(quick\)\)/);
  assert.match(source, /Open in Editor/);
  assert.match(source, /final export uses the deterministic render engine/);
});

test("large-media import exposes explicit reference/session choice and professional export states", async () => {
  const app = await read("components/videoflow/VideoFlowApp.tsx");
  const controls = await read("components/videoflow/ExportControls.tsx");
  const types = await read("lib/videoflow/types.ts");
  for (const marker of ["Large Media Detected", "Session Only", "Reference Original • Recommended", "chooseLargeMediaStorage"]) assert.match(app, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const preset of ["youtube-4k", "youtube-1080", "youtube-720", "youtube-shorts", "instagram-reel", "tiktok", "high-quality", "balanced", "small", "web-optimized", "custom"]) assert.match(controls, new RegExp(preset));
  assert.match(types, /"ai-processing"/);
  assert.match(types, /"muxing"/);
});

test("direct manipulation exposes edge handles, rotation and full crop presets", async () => {
  const app = await read("components/videoflow/VideoFlowApp.tsx");
  const render = await read("lib/videoflow/render.ts");
  assert.match(app, /"rotate" \| "mask"/);
  assert.match(app, /nearEdge/);
  for (const preset of ["16:9", "9:16", "4:3", "3:2", "1:1", "4:5", "21:9"]) assert.match(app, new RegExp(preset.replace(":", "\\:")));
  assert.match(render, /x \+ width \/ 2/);
  assert.match(render, /y \+ height \/ 2/);
});
