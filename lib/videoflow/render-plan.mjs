import { colorMetadataArgs, encodingPolicy, finalSdrPixelFilter } from "./media-quality.mjs";

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));

export const RENDER_PLAN_VERSION = 1;

export function linearExpression(keyframes, property, fallback, timeVariable = "t") {
  const points = (keyframes ?? [])
    .filter((entry) => entry.property === property && Number.isFinite(entry.value))
    .sort((a, b) => a.time - b.time);
  if (!points.length) return String(round(fallback));
  if (points.length === 1) return String(round(points[0].value));
  let expression = String(round(points.at(-1).value));
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const left = points[index];
    const right = points[index + 1];
    const span = Math.max(0.000001, right.time - left.time);
    const segment = `${round(left.value)}+(${round(right.value - left.value)})*(${timeVariable}-${round(left.time)})/${round(span)}`;
    expression = `if(lt(${timeVariable},${round(right.time)}),${segment},${expression})`;
  }
  return `if(lt(${timeVariable},${round(points[0].time)}),${round(points[0].value)},${expression})`;
}

function clipDuration(clip) {
  return Math.max(0, (clip.sourceEnd - clip.sourceStart) / Math.max(0.01, clip.speed));
}

function trackAudible(tracks, track) {
  if (!track || track.muted || !track.visible) return false;
  const soloed = tracks.filter(
    (entry) => (entry.kind === "audio" || entry.kind === "video") && entry.solo,
  );
  return !soloed.length || Boolean(track.solo);
}

export function createRenderPlan(project, assets = []) {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const trackById = new Map(project.tracks.map((track) => [track.id, track]));
  const duration = Math.max(
    project.clips.reduce(
      (maximum, clip) => Math.max(maximum, clip.timelineStart + clipDuration(clip)),
      0,
    ),
    ...(project.subtitles ?? []).map((cue) => cue.end),
  );
  const visualClips = [];
  const audioClips = [];
  for (const clip of project.clips) {
    const track = trackById.get(clip.trackId);
    if (!track || !track.visible) continue;
    const normalized = {
      ...structuredClone(clip),
      duration: clipDuration(clip),
      trackGain: clamp(track.gain ?? 1, 0, 4),
      zIndex:
        clip.kind === "text"
          ? 10_000 + track.index
          : clip.kind === "audio"
            ? -1
            : track.index,
    };
    if (clip.kind === "text") {
      visualClips.push({
        ...normalized,
        renderAssetId: `text:${clip.id}`,
        sourceKind: "text",
      });
      continue;
    }
    const asset = clip.assetId ? assetById.get(clip.assetId) : null;
    if (!asset) continue;
    if (asset.kind === "video" || asset.kind === "image") {
      visualClips.push({
        ...normalized,
        renderAssetId: asset.id,
        sourceKind: asset.kind,
      });
    }
    if (
      (asset.kind === "video" || asset.kind === "audio") &&
      trackAudible(project.tracks, track)
    ) {
      audioClips.push({
        ...normalized,
        renderAssetId: asset.id,
        sourceKind: asset.kind,
      });
    }
  }
  for (const cue of project.subtitles ?? []) {
    visualClips.push({
      id: cue.id,
      kind: "subtitle",
      name: "Subtitle",
      text: cue.text,
      sourceKind: "subtitle",
      renderAssetId: `subtitle:${cue.id}`,
      timelineStart: cue.start,
      sourceStart: 0,
      sourceEnd: cue.end - cue.start,
      speed: 1,
      duration: cue.end - cue.start,
      gain: 1,
      opacity: 1,
      fadeIn: 0,
      fadeOut: 0,
      keyframes: [],
      transform: {
        x: 0,
        y: 0.38,
        scale: 1,
        rotation: 0,
        flipX: false,
        flipY: false,
        crop: { x: 0, y: 0, width: 1, height: 1 },
      },
      watermarkMasks: [],
      zIndex: 20_000,
    });
  }
  visualClips.sort((a, b) => a.zIndex - b.zIndex || a.timelineStart - b.timelineStart);
  return {
    version: RENDER_PLAN_VERSION,
    projectId: project.id,
    revision: project.revision,
    duration: round(duration),
    width: Math.max(2, Math.round(project.settings.width / 2) * 2),
    height: Math.max(2, Math.round(project.settings.height / 2) * 2),
    frameRate: clamp(project.settings.fps, 1, 60),
    backgroundColor: project.settings.backgroundColor ?? "#080a0f",
    masterGain: clamp(project.settings.masterGain ?? 1, 0, 4),
    sources: [...new Set([...visualClips, ...audioClips].map((clip) => clip.renderAssetId))],
    visualClips,
    audioClips,
  };
}

