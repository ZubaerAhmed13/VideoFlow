import type { AIQuality, AITileMetadata, ROI, ROITransform } from "../types";

export interface PlannedTile {
  roi: ROI;
  localX: number;
  localY: number;
  overlap: number;
}

const STRATEGY: Record<AIQuality, { threshold: number; span: number; overlap: number }> = {
  fast: { threshold: 896, span: 768, overlap: 48 },
  balanced: { threshold: 704, span: 640, overlap: 64 },
  high: { threshold: 576, span: 512, overlap: 72 },
  maximum: { threshold: 512, span: 448, overlap: 96 },
};

function starts(length: number, span: number, overlap: number): number[] {
  if (length <= span) return [0];
  const result: number[] = [];
  const step = Math.max(1, span - overlap);
  for (let value = 0; value < length; value += step) {
    const start = Math.min(value, length - span);
    if (result.at(-1) !== start) result.push(start);
    if (start + span >= length) break;
  }
  return result;
}

export function planROITiles(roi: ROI, quality: AIQuality): PlannedTile[] {
  const strategy = STRATEGY[quality];
  const needsTiles = Math.max(roi.width, roi.height) > strategy.threshold || roi.width * roi.height > strategy.threshold ** 2 * 1.5;
  if (!needsTiles) return [{ roi, localX: 0, localY: 0, overlap: 0 }];
  const xs = starts(roi.width, strategy.span, strategy.overlap);
  const ys = starts(roi.height, strategy.span, strategy.overlap);
  return ys.flatMap((localY) => xs.map((localX) => ({
    localX,
    localY,
    overlap: strategy.overlap,
    roi: {
      x: roi.x + localX,
      y: roi.y + localY,
      width: Math.min(strategy.span, roi.width - localX),
      height: Math.min(strategy.span, roi.height - localY),
      sourceWidth: roi.sourceWidth,
      sourceHeight: roi.sourceHeight,
    },
  })));
}

function edgeWeight(position: number, length: number, overlap: number, touchesStart: boolean, touchesEnd: boolean): number {
  if (overlap <= 0) return 1;
  let weight = 1;
  if (!touchesStart && position < overlap) weight *= 0.5 - 0.5 * Math.cos(Math.PI * position / overlap);
  const fromEnd = length - 1 - position;
  if (!touchesEnd && fromEnd < overlap) weight *= 0.5 - 0.5 * Math.cos(Math.PI * fromEnd / overlap);
  return Math.max(0.001, weight);
}

export function blendTiles(
  roi: ROI,
  tiles: Array<{ plan: PlannedTile; imageData: ImageData; transform: ROITransform }>,
): { imageData: ImageData; metadata: AITileMetadata[] } {
  const width = Math.max(1, Math.round(roi.width));
  const height = Math.max(1, Math.round(roi.height));
  const sums = new Float32Array(width * height * 4);
  const weights = new Float32Array(width * height);
  for (const tile of tiles) {
    const tileWidth = tile.imageData.width;
    const tileHeight = tile.imageData.height;
    for (let y = 0; y < tileHeight; y += 1) {
      const targetY = tile.plan.localY + y;
      if (targetY >= height) continue;
      const wy = edgeWeight(y, tileHeight, tile.plan.overlap, tile.plan.localY === 0, tile.plan.localY + tileHeight >= height);
      for (let x = 0; x < tileWidth; x += 1) {
        const targetX = tile.plan.localX + x;
        if (targetX >= width) continue;
        const wx = edgeWeight(x, tileWidth, tile.plan.overlap, tile.plan.localX === 0, tile.plan.localX + tileWidth >= width);
        const weight = wx * wy;
        const source = (y * tileWidth + x) * 4;
        const targetPixel = targetY * width + targetX;
        const target = targetPixel * 4;
        sums[target] += tile.imageData.data[source] * weight;
        sums[target + 1] += tile.imageData.data[source + 1] * weight;
        sums[target + 2] += tile.imageData.data[source + 2] * weight;
        sums[target + 3] += 255 * weight;
        weights[targetPixel] += weight;
      }
    }
  }
  const output = new ImageData(width, height);
  for (let pixel = 0; pixel < weights.length; pixel += 1) {
    const weight = Math.max(0.001, weights[pixel]);
    const index = pixel * 4;
    output.data[index] = sums[index] / weight;
    output.data[index + 1] = sums[index + 1] / weight;
    output.data[index + 2] = sums[index + 2] / weight;
    output.data[index + 3] = 255;
  }
  return {
    imageData: output,
    metadata: tiles.map(({ plan, transform }) => ({ roi: plan.roi, localX: plan.localX, localY: plan.localY, overlap: plan.overlap, transform })),
  };
}
