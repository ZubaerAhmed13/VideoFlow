import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("small media uses reliable MEMFS while large media remains blob-backed WORKERFS", async () => {
  const [media, ffmpeg] = await Promise.all([
    read("lib/videoflow/media.ts"),
    read("lib/videoflow/ffmpeg.ts"),
  ]);
  assert.doesNotMatch(media, /1 GB browser safety limit|MAX_FILE_SIZE/);
  assert.match(ffmpeg, /MEMFS_INPUT_LIMIT_BYTES = 64 \* 1024 \* 1024/);
  assert.match(ffmpeg, /blob\.size <= MEMFS_INPUT_LIMIT_BYTES/);
  assert.match(ffmpeg, /WORKERFS/);
  assert.match(ffmpeg, /\{ files: \[sourceFile\] \}/);
  assert.match(ffmpeg, /mountInput\(instance, sourceBlob/);
  assert.match(ffmpeg, /new File\(\[blob\], filename/);
  assert.match(ffmpeg, /without materialising its contents as a Uint8Array/);
});

test("desktop panels and mobile pages each have a valid scroll owner", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /\.vf-app\s*\{[\s\S]*?height:\s*100dvh;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.vf-media-list\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.vf-inspector-scroll\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /@media \(max-width: 780px\)[\s\S]*?\.vf-main\s*\{\s*overflow:\s*visible;/);
  assert.match(css, /@media \(max-width: 780px\)[\s\S]*?\.vf-view\s*\{[\s\S]*?overflow:\s*visible;/);
});
