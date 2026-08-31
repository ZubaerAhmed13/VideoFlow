import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const directory = join(process.cwd(), "tests", "fixtures", "generated");
mkdirSync(directory, { recursive: true });
const video = join(directory, "overlap-source.mp4");
const videoWebm = join(directory, "overlap-source.webm");
const audio = join(directory, "tone.wav");
const image = join(directory, "overlay.png");
const uhd = join(directory, "uhd-4k-5s.mp4");
if (!existsSync(video)) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=12:d=1.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      video,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}
if (!existsSync(videoWebm)) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", video,
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-crf", "38", "-b:v", "0",
      "-c:a", "libopus", "-b:a", "96k",
      videoWebm,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}

if (!existsSync(audio)) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000:duration=1",
      audio,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}


if (!existsSync(uhd)) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=3840x2160:r=24:d=5",
      "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=48000:duration=5",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", uhd,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}

if (!existsSync(image)) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=royalblue:s=320x180:d=0.1",
      "-frames:v", "1", image,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}


const fragmentFiles = [0, 1, 2].map((index) => join(directory, `fragment-seg${index}.mp4`));
for (const [index, fragment] of fragmentFiles.entries()) {
  if (existsSync(fragment)) continue;
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=s=320x180:r=30:d=2`,
      "-f", "lavfi", "-i", `sine=frequency=${440 + index * 110}:sample_rate=48000:duration=2`,
      "-t", "2",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p",
      "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
      fragment,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}

const aiDir = join(process.cwd(), "tests", "fixtures", "ai");
mkdirSync(aiDir, { recursive: true });
const aiStatic = join(aiDir, "ai-static-watermark-720p.mp4");
const aiStaticWebm = join(aiDir, "ai-static-watermark-720p.webm");
const aiMoving = join(aiDir, "ai-moving-watermark-720p.mp4");
const ai4k = join(aiDir, "ai-watermark-4k-short.mp4");
const aiClean = join(aiDir, "ai-clean-reference.png");

function generate(path, args) {
  if (existsSync(path)) return;
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

generate(aiStatic, ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-vf", "drawbox=x=900:y=50:w=260:h=80:color=white@0.85:t=fill,drawtext=text='VF TEST':x=935:y=72:fontsize=34:fontcolor=black", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
generate(aiStaticWebm, ["-i", aiStatic, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-crf", "38", "-b:v", "0", "-c:a", "libopus", "-b:a", "96k"]);
generate(aiMoving, ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=2", "-vf", "drawbox=x='100+300*t':y='70+80*t':w=220:h=70:color=white@0.85:t=fill,drawtext=text='MOVE':x='125+300*t':y='88+80*t':fontsize=30:fontcolor=black", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p"]);
generate(ai4k, ["-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=24:duration=1", "-vf", "drawbox=x=3150:y=120:w=420:h=130:color=white@0.85:t=fill,drawtext=text='4K TEST':x=3220:y=155:fontsize=54:fontcolor=black", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"]);
generate(aiClean, ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=1:duration=1", "-frames:v", "1"]);

console.log(directory);
