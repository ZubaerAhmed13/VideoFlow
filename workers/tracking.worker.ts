/// <reference lib="webworker" />

type Point = { time: number; x: number; y: number; width: number; height: number; confidence: number; method: "template" | "manual"; manual?: boolean };
type TrackingRequest =
  | { id: number; type: "init"; frame: ImageBitmap; initial: Point; searchRadius: number }
  | { id: number; type: "step"; frame: ImageBitmap; time: number }
  | { id: number; type: "dispose" };

let context: OffscreenCanvasRenderingContext2D | null = null;
let template: ImageData | null = null;
let frameWidth = 0;
let frameHeight = 0;
let patchWidth = 0;
let patchHeight = 0;
let lastX = 0;
let lastY = 0;
let radius = 28;
let consecutiveLost = 0;

function extractPatch(frame: ImageData, x: number, y: number): ImageData {
  const patch = new ImageData(patchWidth, patchHeight);
  for (let row = 0; row < patchHeight; row += 1) {
    const sourceStart = ((y + row) * frame.width + x) * 4;
    patch.data.set(frame.data.subarray(sourceStart, sourceStart + patchWidth * 4), row * patchWidth * 4);
  }
  return patch;
}

function errorAt(frame: ImageData, startX: number, startY: number): number {
  if (!template) return 1;
  const stride = Math.max(1, Math.ceil(Math.sqrt((template.width * template.height) / 4096)));
  let error = 0;
  let samples = 0;
  for (let y = 0; y < template.height; y += stride) {
    for (let x = 0; x < template.width; x += stride) {
      const a = (y * template.width + x) * 4;
      const b = ((startY + y) * frame.width + startX + x) * 4;
      error += Math.abs(template.data[a] - frame.data[b]) + Math.abs(template.data[a + 1] - frame.data[b + 1]) + Math.abs(template.data[a + 2] - frame.data[b + 2]);
      samples += 3;
    }
  }
  return samples ? error / (samples * 255) : 1;
}

function updateTemplate(candidate: ImageData): void {
  if (!template) return;
  for (let index = 0; index < template.data.length; index += 4) {
    template.data[index] = template.data[index] * 0.92 + candidate.data[index] * 0.08;
    template.data[index + 1] = template.data[index + 1] * 0.92 + candidate.data[index + 1] * 0.08;
    template.data[index + 2] = template.data[index + 2] * 0.92 + candidate.data[index + 2] * 0.08;
    template.data[index + 3] = 255;
  }
}

function search(frame: ImageData, searchRadius: number, step: number, centerX: number, centerY: number, current: { x: number; y: number; error: number }) {
  let best = current;
  for (let dy = -searchRadius; dy <= searchRadius; dy += step) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += step) {
      const x = Math.max(0, Math.min(frameWidth - patchWidth, Math.round(centerX + dx)));
      const y = Math.max(0, Math.min(frameHeight - patchHeight, Math.round(centerY + dy)));
      const error = errorAt(frame, x, y);
      if (error < best.error) best = { x, y, error };
    }
  }
  return best;
}

async function initialize(message: Extract<TrackingRequest, { type: "init" }>): Promise<Point> {
  frameWidth = message.frame.width;
  frameHeight = message.frame.height;
  radius = Math.max(8, message.searchRadius);
  const canvas = new OffscreenCanvas(frameWidth, frameHeight);
  context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Tracking worker canvas is unavailable.");
  context.drawImage(message.frame, 0, 0);
  message.frame.close();
  const frame = context.getImageData(0, 0, frameWidth, frameHeight);
  patchWidth = Math.max(8, Math.min(frameWidth, Math.round(message.initial.width * frameWidth)));
  patchHeight = Math.max(8, Math.min(frameHeight, Math.round(message.initial.height * frameHeight)));
  lastX = Math.max(0, Math.min(frameWidth - patchWidth, Math.round(message.initial.x * frameWidth)));
  lastY = Math.max(0, Math.min(frameHeight - patchHeight, Math.round(message.initial.y * frameHeight)));
  template = extractPatch(frame, lastX, lastY);
  consecutiveLost = 0;
  return { ...message.initial, x: lastX / frameWidth, y: lastY / frameHeight, width: patchWidth / frameWidth, height: patchHeight / frameHeight, confidence: 1, method: "manual", manual: true };
}

async function step(message: Extract<TrackingRequest, { type: "step" }>) {
  if (!context || !template) throw new Error("Tracking worker is not initialized.");
  context.clearRect(0, 0, frameWidth, frameHeight);
  context.drawImage(message.frame, 0, 0, frameWidth, frameHeight);
  message.frame.close();
  const frame = context.getImageData(0, 0, frameWidth, frameHeight);
  let best = search(frame, radius, 4, lastX, lastY, { x: lastX, y: lastY, error: Number.POSITIVE_INFINITY });
  best = search(frame, 5, 1, best.x, best.y, best);
  if (best.error > 0.36) best = search(frame, radius * 2, 6, lastX, lastY, best);
  const confidence = Math.max(0, Math.min(1, 1 - best.error / 0.38));
  lastX = best.x;
  lastY = best.y;
  if (confidence >= 0.72) updateTemplate(extractPatch(frame, lastX, lastY));
  consecutiveLost = confidence < 0.18 ? consecutiveLost + 1 : 0;
  const point: Point = { time: message.time, x: lastX / frameWidth, y: lastY / frameHeight, width: patchWidth / frameWidth, height: patchHeight / frameHeight, confidence, method: "template" };
  return { point, lost: consecutiveLost >= 3 };
}

self.onmessage = async (event: MessageEvent<TrackingRequest>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      self.postMessage({ id: message.id, ok: true, point: await initialize(message), lost: false });
    } else if (message.type === "step") {
      const result = await step(message);
      self.postMessage({ id: message.id, ok: true, ...result });
    } else {
      template = null;
      context = null;
      self.postMessage({ id: message.id, ok: true });
      self.close();
    }
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
