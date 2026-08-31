import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("large media is mounted into FFmpeg without whole-file memory copies", async () => {
  const [media, ffmpeg] = await Promise.all([
    read("lib/videoflow/media.ts"),
    read("lib/videoflow/ffmpeg.ts"),
  ]);
  assert.doesNotMatch(media, /1 GB browser safety limit|MAX_FILE_SIZE/);
  assert.match(ffmpeg, /WORKERFS/);
  assert.match(ffmpeg, /mountInput\(instance, sourceBlob/);
  assert.equal(
    [...ffmpeg.matchAll(/sourceBlob\.arrayBuffer\(\)/g)].length,
    1,
    "only generated overlays should be copied into FFmpeg memory",
  );
  assert.match(
    ffmpeg,
    /if \(generated\) \{[\s\S]*?sourceBlob\.arrayBuffer\(\)/,
  );
});

test("desktop panels and mobile pages each have a valid scroll owner", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /\.vf-app\s*\{[\s\S]*?height:\s*100dvh;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.vf-media-list\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.vf-inspector-scroll\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /@media \(max-width: 780px\)[\s\S]*?\.vf-main\s*\{\s*overflow:\s*visible;/);
  assert.match(css, /@media \(max-width: 780px\)[\s\S]*?\.vf-view\s*\{[\s\S]*?overflow:\s*visible;/);
});
