import type { ROI, ROITransform } from "../types";

export function normalizedMaskToROI(mask: { x: number; y: number; width: number; height: number }, sourceWidth: number, sourceHeight: number, padding = 96): ROI {
  const x0 = Math.max(0, Math.floor(mask.x * sourceWidth) - padding);
  const y0 = Math.max(0, Math.floor(mask.y * sourceHeight) - padding);
  const x1 = Math.min(sourceWidth, Math.ceil((mask.x + mask.width) * sourceWidth) + padding);
  const y1 = Math.min(sourceHeight, Math.ceil((mask.y + mask.height) * sourceHeight) + padding);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0), sourceWidth, sourceHeight };
}

export function createROITransform(
  originalWidth: number,
  originalHeight: number,
  modelWidth = 512,
  modelHeight = 512,
): ROITransform {
  const scale = Math.min(modelWidth / Math.max(1, originalWidth), modelHeight / Math.max(1, originalHeight));
  const scaledWidth = Math.max(1, Math.min(modelWidth, Math.round(originalWidth * scale)));
  const scaledHeight = Math.max(1, Math.min(modelHeight, Math.round(originalHeight * scale)));
  const paddingLeft = Math.floor((modelWidth - scaledWidth) / 2);
  const paddingTop = Math.floor((modelHeight - scaledHeight) / 2);
  return {
    originalWidth,
    originalHeight,
    modelWidth,
    modelHeight,
    scaledWidth,
    scaledHeight,
    paddingTop,
    paddingRight: modelWidth - scaledWidth - paddingLeft,
    paddingBottom: modelHeight - scaledHeight - paddingTop,
    paddingLeft,
    scale,
  };
}

export function extractOriginalROI(source: CanvasImageSource, roi: ROI): ImageData {
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(roi.width)), Math.max(1, Math.round(roi.height)));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("AI ROI canvas is unavailable.");
  context.drawImage(source, roi.x, roi.y, roi.width, roi.height, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export function extractROI(
  source: CanvasImageSource,
  roi: ROI,
  modelWidth = 512,
  modelHeight = modelWidth,
): { imageData: ImageData; transform: ROITransform } {
  const transform = createROITransform(roi.width, roi.height, modelWidth, modelHeight);
  const canvas = new OffscreenCanvas(modelWidth, modelHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("AI ROI canvas is unavailable.");
  context.clearRect(0, 0, modelWidth, modelHeight);
  context.drawImage(
    source,
    roi.x,
    roi.y,
    roi.width,
    roi.height,
    transform.paddingLeft,
    transform.paddingTop,
    transform.scaledWidth,
    transform.scaledHeight,
  );
  return { imageData: context.getImageData(0, 0, modelWidth, modelHeight), transform };
}

export function restoreROI(modelOutput: ImageData, transform: ROITransform): ImageData {
  const source = new OffscreenCanvas(transform.modelWidth, transform.modelHeight);
  source.getContext("2d")!.putImageData(modelOutput, 0, 0);
  const restored = new OffscreenCanvas(transform.originalWidth, transform.originalHeight);
  const context = restored.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("AI ROI restore canvas is unavailable.");
  context.drawImage(
    source,
    transform.paddingLeft,
    transform.paddingTop,
    transform.scaledWidth,
    transform.scaledHeight,
    0,
    0,
    transform.originalWidth,
    transform.originalHeight,
  );
  return context.getImageData(0, 0, transform.originalWidth, transform.originalHeight);
}
