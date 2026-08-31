import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const root = process.cwd();
const supplied = process.env.VIDEOFLOW_LARGE_MEDIA_FIXTURE;
if (!supplied) {
  throw new Error(
    "Real large-media certification was not run: set VIDEOFLOW_LARGE_MEDIA_FIXTURE=/absolute/path/to/encoded-video.mp4.",
  );
}

const fixture = isAbsolute(supplied) ? supplied : resolve(root, supplied);
if (!existsSync(fixture)) throw new Error(`Large-media fixture does not exist: ${fixture}`);

const stat = statSync(fixture);
if (!stat.isFile()) throw new Error(`Large-media fixture is not a regular file: ${fixture}`);
const minimumBytes = Number(process.env.VIDEOFLOW_LARGE_MEDIA_MIN_BYTES || 1024 ** 3);
if (stat.size < minimumBytes) {
  throw new Error(`Large-media fixture is ${stat.size} bytes; at least ${minimumBytes} bytes are required.`);
}

// A sparse logical extension is useful for structural coverage, but it is not a
// genuine encoded-media certification. Reject it here when allocation data is
// available; the separate sparse 3 GiB test remains in generate-certification-media.mjs.
const allocatedBytes = typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
if (allocatedBytes < stat.size * 0.9) {
  throw new Error(
    `Large-media fixture is sparse (${allocatedBytes} allocated / ${stat.size} logical bytes); use a genuinely encoded file.`,
  );
}

const probe = JSON.parse(execFileSync("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,avg_frame_rate,duration",
  "-of", "json",
  fixture,
], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));

const video = probe.streams?.find((stream) => stream.codec_type === "video");
if (!video || !Number(video.width) || !Number(video.height)) {
  throw new Error("Large-media fixture does not contain a decodable video stream.");
}
const duration = Number(probe.format?.duration || video.duration || 0);
const minimumSeconds = Number(process.env.VIDEOFLOW_LARGE_MEDIA_MIN_SECONDS || 60);
if (!Number.isFinite(duration) || duration < minimumSeconds) {
  throw new Error(`Large-media fixture duration is ${duration}s; at least ${minimumSeconds}s are required.`);
}

const evidence = {
  certifiedAt: new Date().toISOString(),
  fixture,
  logicalBytes: stat.size,
  allocatedBytes,
  durationSeconds: duration,
  width: Number(video.width),
  height: Number(video.height),
  videoCodec: video.codec_name,
  audio: probe.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  averageFrameRate: video.avg_frame_rate,
  bitRate: Number(probe.format?.bit_rate || 0),
  sparse: false,
};

const evidenceDirectory = join(root, "ci-results");
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(join(evidenceDirectory, "real-large-media-fixture.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
