import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "videoflow-media-quality-"));
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const probe = (file) => JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
const rate = (value) => { const [a, b = "1"] = String(value).split("/").map(Number); return a / b; };
const close = (actual, expected, tolerance = 0.002) => Math.abs(actual - expected) <= tolerance;

const results = { generatedAt: new Date().toISOString(), runner: process.platform, resolutions: {}, frameRates: {}, colour: {}, quality: {}, audio: {}, status: "FAIL" };
try {
  const resolutions = {
    "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080], "1440p": [2560, 1440],
    "2K DCI": [2048, 1080], "4K UHD": [3840, 2160], "4K DCI": [4096, 2160],
  };
  for (const [name, [width, height]] of Object.entries(resolutions)) {
    const output = join(work, `${name.replaceAll(/\W+/g, "-")}.mp4`);
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=24:duration=0.25`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-y", output]);
    const video = probe(output).streams.find((stream) => stream.codec_type === "video");
    assert.equal(video.width, width); assert.equal(video.height, height);
    results.resolutions[name] = { status: "PASS", width, height };
  }

  const frameRates = { "23.976": "24000/1001", "24": "24", "25": "25", "29.97": "30000/1001", "30": "30", "50": "50", "59.94": "60000/1001", "60": "60" };
  for (const [name, fps] of Object.entries(frameRates)) {
    const output = join(work, `fps-${name}.mp4`);
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=${fps}:duration=0.5`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-y", output]);
    const actual = rate(probe(output).streams.find((stream) => stream.codec_type === "video").avg_frame_rate);
    assert.ok(close(actual, rate(fps)), `${name} became ${actual}`);
    results.frameRates[name] = { status: "PASS", expected: rate(fps), actual };
  }

  for (const [name, rangeValue, filterRange] of [["Rec.709 Limited", "tv", "tv"], ["Rec.709 Full", "pc", "pc"]]) {
    const output = join(work, `${name.replaceAll(/\W+/g, "-")}.mp4`);
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=0.5", "-vf", `scale=out_color_matrix=bt709:out_range=${filterRange}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", rangeValue, "-y", output]);
    const video = probe(output).streams.find((stream) => stream.codec_type === "video");
    assert.equal(video.color_primaries, "bt709"); assert.equal(video.color_transfer, "bt709"); assert.equal(video.color_space, "bt709"); assert.equal(video.color_range, rangeValue);
    results.colour[name] = { status: "PASS", primaries: video.color_primaries, transfer: video.color_transfer, matrix: video.color_space, range: video.color_range };
  }

  const reference = join(work, "quality-reference.mkv");
  const encoded = join(work, "quality-high.mp4");
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "gradients=size=640x360:rate=24:duration=1:c0=black:c1=white:c2=red:c3=blue", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-y", reference]);
  const modes = {
    "Visually Lossless": { crf: 14, preset: "slow", minimumPsnr: 31, minimumSsim: 0.98 },
    "High Quality": { crf: 18, preset: "medium", minimumPsnr: 29, minimumSsim: 0.96 },
    Balanced: { crf: 21, preset: "medium", minimumPsnr: 26, minimumSsim: 0.93 },
    "Smaller File": { crf: 26, preset: "medium", minimumPsnr: 23, minimumSsim: 0.88 },
  };
  const modeResults = {};
  for (const [name, policy] of Object.entries(modes)) {
    const output = name === "High Quality" ? encoded : join(work, `quality-${name.replaceAll(/\W+/g, "-")}.mp4`);
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", reference, "-c:v", "libx264", "-preset", policy.preset, "-crf", String(policy.crf), "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-y", output]);
    const metric = spawnSync("ffmpeg", ["-hide_banner", "-i", reference, "-i", output, "-lavfi", "[0:v]split=2[refp][refs];[1:v]split=2[outp][outs];[refp][outp]psnr;[refs][outs]ssim", "-f", "null", "-"], { encoding: "utf8" });
    assert.equal(metric.status, 0, metric.stderr || `${name} quality metric command failed`);
    const metricLog = `${metric.stdout ?? ""}\n${metric.stderr ?? ""}`;
    const psnr = Number(metricLog.match(/average:([0-9.]+)/)?.[1]);
    const ssim = Number(metricLog.match(/All:([0-9.]+)/)?.[1]);
    assert.ok(Number.isFinite(psnr) && psnr >= policy.minimumPsnr, `${name} PSNR ${psnr}`);
    assert.ok(Number.isFinite(ssim) && ssim >= policy.minimumSsim, `${name} SSIM ${ssim}`);
    modeResults[name] = { status: "PASS", codec: `H.264 CRF ${policy.crf} ${policy.preset}`, psnr, ssim };
  }
  const copied = join(work, "smart-copy.mp4");
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", encoded, "-map", "0:v:0", "-c:v", "copy", "-y", copied]);
  const streamHash = (file) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"]).trim();
  assert.equal(streamHash(copied), streamHash(encoded));
  results.quality = { status: "PASS", modes: modeResults, smartCopy: { status: "PASS", videoStreamSha256Identical: true }, note: "Objective metrics supplement, but do not replace, visual review." };

  const av = join(work, "audio-sync.mp4");
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30000/1001:duration=2", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=2", "-filter:a", "pan=stereo|c0=c0|c1=c0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-shortest", "-y", av]);
  const avProbe = probe(av); const video = avProbe.streams.find((stream) => stream.codec_type === "video"); const audio = avProbe.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(Number(audio.sample_rate), 48000); assert.equal(audio.channels, 2);
  const videoDuration = Number(video.duration ?? avProbe.format.duration); const audioDuration = Number(audio.duration ?? avProbe.format.duration);
  assert.ok(Math.abs(videoDuration - audioDuration) <= 0.05);
  results.audio = { status: "PASS", sampleRate: Number(audio.sample_rate), channels: audio.channels, bitrate: Number(audio.bit_rate), durationDeltaSeconds: Math.abs(videoDuration - audioDuration) };
  results.status = "PASS";
} finally {
  mkdirSync(join(root, "ci-results"), { recursive: true });
  writeFileSync(join(root, "ci-results", "media-quality-certification.json"), `${JSON.stringify(results, null, 2)}\n`);
  rmSync(work, { recursive: true, force: true });
}
console.log(`Media quality certification ${results.status}: ${Object.keys(results.resolutions).length} resolutions, ${Object.keys(results.frameRates).length} frame rates, ${Object.keys(results.quality.modes ?? {}).length} encoded quality modes, Smart Copy stream hash ${results.quality.smartCopy?.status}.`);
