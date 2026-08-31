export interface MotionVector {
  dx: number;
  dy: number;
  confidence: number;
  normalizedError: number;
}

export interface LocalMotionVector extends MotionVector {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocalMotionField {
  vectors: LocalMotionVector[];
  columns: number;
  rows: number;
  confidence: number;
  method: "local-multiblock" | "translation-fallback";
}

function luminance(data: Uint8ClampedArray, index: number): number {
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function translationError(
  previous: ImageData,
  current: ImageData,
  dx: number,
  dy: number,
  stride: number,
): { error: number; samples: number } {
  const width = current.width;
  const height = current.height;
  const margin = Math.max(Math.abs(dx), Math.abs(dy), 4);
  let error = 0;
  let samples = 0;
  for (let y = margin; y < height - margin; y += stride) {
    const py = y - dy;
    if (py < 0 || py >= height) continue;
    for (let x = margin; x < width - margin; x += stride) {
      const px = x - dx;
      if (px < 0 || px >= width) continue;
      const ci = (y * width + x) * 4;
      const pi = (py * width + px) * 4;
      error += Math.abs(luminance(current.data, ci) - luminance(previous.data, pi));
      samples += 1;
    }
  }
  return { error: samples ? error / samples : Number.POSITIVE_INFINITY, samples };
}

function regionTranslationError(
  previous: ImageData,
  current: ImageData,
  region: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
  stride: number,
): number {
  let error = 0;
  let samples = 0;
  const xEnd = Math.min(current.width, region.x + region.width);
  const yEnd = Math.min(current.height, region.y + region.height);
  for (let y = region.y; y < yEnd; y += stride) {
    const py = y - dy;
    if (py < 0 || py >= previous.height) continue;
    for (let x = region.x; x < xEnd; x += stride) {
      const px = x - dx;
      if (px < 0 || px >= previous.width) continue;
      error += Math.abs(luminance(current.data, (y * current.width + x) * 4) - luminance(previous.data, (py * previous.width + px) * 4));
      samples += 1;
    }
  }
  return samples ? error / samples : Number.POSITIVE_INFINITY;
}

/**
 * Estimate global ROI translation between adjacent source frames using
 * coarse-to-fine luminance block matching. This is intentionally named
 * translation estimation rather than optical flow: it measures real motion,
 * but does not claim a dense per-pixel flow field.
 */
export function estimateTranslation(
  previous: ImageData,
  current: ImageData,
  maxShift = 24,
): MotionVector {
  if (previous.width !== current.width || previous.height !== current.height) {
    return { dx: 0, dy: 0, confidence: 0, normalizedError: 1 };
  }
  const candidates: Array<{ dx: number; dy: number; error: number }> = [];
  let best = { dx: 0, dy: 0, error: Number.POSITIVE_INFINITY };
  const coarseStep = Math.max(2, Math.round(maxShift / 6));
  for (let dy = -maxShift; dy <= maxShift; dy += coarseStep) {
    for (let dx = -maxShift; dx <= maxShift; dx += coarseStep) {
      const result = translationError(previous, current, dx, dy, 8);
      const candidate = { dx, dy, error: result.error };
      candidates.push(candidate);
      if (candidate.error < best.error) best = candidate;
    }
  }
  const refineRadius = coarseStep;
  for (let dy = best.dy - refineRadius; dy <= best.dy + refineRadius; dy += 1) {
    if (Math.abs(dy) > maxShift) continue;
    for (let dx = best.dx - refineRadius; dx <= best.dx + refineRadius; dx += 1) {
      if (Math.abs(dx) > maxShift) continue;
      const result = translationError(previous, current, dx, dy, 5);
      const candidate = { dx, dy, error: result.error };
      candidates.push(candidate);
      if (candidate.error < best.error) best = candidate;
    }
  }
  const sorted = candidates.sort((a, b) => a.error - b.error);
  const second = sorted.find((candidate) => candidate.dx !== best.dx || candidate.dy !== best.dy);
  const normalizedError = Math.max(0, Math.min(1, best.error / 64));
  const separation = second && Number.isFinite(second.error)
    ? Math.max(0, Math.min(1, (second.error - best.error) / Math.max(1, second.error)))
    : 0;
  const confidence = Math.max(0, Math.min(1, (1 - normalizedError) * 0.7 + separation * 0.3));
  return { dx: best.dx, dy: best.dy, confidence, normalizedError };
}

/**
 * Region-aware multi-block motion estimation. This is a sparse local motion
 * field, not dense optical flow. It is intentionally named honestly and falls
 * back to ROI translation when a block has insufficient texture.
 */
export function estimateLocalMotionField(
  previous: ImageData,
  current: ImageData,
  maxShift = 24,
  columns = 3,
  rows = 3,
): LocalMotionField {
  const fallback = estimateTranslation(previous, current, maxShift);
  if (previous.width !== current.width || previous.height !== current.height || previous.width < 24 || previous.height < 24) {
    return {
      columns: 1,
      rows: 1,
      confidence: fallback.confidence,
      method: "translation-fallback",
      vectors: [{ ...fallback, x: 0, y: 0, width: current.width, height: current.height }],
    };
  }
  const vectors: LocalMotionVector[] = [];
  const blockWidth = Math.ceil(current.width / columns);
  const blockHeight = Math.ceil(current.height / rows);
  const searchStep = Math.max(2, Math.round(maxShift / 6));
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const region = {
        x: column * blockWidth,
        y: row * blockHeight,
        width: Math.min(blockWidth, current.width - column * blockWidth),
        height: Math.min(blockHeight, current.height - row * blockHeight),
      };
      let best = { dx: fallback.dx, dy: fallback.dy, error: Number.POSITIVE_INFINITY };
      const candidates: Array<{ dx: number; dy: number; error: number }> = [];
      const searchMinimumY = Math.max(-maxShift, fallback.dy - Math.ceil(maxShift / 2));
      const searchMaximumY = Math.min(maxShift, fallback.dy + Math.ceil(maxShift / 2));
      const searchMinimumX = Math.max(-maxShift, fallback.dx - Math.ceil(maxShift / 2));
      const searchMaximumX = Math.min(maxShift, fallback.dx + Math.ceil(maxShift / 2));
      for (let dy = searchMinimumY; dy <= searchMaximumY; dy += searchStep) {
        for (let dx = searchMinimumX; dx <= searchMaximumX; dx += searchStep) {
          const error = regionTranslationError(previous, current, region, dx, dy, 6);
          candidates.push({ dx, dy, error });
          if (error < best.error) best = { dx, dy, error };
        }
      }
      for (let dy = best.dy - searchStep; dy <= best.dy + searchStep; dy += 1) {
        for (let dx = best.dx - searchStep; dx <= best.dx + searchStep; dx += 1) {
          const error = regionTranslationError(previous, current, region, dx, dy, 4);
          candidates.push({ dx, dy, error });
          if (error < best.error) best = { dx, dy, error };
        }
      }
      candidates.sort((a, b) => a.error - b.error);
      const second = candidates.find((candidate) => candidate.dx !== best.dx || candidate.dy !== best.dy);
      const normalizedError = clamp01(best.error / 64);
      const separation = second ? clamp01((second.error - best.error) / Math.max(1, second.error)) : 0;
      const confidence = clamp01((1 - normalizedError) * 0.75 + separation * 0.25);
      vectors.push({ ...region, dx: best.dx, dy: best.dy, confidence, normalizedError });
    }
  }
  const reliable = vectors.filter((vector) => vector.confidence >= 0.12);
  if (reliable.length < Math.ceil(vectors.length / 3)) {
    return {
      columns: 1,
      rows: 1,
      confidence: fallback.confidence,
      method: "translation-fallback",
      vectors: [{ ...fallback, x: 0, y: 0, width: current.width, height: current.height }],
    };
  }
  return {
    vectors,
    columns,
    rows,
    confidence: reliable.reduce((sum, vector) => sum + vector.confidence, 0) / reliable.length,
    method: "local-multiblock",
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function warpImageWithMotionField(image: ImageData, field: LocalMotionField): ImageData {
  if (field.method === "translation-fallback") {
    const vector = field.vectors[0];
    return translateImage(image, vector.dx, vector.dy);
  }
  const output = new ImageData(image.width, image.height);
  for (const vector of field.vectors) {
    const xEnd = Math.min(image.width, vector.x + vector.width);
    const yEnd = Math.min(image.height, vector.y + vector.height);
    for (let y = vector.y; y < yEnd; y += 1) {
      const sourceY = Math.round(y - vector.dy);
      if (sourceY < 0 || sourceY >= image.height) continue;
      for (let x = vector.x; x < xEnd; x += 1) {
        const sourceX = Math.round(x - vector.dx);
        if (sourceX < 0 || sourceX >= image.width) continue;
        const sourceIndex = (sourceY * image.width + sourceX) * 4;
        const targetIndex = (y * image.width + x) * 4;
        output.data[targetIndex] = image.data[sourceIndex];
        output.data[targetIndex + 1] = image.data[sourceIndex + 1];
        output.data[targetIndex + 2] = image.data[sourceIndex + 2];
        output.data[targetIndex + 3] = image.data[sourceIndex + 3] || 255;
      }
    }
  }
  return output;
}

export function translateImage(image: ImageData, dx: number, dy: number): ImageData {
  const out = new ImageData(image.width, image.height);
  const width = image.width;
  const height = image.height;
  for (let y = 0; y < height; y += 1) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const sx = x - dx;
      if (sx < 0 || sx >= width) continue;
      const source = (sy * width + sx) * 4;
      const target = (y * width + x) * 4;
      out.data[target] = image.data[source];
      out.data[target + 1] = image.data[source + 1];
      out.data[target + 2] = image.data[source + 2];
      out.data[target + 3] = image.data[source + 3] || 255;
    }
  }
  return out;
}