function maskExpression(mask, property, fallback) {
  const keyframes = (mask.keyframes ?? []).map((entry) => ({
    property,
    time: entry.time,
    value: entry[property],
  }));
  return linearExpression(keyframes, property, fallback);
}

function visualFilters(clip, inputLabel, plan, inputHasVideo, settings) {
  if (!inputHasVideo) return null;
  const localTime = `(t+${round(clip.timelineStart)})`;
  const crop = clip.transform.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const filters = [];
  if (clip.sourceKind === "video") {
    filters.push(
      `trim=start=${round(clip.sourceStart)}:end=${round(clip.sourceEnd)}`,
      `setpts=(PTS-STARTPTS)/${round(Math.max(0.01, clip.speed))}`,
    );
  } else {
    filters.push(`trim=duration=${round(clip.duration)}`, "setpts=PTS-STARTPTS");
  }
  filters.push(`fps=${round(plan.frameRate)}`);
  if (clip.sourceKind !== "text" && clip.sourceKind !== "subtitle") {
    filters.push(
      `crop=w='max(2,iw*${round(crop.width)})':h='max(2,ih*${round(crop.height)})':x='iw*${round(crop.x)}':y='ih*${round(crop.y)}'`,
    );
  }
  if (clip.transform.flipX) filters.push("hflip");
  if (clip.transform.flipY) filters.push("vflip");
  const rotation = linearExpression(
    clip.keyframes,
    "rotation",
    clip.transform.rotation,
    localTime,
  );
  if (rotation !== "0")
    filters.push(
      `rotate=angle='(${rotation})*PI/180':ow='rotw((${rotation})*PI/180)':oh='roth((${rotation})*PI/180)':c=none`,
    );
  const scale = linearExpression(
    clip.keyframes,
    "scale",
    clip.transform.scale,
    localTime,
  );
  const fitFunction =
    settings.aspectStrategy === "fill" || settings.aspectStrategy === "crop"
      ? "max"
      : "min";
  filters.push(
    `scale=w='max(2,${fitFunction}(${plan.width}/iw,${plan.height}/ih)*iw*(${scale}))':h='max(2,${fitFunction}(${plan.width}/iw,${plan.height}/ih)*ih*(${scale}))':eval=frame`,
    "format=rgba",
  );
  const opacity = linearExpression(
    clip.keyframes,
    "opacity",
    clip.opacity,
    localTime,
  );
  filters.push(
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacity})'`,
  );
  if (clip.fadeIn > 0)
    filters.push(`fade=t=in:st=0:d=${round(Math.min(clip.fadeIn, clip.duration))}:alpha=1`);
  if (clip.fadeOut > 0)
    filters.push(
      `fade=t=out:st=${round(Math.max(0, clip.duration - clip.fadeOut))}:d=${round(Math.min(clip.fadeOut, clip.duration))}:alpha=1`,
    );
  filters.push(`setpts=PTS+${round(clip.timelineStart)}/TB`);
  return `[${inputLabel}]${filters.join(",")}[clip_${clip.id}]`;
}

function audioFilters(clip, inputLabel, plan) {
  const duration = Math.max(0.01, clip.duration);
  const localTime = `(t+${round(clip.timelineStart)})`;
  const volume = linearExpression(clip.keyframes, "volume", clip.gain, localTime);
  const filters = [
    `atrim=start=${round(clip.sourceStart)}:end=${round(clip.sourceEnd)}`,
    "asetpts=PTS-STARTPTS",
  ];
  let speed = Math.max(0.01, clip.speed);
  while (speed < 0.5) {
    filters.push("atempo=0.5");
    speed /= 0.5;
  }
  while (speed > 2) {
    filters.push("atempo=2");
    speed /= 2;
  }
  if (Math.abs(speed - 1) > 0.0001) filters.push(`atempo=${round(speed)}`);
  filters.push(
    `volume='(${volume})*${round(clip.trackGain)}*${round(plan.masterGain)}':eval=frame`,
  );
  if (clip.fadeIn > 0)
    filters.push(`afade=t=in:st=0:d=${round(Math.min(clip.fadeIn, duration))}`);
  if (clip.fadeOut > 0)
    filters.push(
      `afade=t=out:st=${round(Math.max(0, duration - clip.fadeOut))}:d=${round(Math.min(clip.fadeOut, duration))}`,
    );
  filters.push(`adelay=${Math.round(clip.timelineStart * 1000)}:all=1`);
  return `[${inputLabel}]${filters.join(",")}[audio_${clip.id}]`;
}

