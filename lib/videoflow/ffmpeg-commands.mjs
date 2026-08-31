const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_FREQUENCIES = [
  60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000,
];

export const FORMAT_INFO = Object.freeze({
  webm: { extension: "webm", mime: "video/webm", kind: "video" },
  mp4: { extension: "mp4", mime: "video/mp4", kind: "video" },
  gif: { extension: "gif", mime: "image/gif", kind: "image" },
  wav: { extension: "wav", mime: "audio/wav", kind: "audio" },
  mp3: { extension: "mp3", mime: "audio/mpeg", kind: "audio" },
  opus: { extension: "opus", mime: "audio/ogg", kind: "audio" },
});

export function atempoFilters(rate) {
  let remaining = clamp(Number(rate) || 1, 0.125, 8);
  const factors = [];
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > 0.0001 || !factors.length)
    factors.push(remaining);
  return factors.map((factor) => `atempo=${Number(factor.toFixed(6))}`);
}

export function buildTranscodeArgs({
  input = "input.webm",
  output,
  format = "mp4",
  bitrate = 7_500_000,
  audioBitrate = 160_000,
  includeAudio = true,
  gifFps = 12,
  gifWidth = 640,
} = {}) {
  const info = FORMAT_INFO[format];
  if (!info) throw new Error(`Unsupported output format: ${format}`);
  const outputName = output ?? `output.${info.extension}`;
  const safeVideoBitrate = Math.round(clamp(bitrate, 500_000, 30_000_000));
  const safeAudioBitrate = Math.round(clamp(audioBitrate, 64_000, 320_000));

  if (format === "mp4") {
    return [
      "-i",
      input,
      "-map",
      "0:v:0",
      ...(includeAudio ? ["-map", "0:a?"] : ["-an"]),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-b:v",
      String(safeVideoBitrate),
      "-maxrate",
      String(Math.round(safeVideoBitrate * 1.25)),
      "-bufsize",
      String(safeVideoBitrate * 2),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      ...(includeAudio
        ? ["-c:a", "aac", "-b:a", String(safeAudioBitrate)]
        : []),
      outputName,
    ];
  }
  if (format === "webm") {
    return [
      "-i",
      input,
      "-map",
      "0:v:0",
      ...(includeAudio ? ["-map", "0:a?"] : ["-an"]),
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      String(safeVideoBitrate),
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      "-pix_fmt",
      "yuv420p",
      ...(includeAudio
        ? ["-c:a", "libopus", "-b:a", String(safeAudioBitrate)]
        : []),
      outputName,
    ];
  }
  if (format === "gif") {
    const fps = Math.round(clamp(gifFps, 4, 30));
    const width = Math.round(clamp(gifWidth, 160, 1280));
    const filter = `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=sierra2_4a`;
    return [
      "-i",
      input,
      "-an",
      "-filter_complex",
      filter,
      "-loop",
      "0",
      outputName,
    ];
  }
  if (format === "wav")
    return [
      "-i",
      input,
      "-vn",
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      outputName,
    ];
  if (format === "mp3")
    return [
      "-i",
      input,
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      String(safeAudioBitrate),
      outputName,
    ];
  return [
    "-i",
    input,
    "-vn",
    "-c:a",
    "libopus",
    "-b:a",
    String(safeAudioBitrate),
    outputName,
  ];
}

export function buildProxyArgs(
  input = "input.mp4",
  output = "proxy.mp4",
  { width = 960, height = 540, fps = 30, crf = 30 } = {},
) {
  const safeWidth = Math.max(320, Math.min(1920, Math.round(width / 2) * 2));
  const safeHeight = Math.max(180, Math.min(1080, Math.round(height / 2) * 2));
  const safeFps = Math.max(12, Math.min(60, Math.round(fps)));
  return [
    "-i",
    input,
    "-map",
    "0:v:0",
    "-vf",
    `scale=w=${safeWidth}:h=${safeHeight}:force_original_aspect_ratio=decrease,fps=${safeFps}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    String(Math.max(18, Math.min(36, Math.round(crf)))),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    output,
  ];
}

export function buildStabilizeArgs({
  input = "input.mp4",
  output = "stabilized.mp4",
  strength = 12,
  includeAudio = true,
} = {}) {
  const radius = Math.round(clamp(strength, 4, 32));
  return [
    "-i",
    input,
    "-map",
    "0:v:0",
    ...(includeAudio ? ["-map", "0:a?"] : ["-an"]),
    "-vf",
    `deshake=rx=${radius}:ry=${radius}:edge=mirror,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    ...(includeAudio ? ["-c:a", "aac", "-b:a", "160000"] : []),
    output,
  ];
}

export function buildAudioProcessArgs({
  input = "input.wav",
  output = "processed.wav",
  start = 0,
  end,
  speed = 1,
  pitchSemitones = 0,
  gain = 1,
  reverse = false,
  normalize = false,
  equalizer = [],
  fadeIn = 0,
  fadeOut = 0,
} = {}) {
  const filters = [
    `atrim=start=${Math.max(0, Number(start) || 0)}${Number.isFinite(end) && end > start ? `:end=${end}` : ""}`,
    "asetpts=N/SR/TB",
  ];
  if (reverse) filters.push("areverse");
  AUDIO_FREQUENCIES.forEach((frequency, index) => {
    const eqGain = clamp(Number(equalizer[index]) || 0, -12, 12);
    if (Math.abs(eqGain) >= 0.01)
      filters.push(`equalizer=f=${frequency}:t=q:w=1:g=${eqGain}`);
  });
  const pitchFactor = Math.pow(
    2,
    clamp(Number(pitchSemitones) || 0, -12, 12) / 12,
  );
  filters.push("aresample=48000");
  if (Math.abs(pitchFactor - 1) > 0.0001) {
    filters.push(
      `asetrate=${Math.round(48000 * pitchFactor)}`,
      "aresample=48000",
    );
  }
  filters.push(
    ...atempoFilters(clamp(Number(speed) || 1, 0.25, 4) / pitchFactor),
  );
  if (Math.abs(gain - 1) > 0.0001)
    filters.push(`volume=${clamp(Number(gain) || 0, 0, 4)}`);
  const sourceDuration = Number.isFinite(end) && end > start ? end - start : 0;
  const outputDuration = sourceDuration > 0 ? sourceDuration / clamp(Number(speed) || 1, 0.25, 4) : 0;
  const safeFadeIn = clamp(Number(fadeIn) || 0, 0, outputDuration || 3600);
  const safeFadeOut = clamp(Number(fadeOut) || 0, 0, outputDuration || 3600);
  if (safeFadeIn > 0) filters.push(`afade=t=in:st=0:d=${safeFadeIn}`);
  if (safeFadeOut > 0 && outputDuration > 0)
    filters.push(`afade=t=out:st=${Math.max(0, outputDuration - safeFadeOut)}:d=${safeFadeOut}`);
  if (normalize) filters.push("dynaudnorm=f=250:g=15");
  return [
    "-i",
    input,
    "-vn",
    "-af",
    filters.join(","),
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    output,
  ];
}
