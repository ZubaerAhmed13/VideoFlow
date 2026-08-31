import {
  clipDuration,
  projectDuration,
  resolvePropertyKeyframes,
  resolveWatermarkMask,
} from "./core.mjs";

const KEYFRAME_PROPERTIES = ["x", "y", "scale", "rotation", "opacity", "volume"];

function fallbackForProperty(clip, property) {
  if (property === "opacity") return clip.opacity;
  if (property === "volume") return clip.gain;
  return clip.transform?.[property] ?? 0;
}

function slicePropertyKeyframes(clip, overlapStart, overlapEnd, rangeStart) {
  const source = clip.keyframes ?? [];
  if (!source.length) return [];
  const output = source
    .filter((keyframe) => keyframe.time >= overlapStart - 0.000001 && keyframe.time <= overlapEnd + 0.000001)
    .map((keyframe) => ({ ...keyframe, time: Math.max(0, keyframe.time - rangeStart) }));

  for (const property of KEYFRAME_PROPERTIES) {
    const propertyFrames = source.filter((entry) => entry.property === property);
    if (!propertyFrames.length) continue;
    const relativeStart = Math.max(0, overlapStart - rangeStart);
    const relativeEnd = Math.max(relativeStart, overlapEnd - rangeStart);
    const hasStart = output.some((entry) => entry.property === property && Math.abs(entry.time - relativeStart) < 0.001);
    if (!hasStart) {
      output.push({
        id: `range_${property}_start_${relativeStart.toFixed(3)}`,
        property,
        time: relativeStart,
        value: resolvePropertyKeyframes(source, property, overlapStart, fallbackForProperty(clip, property)),
        easing: "linear",
      });
    }
    const hasEnd = output.some((entry) => entry.property === property && Math.abs(entry.time - relativeEnd) < 0.001);
    if (!hasEnd && overlapEnd > overlapStart) {
      output.push({
        id: `range_${property}_end_${relativeEnd.toFixed(3)}`,
        property,
        time: relativeEnd,
        value: resolvePropertyKeyframes(source, property, overlapEnd, fallbackForProperty(clip, property)),
        easing: "linear",
      });
    }
  }
  return output.sort((a, b) => a.time - b.time || a.property.localeCompare(b.property));
}

function sliceWatermarkMask(mask, overlapStart, overlapEnd, rangeStart) {
  const activeStart = Math.max(mask.start, overlapStart);
  const activeEnd = Math.min(mask.end, overlapEnd);
  if (activeEnd <= activeStart) return null;
  const relativeStart = Math.max(0, activeStart - rangeStart);
  const relativeEnd = Math.max(relativeStart, activeEnd - rangeStart);
  const sourceFrames = mask.keyframes ?? [];
  const keyframes = sourceFrames
    .filter((keyframe) => keyframe.time >= activeStart - 0.000001 && keyframe.time <= activeEnd + 0.000001)
    .map((keyframe) => ({ ...keyframe, time: Math.max(0, keyframe.time - rangeStart) }));
  if (sourceFrames.length) {
    const startState = resolveWatermarkMask(mask, activeStart);
    if (!keyframes.some((entry) => Math.abs(entry.time - relativeStart) < 0.001)) {
      keyframes.push({
        time: relativeStart,
        x: startState.x,
        y: startState.y,
        width: startState.width,
        height: startState.height,
        easing: "linear",
      });
    }
    const endState = resolveWatermarkMask(mask, activeEnd);
    if (!keyframes.some((entry) => Math.abs(entry.time - relativeEnd) < 0.001)) {
      keyframes.push({
        time: relativeEnd,
        x: endState.x,
        y: endState.y,
        width: endState.width,
        height: endState.height,
        easing: "linear",
      });
    }
  }
  return {
    ...structuredClone(mask),
    start: relativeStart,
    end: relativeEnd,
    keyframes: keyframes.sort((a, b) => a.time - b.time),
  };
}

/**
 * Return a non-destructive project slice suitable for deterministic in/out
 * range rendering. Clip source offsets are advanced by speed, global
 * keyframes are shifted with boundary values preserved, and masks/subtitles
 * are clipped to the requested range.
 * @param {any} project
 * @param {number} start
 * @param {number} end
 */
export function projectForExportRange(project, start = 0, end = projectDuration(project)) {
  const safeStart = Math.max(0, Math.min(start, end));
  const projectEnd = projectDuration(project);
  const safeEnd = Math.max(safeStart, Math.min(end, projectEnd));
  if (safeStart <= 0 && safeEnd >= projectEnd) return structuredClone(project);

  const clips = project.clips.flatMap((clip) => {
    const clipStart = clip.timelineStart;
    const clipEnd = clip.timelineStart + clipDuration(clip);
    const overlapStart = Math.max(clipStart, safeStart);
    const overlapEnd = Math.min(clipEnd, safeEnd);
    if (overlapEnd <= overlapStart) return [];
    const sourceAdvance = Math.max(0, overlapStart - clipStart) * clip.speed;
    const sourceDuration = (overlapEnd - overlapStart) * clip.speed;
    const cloned = structuredClone(clip);
    return [{
      ...cloned,
      timelineStart: overlapStart - safeStart,
      sourceStart: clip.sourceStart + sourceAdvance,
      sourceEnd: Math.min(clip.sourceEnd, clip.sourceStart + sourceAdvance + sourceDuration),
      keyframes: slicePropertyKeyframes(clip, overlapStart, overlapEnd, safeStart),
      watermarkMasks: (cloned.watermarkMasks ?? [])
        .map((mask) => sliceWatermarkMask(mask, overlapStart, overlapEnd, safeStart))
        .filter(Boolean),
    }];
  });

  const subtitles = project.subtitles.flatMap((cue) => {
    const cueStart = Math.max(cue.start, safeStart);
    const cueEnd = Math.min(cue.end, safeEnd);
    if (cueEnd <= cueStart) return [];
    return [{ ...cue, start: cueStart - safeStart, end: cueEnd - safeStart }];
  });

  return {
    ...structuredClone(project),
    clips,
    subtitles,
    updatedAt: new Date().toISOString(),
  };
}