function applyWatermark(filters, current, mask, index) {
  if (!mask.enabled) return current;
  if (mask.method === "ai") throw new Error("AI masks must be neural-preprocessed before FFmpeg filter-graph compilation.");
  const x = maskExpression(mask, "x", mask.x);
  const y = maskExpression(mask, "y", mask.y);
  const width = clamp(mask.width, 0.01, 1);
  const height = clamp(mask.height, 0.01, 1);
  const prefix = `mask_${index}`;
  filters.push(`[${current}]split[${prefix}_base][${prefix}_source]`);
  if (mask.method === "cover") {
    filters.push(
      `[${prefix}_source]crop=w='iw*${round(width)}':h='ih*${round(height)}':x='iw*(${x})':y='ih*(${y})',format=rgba,colorchannelmixer=rr=0:gg=0:bb=0:aa=0.92[${prefix}_patch]`,
    );
  } else if (mask.method === "clone") {
    filters.push(
      `[${prefix}_source]crop=w='iw*${round(width)}':h='ih*${round(height)}':x='max(0,iw*((${x})-${round(width)}))':y='ih*(${y})',format=rgba[${prefix}_patch]`,
    );
  } else if (mask.method === "pixelate") {
    filters.push(
      `[${prefix}_source]crop=w='iw*${round(width)}':h='ih*${round(height)}':x='iw*(${x})':y='ih*(${y})',scale=w='max(1,iw/14)':h='max(1,ih/14)',scale=w='max(2,iw*14)':h='max(2,ih*14)':flags=neighbor,format=rgba[${prefix}_patch]`,
    );
  } else {
    filters.push(
      `[${prefix}_source]crop=w='iw*${round(width)}':h='ih*${round(height)}':x='iw*(${x})':y='ih*(${y})',boxblur=luma_radius=${Math.max(2, Math.round(mask.feather))}:luma_power=2,format=rgba[${prefix}_patch]`,
    );
  }
  if (mask.shape === "ellipse") {
    filters.push(
      `[${prefix}_patch]geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*if(lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1),1,0)'[${prefix}_shape]`,
    );
  }
  const patch = mask.shape === "ellipse" ? `${prefix}_shape` : `${prefix}_patch`;
  filters.push(
    `[${prefix}_base][${patch}]overlay=x='W*(${x})':y='H*(${y})':enable='between(t,${round(mask.start)},${round(mask.end)})'[${prefix}_out]`,
  );
  return `${prefix}_out`;
}

