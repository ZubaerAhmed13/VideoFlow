import { clipDuration, clamp, resolveClipState, resolveWatermarkMask } from "./core.mjs";
import type { Clip, RuntimeAsset, SubtitleCue, VideoFlowProject, WatermarkMask } from "./types";

type Drawable = HTMLVideoElement | HTMLImageElement;

export interface PreparedMedia {
  visual: Map<string, Drawable>;
  audible: Map<string, HTMLMediaElement>;
  cleanup: () => void;
}

export async function prepareMedia(
  project: VideoFlowProject,
  assets: RuntimeAsset[],
  options: { useProxies?: boolean } = {},
): Promise<PreparedMedia> {
  const visual = new Map<string, Drawable>();
  const audible = new Map<string, HTMLMediaElement>();
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const pending: Array<Promise<void>> = [];
  const load = (element: HTMLMediaElement, source: string) => {
    pending.push(new Promise<void>((resolve) => {
      element.preload = "auto";
      element.onloadeddata = () => resolve();
      element.onerror = () => resolve();
      element.src = source;
    }));
  };
  for (const clip of project.clips) {
    if (!clip.assetId) continue;
    const asset = assetById.get(clip.assetId);
    if (!asset) continue;
    if (asset.kind === "image") {
      if (!asset.url) continue;
      const image = new Image();
      pending.push(new Promise<void>((resolve) => { image.onload = () => resolve(); image.onerror = () => resolve(); }));
      image.src = asset.url;
      visual.set(clip.id, image);
      continue;
    }
    if (asset.kind === "video" || asset.kind === "audio") {
      const preferredUrl =
        options.useProxies && asset.proxyUrl ? asset.proxyUrl : asset.url ?? asset.proxyUrl;
      if (!preferredUrl) continue;
      const sourceElement = document.createElement(asset.kind);
      if (sourceElement instanceof HTMLVideoElement) sourceElement.playsInline = true;
      load(sourceElement, preferredUrl);
      audible.set(clip.id, sourceElement);
      if (asset.kind === "video") {
        if (options.useProxies && asset.proxyUrl && preferredUrl !== asset.proxyUrl) {
          const proxyElement = document.createElement("video");
          proxyElement.playsInline = true;
          load(proxyElement, asset.proxyUrl);
          visual.set(clip.id, proxyElement);
        } else visual.set(clip.id, sourceElement as HTMLVideoElement);
      }
    }
  }
  await Promise.all(pending);
  return {
    visual,
    audible,
    cleanup: () => {
      const mediaElements = new Set<HTMLMediaElement>(audible.values());
      for (const drawable of visual.values()) if (drawable instanceof HTMLMediaElement) mediaElements.add(drawable);
      for (const media of mediaElements) {
        media.pause();
        media.removeAttribute("src");
        media.load();
      }
      visual.clear();
      audible.clear();
    },
  };
}

function fitRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
  const ratio = Math.min(targetWidth / Math.max(1, sourceWidth), targetHeight / Math.max(1, sourceHeight));
  const width = sourceWidth * ratio;
  const height = sourceHeight * ratio;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

function applyMask(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, mask: WatermarkMask): void {
  if (!mask.enabled) return;
  const x = mask.x * canvas.width;
  const y = mask.y * canvas.height;
  const width = mask.width * canvas.width;
  const height = mask.height * canvas.height;
  context.save();
  context.beginPath();
  if (mask.shape === "ellipse") context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  else context.rect(x, y, width, height);
  context.clip();
  if (mask.method === "ai") {
    context.restore();
    return;
  }
  if (mask.method === "cover") {
    context.fillStyle = "#111318";
    context.fillRect(x, y, width, height);
  } else if (mask.method === "clone") {
    const sourceX = clamp(x - width, 0, canvas.width - width);
    context.drawImage(canvas, sourceX, y, width, height, x, y, width, height);
  } else if (mask.method === "pixelate") {
    const smallWidth = Math.max(1, Math.round(width / 14));
    const smallHeight = Math.max(1, Math.round(height / 14));
    const buffer = document.createElement("canvas");
    buffer.width = smallWidth;
    buffer.height = smallHeight;
    const bufferContext = buffer.getContext("2d");
    bufferContext?.drawImage(canvas, x, y, width, height, 0, 0, smallWidth, smallHeight);
    context.imageSmoothingEnabled = false;
    context.drawImage(buffer, 0, 0, smallWidth, smallHeight, x, y, width, height);
    context.imageSmoothingEnabled = true;
  } else {
    const buffer = document.createElement("canvas");
    buffer.width = Math.max(1, Math.round(width));
    buffer.height = Math.max(1, Math.round(height));
    const bufferContext = buffer.getContext("2d");
    if (bufferContext) {
      bufferContext.filter = `blur(${Math.max(2, mask.feather)}px)`;
      bufferContext.drawImage(canvas, x, y, width, height, 0, 0, width, height);
      context.drawImage(buffer, x, y);
    }
  }
  context.restore();
}

