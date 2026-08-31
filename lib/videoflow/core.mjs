export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function uid(prefix = "id") {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

export function clipDuration(clip) {
  return Math.max(0, (clip.sourceEnd - clip.sourceStart) / Math.max(0.01, clip.speed));
}

export function projectDuration(project) {
  return project.clips.reduce(
    (max, clip) => Math.max(max, clip.timelineStart + clipDuration(clip)),
    0,
  );
}

export function formatTime(seconds, milliseconds = true) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  const base = [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
  return milliseconds ? `${base}.${String(ms).padStart(3, "0")}` : base;
}

export function parseTime(value) {
  if (typeof value === "number") return Math.max(0, value);
  const normalized = String(value).trim().replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(normalized)) return Math.max(0, Number(normalized));
  const parts = normalized.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length > 3) return null;
  while (parts.length < 3) parts.unshift(0);
  return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
}

export function snapTime(value, points, threshold) {
  let best = value;
  let distance = threshold + 1;
  for (const point of points) {
    const nextDistance = Math.abs(point - value);
    if (nextDistance <= threshold && nextDistance < distance) {
      best = point;
      distance = nextDistance;
    }
  }
  return Math.max(0, best);
}

export function normalizeCrop(crop) {
  const width = clamp(crop.width, 0.01, 1);
  const height = clamp(crop.height, 0.01, 1);
  return {
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
  };
}

export function interpolateKeyframes(keyframes, time) {
  if (!keyframes.length) return null;
  const ordered = [...keyframes].sort((a, b) => a.time - b.time);
  if (time <= ordered[0].time) return ordered[0].value;
  if (time >= ordered.at(-1).time) return ordered.at(-1).value;
  const rightIndex = ordered.findIndex((entry) => entry.time >= time);
  const left = ordered[rightIndex - 1];
  const right = ordered[rightIndex];
  const ratio = (time - left.time) / (right.time - left.time);
  if (typeof left.value === "number") return left.value + (right.value - left.value) * ratio;
  return Object.fromEntries(Object.keys(left.value).map((key) => [key, left.value[key] + (right.value[key] - left.value[key]) * ratio]));
}

export function resolveWatermarkMask(mask, time) {
  if (!mask?.keyframes?.length) return mask;
  const value = interpolateKeyframes(
    mask.keyframes.map((keyframe) => ({
      time: keyframe.time,
      value: { x: keyframe.x, y: keyframe.y, width: keyframe.width, height: keyframe.height },
    })),
    time,
  );
  return value ? { ...mask, ...value } : mask;
}