export function buildDeterministicRenderArgs({
  plan,
  inputs,
  output,
  settings,
}) {
  const outputColor = settings.colorMode === "rec709-limited"
    ? { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "limited", hdr: false }
    : settings.colorMode === "rec709-full"
      ? { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "full", hdr: false }
      : settings.sourceColorInfo;
  const inputById = new Map(inputs.map((input, index) => [input.id, { ...input, index }]));
  const args = [];
  for (const input of inputs) {
    if (input.kind === "image" || input.kind === "text" || input.kind === "subtitle")
      args.push("-loop", "1");
    args.push("-i", input.filename);
  }
  const filters = [];
  const audioOnly = ["wav", "mp3", "opus"].includes(settings.format);
  const wantsAudio = audioOnly || settings.includeAudio;
  const visualUse = new Map();
  const audioUse = new Map();
  for (const clip of audioOnly ? [] : plan.visualClips) {
    if (inputById.get(clip.renderAssetId)?.hasVideo)
      visualUse.set(clip.renderAssetId, (visualUse.get(clip.renderAssetId) ?? 0) + 1);
  }
  for (const clip of wantsAudio ? plan.audioClips : []) {
    if (inputById.get(clip.renderAssetId)?.hasAudio)
      audioUse.set(clip.renderAssetId, (audioUse.get(clip.renderAssetId) ?? 0) + 1);
  }
  const visualLabels = new Map();
  const audioLabelsBySource = new Map();
  for (const [sourceId, count] of visualUse) {
    const input = inputById.get(sourceId);
    const labels = Array.from({ length: count }, (_, index) => `source_${input.index}_v_${index}`);
    if (count === 1) filters.push(`[${input.index}:v]null[${labels[0]}]`);
    else filters.push(`[${input.index}:v]split=${count}${labels.map((label) => `[${label}]`).join("")}`);
    visualLabels.set(sourceId, labels);
  }
  for (const [sourceId, count] of audioUse) {
    const input = inputById.get(sourceId);
    const labels = Array.from({ length: count }, (_, index) => `source_${input.index}_a_${index}`);
    if (count === 1) filters.push(`[${input.index}:a]anull[${labels[0]}]`);
    else filters.push(`[${input.index}:a]asplit=${count}${labels.map((label) => `[${label}]`).join("")}`);
    audioLabelsBySource.set(sourceId, labels);
  }
  let currentVideo = "base_0";
  if (!audioOnly) filters.push(
    `color=c=${String(plan.backgroundColor).replace("#", "0x")}:s=${plan.width}x${plan.height}:r=${plan.frameRate}:d=${plan.duration},format=rgba[${currentVideo}]`,
  );
  for (let index = 0; index < plan.visualClips.length; index += 1) {
    const clip = plan.visualClips[index];
    const input = inputById.get(clip.renderAssetId);
    if (!input?.hasVideo) continue;
    const inputLabel = visualLabels.get(clip.renderAssetId)?.shift();
    if (!inputLabel) continue;
    const clipFilter = visualFilters(clip, inputLabel, plan, input.hasVideo, settings);
    if (!clipFilter) continue;
    filters.push(clipFilter);
    const x = linearExpression(
      clip.keyframes,
      "x",
      clip.transform.x,
      "t",
    );
    const y = linearExpression(
      clip.keyframes,
      "y",
      clip.transform.y,
      "t",
    );
    const outputLabel = `composite_${index}`;
    const overlayX =
      clip.sourceKind === "text"
        ? `W*(${x})-w/2`
        : `(W-w)/2+W*(${x})`;
    const overlayY =
      clip.sourceKind === "text"
        ? `H*(${y})-h/2`
        : `(H-h)/2+H*(${y})`;
    filters.push(
      `[${currentVideo}][clip_${clip.id}]overlay=x='${overlayX}':y='${overlayY}':enable='between(t,${round(clip.timelineStart)},${round(clip.timelineStart + clip.duration)})'[${outputLabel}]`,
    );
    currentVideo = outputLabel;
  }
  if (!audioOnly) {
    let maskIndex = 0;
    for (const clip of plan.visualClips) {
      for (const mask of clip.watermarkMasks ?? []) {
        currentVideo = applyWatermark(filters, currentVideo, mask, maskIndex);
        maskIndex += 1;
      }
    }
    if (settings.format === "gif") {
      filters.push(
        `[${currentVideo}]fps=${settings.gifFps},scale=${settings.gifWidth}:-2:flags=lanczos,split[gif_source][gif_palette_source]`,
        `[gif_palette_source]palettegen=max_colors=256[gif_palette]`,
        `[gif_source][gif_palette]paletteuse=dither=sierra2_4a[vout]`,
      );
    } else filters.push(`[${currentVideo}]${finalSdrPixelFilter(outputColor)}[vout]`);
  }

  const audioLabels = [];
  for (const clip of plan.audioClips) {
    const input = inputById.get(clip.renderAssetId);
    if (!input?.hasAudio) continue;
    const inputLabel = audioLabelsBySource.get(clip.renderAssetId)?.shift();
    if (!inputLabel) continue;
    filters.push(audioFilters(clip, inputLabel, plan));
    audioLabels.push(`[audio_${clip.id}]`);
  }
  if (wantsAudio) {
    if (audioLabels.length) {
      filters.push(
        `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=duration=${plan.duration},aresample=${settings.audioSampleRate || 48000}[aout]`,
      );
    } else {
      filters.push(
        `anullsrc=r=${settings.audioSampleRate || 48000}:cl=stereo,atrim=duration=${plan.duration}[aout]`,
      );
    }
  }
  args.push("-filter_complex", filters.join(";"));

  if (!audioOnly) args.push("-map", "[vout]");
  if (wantsAudio && settings.format !== "gif") args.push("-map", "[aout]");
  const policy = encodingPolicy(settings);
  if (settings.format === "mp4") {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      policy.preset ?? "medium",
      ...(policy.mode === "crf" ? ["-crf", String(policy.crf)] : ["-b:v", String(policy.bitrate ?? settings.videoBitrate)]),
      "-pix_fmt",
      "yuv420p",
      ...colorMetadataArgs(outputColor),
      "-movflags",
      "+faststart",
    );
    if (wantsAudio)
      args.push("-c:a", "aac", "-b:a", String(settings.audioBitrate), "-ar", String(settings.audioSampleRate || 48000));
  } else if (settings.format === "webm") {
    args.push(
      "-c:v",
      "libvpx-vp9",
      ...(policy.mode === "crf" ? ["-crf", String(policy.crf), "-b:v", "0"] : ["-b:v", String(policy.bitrate ?? settings.videoBitrate)]),
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      ...colorMetadataArgs(outputColor),
    );
    if (wantsAudio)
      args.push("-c:a", "libopus", "-b:a", String(settings.audioBitrate), "-ar", String(settings.audioSampleRate || 48000));
  } else if (settings.format === "gif") {
    args.push("-an", "-loop", "0");
  } else if (settings.format === "wav") {
    args.push("-vn", "-c:a", "pcm_s16le");
  } else if (settings.format === "mp3") {
    args.push("-vn", "-c:a", "libmp3lame", "-b:a", String(settings.audioBitrate));
  } else {
    args.push("-vn", "-c:a", "libopus", "-b:a", String(settings.audioBitrate));
  }
  args.push("-t", String(plan.duration), output);
  return { args, filterComplex: filters.join(";"), plan };
}