function drawMaskGuide(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, mask: WatermarkMask): void {
  const x = mask.x * canvas.width;
  const y = mask.y * canvas.height;
  const width = mask.width * canvas.width;
  const height = mask.height * canvas.height;
  const handle = Math.max(6, Math.min(canvas.width, canvas.height) * 0.009);
  context.save();
  context.strokeStyle = "#32d583";
  context.fillStyle = "#07120c";
  context.lineWidth = Math.max(2, canvas.width / 640);
  context.setLineDash([8, 5]);
  if (mask.shape === "ellipse") {
    context.beginPath();
    context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    context.stroke();
  } else context.strokeRect(x, y, width, height);
  context.setLineDash([]);
  for (const [handleX, handleY] of [
    [x, y], [x + width / 2, y], [x + width, y],
    [x, y + height / 2], [x + width, y + height / 2],
    [x, y + height], [x + width / 2, y + height], [x + width, y + height],
  ]) {
    context.fillRect(handleX - handle / 2, handleY - handle / 2, handle, handle);
    context.strokeRect(handleX - handle / 2, handleY - handle / 2, handle, handle);
  }
  context.restore();
}


function drawCropGuide(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, crop: Clip["transform"]["crop"]): void {
  const x = crop.x * canvas.width;
  const y = crop.y * canvas.height;
  const width = crop.width * canvas.width;
  const height = crop.height * canvas.height;
  const handle = Math.max(8, Math.min(canvas.width, canvas.height) * 0.011);
  context.save();
  context.fillStyle = "rgba(0,0,0,.24)";
  context.fillRect(0, 0, canvas.width, y);
  context.fillRect(0, y + height, canvas.width, Math.max(0, canvas.height - y - height));
  context.fillRect(0, y, x, height);
  context.fillRect(x + width, y, Math.max(0, canvas.width - x - width), height);
  context.strokeStyle = "#f5c451";
  context.fillStyle = "#111318";
  context.lineWidth = Math.max(2, canvas.width / 640);
  context.strokeRect(x, y, width, height);
  for (const [handleX, handleY] of [
    [x, y], [x + width / 2, y], [x + width, y],
    [x, y + height / 2], [x + width, y + height / 2],
    [x, y + height], [x + width / 2, y + height], [x + width, y + height],
  ]) {
    context.fillRect(handleX - handle / 2, handleY - handle / 2, handle, handle);
    context.strokeRect(handleX - handle / 2, handleY - handle / 2, handle, handle);
  }
  context.restore();
}

function drawText(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, clip: Clip): void {
  const text = (clip.text ?? "Text").slice(0, 500);
  const size = clamp(clip.fontSize ?? 52, 12, 240);
  const style = clip.textStyle;
  const x = clamp(clip.transform.x, 0, 1) * canvas.width;
  const y = clamp(clip.transform.y, 0, 1) * canvas.height;
  context.save();
  context.globalAlpha = clip.opacity;
  context.translate(x, y);
  context.rotate((clip.transform.rotation * Math.PI) / 180);
  context.scale(clip.transform.scale, clip.transform.scale);
  context.font = `${style?.italic ? "italic " : ""}${style?.fontWeight ?? 600} ${size}px ${style?.fontFamily ?? "system-ui"}, sans-serif`;
  context.textAlign = style?.align ?? "center";
  context.textBaseline = "middle";
  const metrics = context.measureText(text);
  if (clip.background && clip.background !== "transparent") {
    context.fillStyle = clip.background;
    const padding = style?.padding ?? 18;
    context.fillRect(-metrics.width / 2 - padding, -size * 0.72, metrics.width + padding * 2, size * 1.44);
  }
  context.shadowColor = style?.shadowColor ?? "rgba(0,0,0,.45)";
  context.shadowBlur = style?.shadowBlur ?? 4;
  context.lineWidth = style?.strokeWidth ?? Math.max(2, size / 18);
  context.strokeStyle = style?.strokeColor ?? "rgba(0,0,0,.75)";
  if (context.lineWidth > 0) context.strokeText(text, 0, 0);
  context.fillStyle = clip.color ?? "#ffffff";
  context.fillText(text, 0, 0);
  context.restore();
}

