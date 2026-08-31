const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export const RESOLUTION_PRESETS = Object.freeze({
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "2k-dci": { width: 2048, height: 1080 },
  "4k-uhd": { width: 3840, height: 2160 },
  "4k-dci": { width: 4096, height: 2160 },
  "vertical-1080": { width: 1080, height: 1920 },
  "vertical-1440": { width: 1440, height: 2560 },
  "vertical-2160": { width: 2160, height: 3840 },
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
});

export const FPS_PRESETS = Object.freeze({
  "23.976": 24000 / 1001,
  "24": 24,
  "25": 25,
  "29.97": 30000 / 1001,
  "30": 30,
  "50": 50,
  "59.94": 60000 / 1001,
  "60": 60,
});

export function parseFrameRate(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

export function frameRatesMatch(actual, expected, tolerance = 0.002) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

function normalizedRange(value) {
  const range = String(value ?? "").toLowerCase();
  if (["tv", "limited", "mpeg"].includes(range)) return "limited";
  if (["pc", "full", "jpeg"].includes(range)) return "full";
  return "unknown";
}

function bitDepthFor(stream) {
  const explicit = Number(stream?.bits_per_raw_sample ?? stream?.bits_per_sample);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const pixelFormat = String(stream?.pix_fmt ?? "").toLowerCase();
  const match = pixelFormat.match(/(?:p|le|be)(9|10|12|14|16)(?:le|be)?$/);
  return match ? Number(match[1]) : pixelFormat ? 8 : undefined;
}

export function videoColorInfoFromStream(stream = {}) {
  const primaries = stream.color_primaries || undefined;
  const transfer = stream.color_transfer || stream.color_trc || undefined;
  const matrix = stream.color_space || stream.colorspace || undefined;
  const range = normalizedRange(stream.color_range);
  const pixelFormat = stream.pix_fmt || undefined;
  const bitDepth = bitDepthFor(stream);
  const normalizedPrimaries = String(primaries ?? "").toLowerCase();
  const normalizedTransfer = String(transfer ?? "").toLowerCase();
  const hdr = normalizedPrimaries.includes("bt2020") &&
    ["smpte2084", "pq", "arib-std-b67", "hlg"].some((value) => normalizedTransfer.includes(value));
  if (!primaries && !transfer && !matrix && range === "unknown" && !pixelFormat && !bitDepth) return undefined;
  return { primaries, transfer, matrix, range, pixelFormat, bitDepth, hdr };
}

export function describeColor(info) {
  if (!info) return "Unknown colour metadata";
  const standard = [info.primaries, info.transfer, info.matrix].filter(Boolean).join(" / ") || "unspecified";
  const range = info.range && info.range !== "unknown" ? `${info.range} range` : "range unknown";
  return `${standard} • ${range}${info.hdr ? " • HDR" : " • SDR/unspecified"}`;
}

export function colorMetadataArgs(info) {
  if (!info || info.hdr) return [];
  const args = [];
  if (info.primaries) args.push("-color_primaries", String(info.primaries));
  if (info.transfer) args.push("-color_trc", String(info.transfer));
  if (info.matrix) args.push("-colorspace", String(info.matrix));
  if (info.range === "limited") args.push("-color_range", "tv");
  if (info.range === "full") args.push("-color_range", "pc");
  return args;
}

export function finalSdrPixelFilter(info) {
  if (!info || info.hdr) return "format=yuv420p";
  const matrix = String(info.matrix ?? info.primaries ?? "").toLowerCase();
  const recognizedMatrix = matrix.includes("709") ? "bt709" : matrix.includes("2020") ? "bt2020" : null;
  const range = info.range === "limited" ? "tv" : info.range === "full" ? "pc" : null;
  if (!recognizedMatrix && !range) return "format=yuv420p";
  return `scale=${recognizedMatrix ? `out_color_matrix=${recognizedMatrix}` : ""}${recognizedMatrix && range ? ":" : ""}${range ? `out_range=${range}` : ""}:flags=lanczos,format=yuv420p`;
}

const H264_CRF = Object.freeze({
  "visually-lossless": 14,
  high: 18,
  balanced: 21,
  smaller: 26,
});

const VP9_CRF = Object.freeze({
  "visually-lossless": 16,
  high: 22,
  balanced: 28,
  smaller: 36,
});

export function recommendedVideoBitrate(width, height, fps, codec = "h264", quality = "high") {
  const bitsPerPixel = {
    "visually-lossless": 0.22,
    high: 0.14,
    balanced: 0.085,
    smaller: 0.045,
    custom: 0.14,
    "smart-copy": 0.14,
  }[quality] ?? 0.14;
  const codecFactor = codec === "vp9" ? 0.72 : 1;
  return Math.round(clamp(width * height * fps * bitsPerPixel * codecFactor, 1_000_000, 140_000_000) / 100_000) * 100_000;
}

export function encodingPolicy(settings) {
  const quality = settings.qualityMode === "smart-copy" ? "high" : settings.qualityMode || "high";
  if (quality === "custom") return { mode: "bitrate", bitrate: settings.videoBitrate };
  if (settings.videoCodec === "vp9" || settings.format === "webm") {
    return { mode: "crf", crf: VP9_CRF[quality] ?? VP9_CRF.high, preset: "good" };
  }
  return { mode: "crf", crf: H264_CRF[quality] ?? H264_CRF.high, preset: quality === "visually-lossless" ? "slow" : "medium" };
}

function identityTransform(transform = {}) {
  const crop = transform.crop ?? {};
  return Math.abs(Number(transform.x ?? 0)) < 1e-6 && Math.abs(Number(transform.y ?? 0)) < 1e-6 &&
    Math.abs(Number(transform.scale ?? 1) - 1) < 1e-6 && Math.abs(Number(transform.rotation ?? 0)) < 1e-6 &&
    !transform.flipX && !transform.flipY && Math.abs(Number(crop.x ?? 0)) < 1e-6 &&
    Math.abs(Number(crop.y ?? 0)) < 1e-6 && Math.abs(Number(crop.width ?? 1) - 1) < 1e-6 &&
    Math.abs(Number(crop.height ?? 1) - 1) < 1e-6;
}

export function assessSmartCopy(project, assets, settings) {
  if (settings.qualityMode !== "smart-copy") return { eligible: false, reason: "Smart Copy is not selected." };
  const visual = project.clips.filter((clip) => clip.kind === "video" || clip.kind === "image" || clip.kind === "text");
  const audio = project.clips.filter((clip) => clip.kind === "audio");
  if (visual.length !== 1 || visual[0].kind !== "video" || audio.length || project.subtitles?.length) return { eligible: false, reason: "The timeline requires composition or audio mixing." };
  const clip = visual[0];
  const asset = assets.find((candidate) => candidate.id === clip.assetId);
  if (!asset?.blob || asset.offline) return { eligible: false, reason: "The original source is not available." };
  const timelineDuration = clip.timelineStart + (clip.sourceEnd - clip.sourceStart) / Math.max(0.01, clip.speed);
  if ((settings.rangeStart ?? 0) > 0.000001 || (settings.rangeEnd ?? timelineDuration) < timelineDuration - 0.000001) return { eligible: false, reason: "A selected range requires a frame-accurate re-encode." };
  if (settings.includeAudio && !asset.audioInfo?.codec) return { eligible: false, reason: "The source has no compatible audio stream to copy." };
  const track = project.tracks.find((candidate) => candidate.id === clip.trackId);
  if (settings.includeAudio && (track?.muted || track?.visible === false || Math.abs(Number(track?.gain ?? 1) - 1) > 1e-6 || Math.abs(Number(clip.gain ?? 1) - 1) > 1e-6)) return { eligible: false, reason: "Audio mute or gain changes require re-encoding." };
  if (!identityTransform(clip.transform) || clip.watermarkMasks?.length || clip.keyframes?.length || clip.fadeIn || clip.fadeOut || clip.opacity !== 1 || clip.speed !== 1) return { eligible: false, reason: "An effect, transform, speed change, or keyframe requires re-encoding." };
  if (Math.abs(clip.timelineStart) > 1e-6 || Math.abs(clip.sourceStart) > 1e-6 || Math.abs(clip.sourceEnd - asset.duration) > 0.04) return { eligible: false, reason: "Only the complete source can be copied without an accurate-trim re-encode." };
  if (settings.width !== asset.width || settings.height !== asset.height) return { eligible: false, reason: "The selected resolution differs from the source." };
  if (asset.frameRate && !frameRatesMatch(settings.fps, asset.frameRate)) return { eligible: false, reason: "The selected frame rate differs from the source." };
  const compatible = settings.format === "mp4" ? asset.signature === "iso-base-media" : settings.format === "webm" ? asset.signature === "webm/matroska" : false;
  if (!compatible) return { eligible: false, reason: "The source streams are not compatible with the selected container." };
  return { eligible: true, reason: "Original compressed video stream can be copied without video re-encoding.", asset, clip };
}