export function resolvePropertyKeyframes(keyframes, property, time, fallback) {
  const value = interpolateKeyframes(
    (keyframes ?? [])
      .filter((keyframe) => keyframe.property === property)
      .map((keyframe) => ({ time: keyframe.time, value: keyframe.value })),
    time,
  );
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveClipState(clip, time) {
  return {
    ...clip,
    opacity: resolvePropertyKeyframes(clip.keyframes, "opacity", time, clip.opacity),
    gain: resolvePropertyKeyframes(clip.keyframes, "volume", time, clip.gain),
    transform: {
      ...clip.transform,
      x: resolvePropertyKeyframes(clip.keyframes, "x", time, clip.transform.x),
      y: resolvePropertyKeyframes(clip.keyframes, "y", time, clip.transform.y),
      scale: resolvePropertyKeyframes(clip.keyframes, "scale", time, clip.transform.scale),
      rotation: resolvePropertyKeyframes(clip.keyframes, "rotation", time, clip.transform.rotation),
    },
  };
}

export function upsertPropertyKeyframe(clip, property, time, value) {
  const keyframe = {
    id: `keyframe_${property}_${Math.max(0, time).toFixed(3)}`,
    time: Math.max(0, time),
    property,
    value: Number(value),
    easing: "linear",
  };
  const current = clip.keyframes ?? [];
  const next = current.some(
    (entry) =>
      entry.property === property && Math.abs(entry.time - keyframe.time) < 0.001,
  )
    ? current.map((entry) =>
        entry.property === property && Math.abs(entry.time - keyframe.time) < 0.001
          ? keyframe
          : entry,
      )
    : [...current, keyframe];
  return {
    ...clip,
    keyframes: next.sort(
      (a, b) => a.time - b.time || a.property.localeCompare(b.property),
    ),
  };
}

export function isTrackAudible(project, trackId) {
  const track = project.tracks.find((entry) => entry.id === trackId);
  if (!track || track.muted || !track.visible) return false;
  const audibleTracks = project.tracks.filter(
    (entry) => entry.kind === "audio" || entry.kind === "video",
  );
  const soloed = audibleTracks.filter((entry) => entry.solo);
  return !soloed.length || Boolean(track.solo);
}

export function upsertWatermarkKeyframe(mask, time, patch = {}) {
  const resolved = resolveWatermarkMask(mask, time);
  const keyframe = {
    time: Math.max(0, time),
    x: clamp(patch.x ?? resolved.x, 0, 1),
    y: clamp(patch.y ?? resolved.y, 0, 1),
    width: clamp(patch.width ?? resolved.width, 0.01, 1),
    height: clamp(patch.height ?? resolved.height, 0.01, 1),
    easing: "linear",
  };
  keyframe.x = clamp(keyframe.x, 0, 1 - keyframe.width);
  keyframe.y = clamp(keyframe.y, 0, 1 - keyframe.height);
  const existing = mask.keyframes ?? [];
  const next = existing.some((entry) => Math.abs(entry.time - keyframe.time) < 0.001)
    ? existing.map((entry) => Math.abs(entry.time - keyframe.time) < 0.001 ? keyframe : entry)
    : [...existing, keyframe];
  return { ...mask, ...patch, keyframes: next.sort((a, b) => a.time - b.time) };
}

export function parseSrt(text) {
  const blocks = String(text).replace(/\r/g, "").trim().split(/\n\s*\n/);
  return blocks.flatMap((block, index) => {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0]?.trim())) lines.shift();
    const timing = lines.shift()?.split(/\s+-->\s+/);
    if (!timing || timing.length !== 2) return [];
    const start = parseTime(timing[0]);
    const end = parseTime(timing[1]);
    if (start === null || end === null || end <= start) return [];
    return [{ id: `cue_${index}_${start}`, start, end, text: lines.join("\n").replace(/[<>]/g, "") }];
  });
}

export function cuesToSrt(cues) {
  return cues
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => `${index + 1}\n${formatTime(cue.start).replace(".", ",")} --> ${formatTime(cue.end).replace(".", ",")}\n${cue.text.replace(/[<>]/g, "")}`)
    .join("\n\n");
}

export function serializeProject(project) {
  return JSON.stringify({ format: "videoflow-project", schemaVersion: 3, exportedAt: new Date().toISOString(), project }, null, 2);
}

export function migrateProject(input) {
  const wrapper = input?.format === "videoflow-project" ? input.project : input;
  if (!wrapper || typeof wrapper !== "object") throw new Error("This is not a VideoFlow project file.");
  if ((wrapper.schemaVersion ?? 1) > 3) throw new Error("This project was created by a newer VideoFlow version.");
  const clips = (wrapper.clips ?? []).map((clip) => ({
    ...clip,
    ...(clip.kind === "text"
      ? {
          textStyle: {
            fontFamily: "system-ui",
            fontWeight: 600,
            italic: false,
            align: "center",
            lineHeight: 1.15,
            letterSpacing: 0,
            strokeColor: "rgba(0,0,0,.78)",
            strokeWidth: 2,
            shadowColor: "rgba(0,0,0,.45)",
            shadowBlur: 4,
            backgroundOpacity: 0.6,
            padding: 18,
            ...clip.textStyle,
          },
        }
      : {}),
    fadeIn: Number(clip.fadeIn ?? 0),
    fadeOut: Number(clip.fadeOut ?? 0),
    keyframes: clip.keyframes ?? [],
    watermarkMasks: (clip.watermarkMasks ?? []).map((mask) => ({ ...mask, keyframes: mask.keyframes ?? [] })),
  }));
  const tracks = (wrapper.tracks ?? []).map((track) => ({
    ...track,
    solo: Boolean(track.solo),
    gain: Number.isFinite(track.gain) ? track.gain : 1,
  }));
  return {
    ...wrapper,
    clips,
    tracks,
    settings: {
      ...wrapper.settings,
      masterGain: Number.isFinite(wrapper.settings?.masterGain)
        ? wrapper.settings.masterGain
        : 1,
      backgroundColor: wrapper.settings?.backgroundColor ?? "#080a0f",
    },
    schemaVersion: 3,
    revision: Number(wrapper.revision ?? 0),
  };
}