function drawSubtitles(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, cues: SubtitleCue[], time: number): void {
  const cue = cues.find((entry) => time >= entry.start && time < entry.end);
  if (!cue) return;
  const text = cue.text.replace(/[<>]/g, "").slice(0, 500);
  context.save();
  context.font = `600 ${Math.max(22, canvas.height * 0.044)}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "bottom";
  const width = Math.min(canvas.width * 0.88, context.measureText(text).width + 34);
  const x = canvas.width / 2;
  const y = canvas.height * 0.92;
  context.fillStyle = "rgba(0,0,0,.74)";
  context.fillRect(x - width / 2, y - canvas.height * 0.066, width, canvas.height * 0.078);
  context.fillStyle = "#fff";
  context.fillText(text, x, y);
  context.restore();
}

export function drawCompositionFrame(
  canvas: HTMLCanvasElement,
  project: VideoFlowProject,
  prepared: PreparedMedia,
  time: number,
  options: { maskMode?: "original" | "processed" | "split"; showMaskGuides?: boolean; selectedId?: string | null; showCropGuide?: boolean } = {},
): void {
  if (options.maskMode === "split") {
    const original = document.createElement("canvas");
    original.width = canvas.width;
    original.height = canvas.height;
    drawCompositionFrame(original, project, prepared, time, { maskMode: "original" });
    drawCompositionFrame(canvas, project, prepared, time, { maskMode: "processed", showMaskGuides: options.showMaskGuides, selectedId: options.selectedId, showCropGuide: options.showCropGuide });
    const splitContext = canvas.getContext("2d");
    if (splitContext) {
      splitContext.drawImage(original, 0, 0, canvas.width / 2, canvas.height, 0, 0, canvas.width / 2, canvas.height);
      splitContext.fillStyle = "#ffffff";
      splitContext.fillRect(canvas.width / 2 - 1, 0, 2, canvas.height);
    }
    return;
  }
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  context.fillStyle = project.settings.backgroundColor ?? "#080a0f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const visibleTracks = new Map(project.tracks.map((track) => [track.id, track]));
  const clips = [...project.clips].sort(
    (a, b) =>
      (a.kind === "text" ? 10_000 : visibleTracks.get(a.trackId)?.index ?? 0) -
      (b.kind === "text" ? 10_000 : visibleTracks.get(b.trackId)?.index ?? 0),
  );
  for (const baseClip of clips) {
    const clip = resolveClipState(baseClip, time) as Clip;
    const local = time - clip.timelineStart;
    const envelope = Math.min(
      1,
      clip.fadeIn > 0 ? local / clip.fadeIn : 1,
      clip.fadeOut > 0 ? (clipDuration(clip) - local) / clip.fadeOut : 1,
    );
    clip.opacity *= clamp(envelope, 0, 1);
    const track = visibleTracks.get(clip.trackId);
    if (!track?.visible || track.muted && clip.kind === "audio") continue;
    const duration = clipDuration(clip);
    if (time < clip.timelineStart || time >= clip.timelineStart + duration) continue;
    if (clip.kind === "text") {
      drawText(context, canvas, clip);
      continue;
    }
    if (!clip.assetId) continue;
    const media = prepared.visual.get(clip.id);
    if (!media) continue;
    const sourceWidth = media instanceof HTMLImageElement ? media.naturalWidth : media.videoWidth;
    const sourceHeight = media instanceof HTMLImageElement ? media.naturalHeight : media.videoHeight;
    if (!sourceWidth || !sourceHeight) continue;
    const crop = clip.transform.crop;
    const sx = crop.x * sourceWidth;
    const sy = crop.y * sourceHeight;
    const sw = crop.width * sourceWidth;
    const sh = crop.height * sourceHeight;
    const fitted = fitRect(sw, sh, canvas.width, canvas.height);
    context.save();
    context.globalAlpha = clip.opacity;
    context.translate(canvas.width * clip.transform.x, canvas.height * clip.transform.y);
    context.translate(fitted.x + fitted.width / 2, fitted.y + fitted.height / 2);
    context.rotate((clip.transform.rotation * Math.PI) / 180);
    context.scale((clip.transform.flipX ? -1 : 1) * clip.transform.scale, (clip.transform.flipY ? -1 : 1) * clip.transform.scale);
    context.drawImage(media, sx, sy, sw, sh, -fitted.width / 2, -fitted.height / 2, fitted.width, fitted.height);
    context.restore();
    if (options.showCropGuide && baseClip.id === options.selectedId && clip.kind === "video") {
      drawCropGuide(context, canvas, clip.transform.crop);
    }
    for (const mask of clip.watermarkMasks) {
      if (time < mask.start || time > mask.end) continue;
      const resolved = resolveWatermarkMask(mask, time) as WatermarkMask;
      if (options.maskMode !== "original") applyMask(context, canvas, resolved);
      if (options.showMaskGuides) drawMaskGuide(context, canvas, resolved);
    }
  }
  drawSubtitles(context, canvas, project.subtitles, time);
}
