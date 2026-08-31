import type { TrackingIssue, TrackingPoint } from "../types";

export interface TrackingProgress {
  completed: number;
  total: number;
  time: number;
  confidence: number;
}

export interface TrackingResult {
  points: TrackingPoint[];
  issues: TrackingIssue[];
  completed: boolean;
}

function candidateError(
  template: ImageData,
  frame: ImageData,
  startX: number,
  startY: number,
): number {
  const stride = Math.max(1, Math.ceil(Math.sqrt((template.width * template.height) / 4096)));
  let error = 0;
  let samples = 0;
  for (let y = 0; y < template.height; y += stride) {
    for (let x = 0; x < template.width; x += stride) {
      const templateIndex = (y * template.width + x) * 4;
      const frameIndex = ((startY + y) * frame.width + startX + x) * 4;
      const dr = template.data[templateIndex] - frame.data[frameIndex];
      const dg = template.data[templateIndex + 1] - frame.data[frameIndex + 1];
      const db = template.data[templateIndex + 2] - frame.data[frameIndex + 2];
      error += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
      samples += 3;
    }
  }
  return samples ? error / (samples * 255) : 1;
}

function extractPatch(frame: ImageData, x: number, y: number, width: number, height: number): ImageData {
  const patch = new ImageData(width, height);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y + row) * frame.width + x) * 4;
    patch.data.set(frame.data.subarray(sourceStart, sourceStart + width * 4), row * width * 4);
  }
  return patch;
}

function updateTemplate(template: ImageData, candidate: ImageData, amount = 0.08): void {
  for (let index = 0; index < template.data.length; index += 4) {
    template.data[index] = template.data[index] * (1 - amount) + candidate.data[index] * amount;
    template.data[index + 1] = template.data[index + 1] * (1 - amount) + candidate.data[index + 1] * amount;
    template.data[index + 2] = template.data[index + 2] * (1 - amount) + candidate.data[index + 2] * amount;
    template.data[index + 3] = 255;
  }
}

export function trackingIssuesFromPoints(points: TrackingPoint[], lost: boolean): TrackingIssue[] {
  const low = points.filter((point) => (point.confidence ?? 1) < 0.55);
  if (!low.length) return [];
  const issues: TrackingIssue[] = [];
  let active = { start: low[0].time, end: low[0].time, minimumConfidence: low[0].confidence ?? 0 };
  const expectedStep = points.length > 1 ? Math.max(0.01, Math.abs(points[1].time - points[0].time) * 1.6) : 0.35;
  for (const point of low.slice(1)) {
    if (Math.abs(point.time - active.end) <= expectedStep) {
      active.end = point.time;
      active.minimumConfidence = Math.min(active.minimumConfidence, point.confidence ?? 0);
    } else {
      issues.push({ ...active, start: Math.min(active.start, active.end), end: Math.max(active.start, active.end), reason: "low-confidence" });
      active = { start: point.time, end: point.time, minimumConfidence: point.confidence ?? 0 };
    }
  }
  issues.push({ ...active, start: Math.min(active.start, active.end), end: Math.max(active.start, active.end), reason: lost ? "tracking-lost" : "low-confidence" });
  return issues.sort((a, b) => a.start - b.start);
}

export async function trackTemplateStream(
  times: number[],
  initial: TrackingPoint,
  frameProvider: (time: number, index: number) => Promise<ImageBitmap>,
  options: {
    searchRadius?: number;
    signal?: AbortSignal;
    onProgress?: (progress: TrackingProgress) => void;
    stopOnLost?: boolean;
  } = {},
): Promise<TrackingResult> {
  if (!times.length) return { points: [], issues: [], completed: true };
  const signal = options.signal;
  const first = await frameProvider(times[0], 0);
  const width = first.width;
  const height = first.height;
  const frameCanvas = new OffscreenCanvas(width, height);
  const context = frameCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Tracking canvas is unavailable.");
  context.drawImage(first, 0, 0);
  first.close();
  const firstData = context.getImageData(0, 0, width, height);
  const patchWidth = Math.max(8, Math.min(width, Math.round(initial.width * width)));
  const patchHeight = Math.max(8, Math.min(height, Math.round(initial.height * height)));
  const initialX = Math.max(0, Math.min(width - patchWidth, Math.round(initial.x * width)));
  const initialY = Math.max(0, Math.min(height - patchHeight, Math.round(initial.y * height)));
  const template = extractPatch(firstData, initialX, initialY, patchWidth, patchHeight);
  const points: TrackingPoint[] = [{ ...initial, time: times[0], confidence: 1, manual: true, method: "manual" }];
  let lastX = initialX;
  let lastY = initialY;
  let consecutiveLost = 0;
  let completed = true;
  options.onProgress?.({ completed: 1, total: times.length, time: times[0], confidence: 1 });

  for (let index = 1; index < times.length; index += 1) {
    if (signal?.aborted) throw new DOMException("Tracking cancelled.", "AbortError");
    const bitmap = await frameProvider(times[index], index);
    context.clearRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const frame = context.getImageData(0, 0, width, height);
    const baseRadius = Math.max(8, options.searchRadius ?? 28);
    let best = { x: lastX, y: lastY, error: Number.POSITIVE_INFINITY };
    const search = (radius: number, step: number, centerX: number, centerY: number) => {
      for (let dy = -radius; dy <= radius; dy += step) {
        for (let dx = -radius; dx <= radius; dx += step) {
          const x = Math.max(0, Math.min(width - patchWidth, Math.round(centerX + dx)));
          const y = Math.max(0, Math.min(height - patchHeight, Math.round(centerY + dy)));
          const error = candidateError(template, frame, x, y);
          if (error < best.error) best = { x, y, error };
        }
      }
    };
    search(baseRadius, 4, lastX, lastY);
    const coarse = best;
    search(5, 1, coarse.x, coarse.y);
    if (best.error > 0.36) search(baseRadius * 2, 6, lastX, lastY);
    const confidence = Math.max(0, Math.min(1, 1 - best.error / 0.38));
    lastX = best.x;
    lastY = best.y;
    const point: TrackingPoint = {
      time: times[index],
      x: best.x / width,
      y: best.y / height,
      width: patchWidth / width,
      height: patchHeight / height,
      confidence,
      method: "template",
    };
    points.push(point);
    if (confidence >= 0.72) updateTemplate(template, extractPatch(frame, best.x, best.y, patchWidth, patchHeight));
    consecutiveLost = confidence < 0.18 ? consecutiveLost + 1 : 0;
    options.onProgress?.({ completed: index + 1, total: times.length, time: times[index], confidence });
    if (options.stopOnLost !== false && consecutiveLost >= 3) {
      completed = false;
      break;
    }
  }
  return { points, issues: trackingIssuesFromPoints(points, !completed), completed };
}

export async function trackTemplate(
  frames: Array<{ time: number; image: ImageBitmap }>,
  initial: TrackingPoint,
  searchRadius = 24,
): Promise<TrackingPoint[]> {
  const result = await trackTemplateStream(
    frames.map((frame) => frame.time),
    initial,
    async (_time, index) => frames[index].image,
    { searchRadius, stopOnLost: false },
  );
  return result.points;
}
