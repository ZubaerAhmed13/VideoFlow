import type { ROI } from "../types";

type MaskGeometry = { x: number; y: number; width: number; height: number; shape: "rectangle" | "ellipse" };

type BoundaryStatistics = {
  meanY: number;
  meanCb: number;
  meanCr: number;
  deviationY: number;
  samples: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isBoundaryPixel(x: number, y: number, mask: MaskGeometry, roi: ROI, band: number): boolean {
  const mx = mask.x * roi.sourceWidth - roi.x;
  const my = mask.y * roi.sourceHeight - roi.y;
  const mw = mask.width * roi.sourceWidth;
  const mh = mask.height * roi.sourceHeight;
  if (mask.shape === "rectangle") {
    const inside = x >= mx && x <= mx + mw && y >= my && y <= my + mh;
    const expanded = x >= mx - band && x <= mx + mw + band && y >= my - band && y <= my + mh + band;
    return expanded && !inside;
  }
  const rx = Math.max(1, mw / 2);
  const ry = Math.max(1, mh / 2);
  const nx = (x - (mx + rx)) / rx;
  const ny = (y - (my + ry)) / ry;
  const radius = Math.sqrt(nx * nx + ny * ny);
  const normalizedBand = band / Math.max(1, Math.min(rx, ry));
  return radius >= 1 && radius <= 1 + normalizedBand;
}

function boundaryStatistics(image: ImageData, mask: MaskGeometry, roi: ROI, band: number): BoundaryStatistics {
  let sumY = 0;
  let sumCb = 0;
  let sumCr = 0;
  let sumY2 = 0;
  let samples = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!isBoundaryPixel(x, y, mask, roi, band)) continue;
      const index = (y * image.width + x) * 4;
      const r = image.data[index];
      const g = image.data[index + 1];
      const b = image.data[index + 2];
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      sumY += luminance;
      sumCb += b - luminance;
      sumCr += r - luminance;
      sumY2 += luminance * luminance;
      samples += 1;
    }
  }
  const meanY = samples ? sumY / samples : 0;
  return {
    meanY,
    meanCb: samples ? sumCb / samples : 0,
    meanCr: samples ? sumCr / samples : 0,
    deviationY: samples ? Math.sqrt(Math.max(0, sumY2 / samples - meanY * meanY)) : 0,
    samples,
  };
}

/**
 * Match the reconstructed patch to a narrow source band outside the mask.
 * Adjustments are deliberately capped to avoid a conspicuous global cast.
 */
export function matchPatchBoundary(
  patch: ImageData,
  source: ImageData,
  mask: MaskGeometry,
  roi: ROI,
  band = 10,
): ImageData {
  if (patch.width !== source.width || patch.height !== source.height) return patch;
  const sourceStats = boundaryStatistics(source, mask, roi, band);
  const patchStats = boundaryStatistics(patch, mask, roi, band);
  if (sourceStats.samples < 12 || patchStats.samples < 12) return patch;
  const luminanceShift = clamp(sourceStats.meanY - patchStats.meanY, -18, 18);
  const chromaBlueShift = clamp(sourceStats.meanCb - patchStats.meanCb, -12, 12);
  const chromaRedShift = clamp(sourceStats.meanCr - patchStats.meanCr, -12, 12);
  const contrast = clamp(sourceStats.deviationY / Math.max(1, patchStats.deviationY), 0.9, 1.1);
  const output = new ImageData(new Uint8ClampedArray(patch.data), patch.width, patch.height);
  for (let index = 0; index < output.data.length; index += 4) {
    const r = patch.data[index];
    const g = patch.data[index + 1];
    const b = patch.data[index + 2];
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const adjustedY = patchStats.meanY + luminanceShift + (y - patchStats.meanY) * contrast;
    const adjustedCb = b - y + chromaBlueShift;
    const adjustedCr = r - y + chromaRedShift;
    const adjustedR = adjustedY + adjustedCr;
    const adjustedB = adjustedY + adjustedCb;
    const adjustedG = (adjustedY - adjustedR * 0.2126 - adjustedB * 0.0722) / 0.7152;
    output.data[index] = clamp(adjustedR, 0, 255);
    output.data[index + 1] = clamp(adjustedG, 0, 255);
    output.data[index + 2] = clamp(adjustedB, 0, 255);
    output.data[index + 3] = 255;
  }
  return output;
}

export function compositeInpaintedROI(
  target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  patch: ImageData,
  roi: ROI,
  mask: MaskGeometry,
  feather = 12,
  opacity = 1,
): void {
  const width = Math.max(1, Math.round(roi.width));
  const height = Math.max(1, Math.round(roi.height));
  const layer = new OffscreenCanvas(width, height);
  const layerContext = layer.getContext("2d")!;
  const patchCanvas = new OffscreenCanvas(patch.width, patch.height);
  patchCanvas.getContext("2d")!.putImageData(patch, 0, 0);
  layerContext.drawImage(patchCanvas, 0, 0, patch.width, patch.height, 0, 0, width, height);

  const maskCanvas = new OffscreenCanvas(width, height);
  const maskContext = maskCanvas.getContext("2d")!;
  const mx = mask.x * roi.sourceWidth - roi.x;
  const my = mask.y * roi.sourceHeight - roi.y;
  const mw = mask.width * roi.sourceWidth;
  const mh = mask.height * roi.sourceHeight;
  const blur = Math.max(0, Math.min(48, feather));
  maskContext.save();
  maskContext.filter = blur ? `blur(${blur}px)` : "none";
  maskContext.fillStyle = "white";
  if (mask.shape === "ellipse") {
    maskContext.beginPath();
    maskContext.ellipse(mx + mw / 2, my + mh / 2, Math.max(1, mw / 2), Math.max(1, mh / 2), 0, 0, Math.PI * 2);
    maskContext.fill();
  } else {
    maskContext.fillRect(mx, my, mw, mh);
  }
  maskContext.restore();

  layerContext.globalCompositeOperation = "destination-in";
  layerContext.drawImage(maskCanvas, 0, 0);
  layerContext.globalCompositeOperation = "source-over";
  target.save();
  target.globalAlpha = Math.max(0, Math.min(1, opacity));
  target.drawImage(layer, roi.x, roi.y, roi.width, roi.height);
  target.restore();
}
