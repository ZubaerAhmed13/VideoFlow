import {
  estimateLocalMotionField,
  warpImageWithMotionField,
  type LocalMotionField,
} from "./MotionEstimator";

export interface TemporalFrame {
  source: ImageData;
  reconstruction: ImageData;
  index?: number;
  time?: number;
}

export interface TemporalNeighborhood {
  past: TemporalFrame[];
  future: TemporalFrame[];
}

/** A generic bounded window used by long-video processing without full-video retention. */
export class SlidingTemporalWindow<T> {
  private readonly frames = new Map<number, T>();

  constructor(private readonly radius: number) {}

  set(index: number, value: T): void {
    this.frames.set(index, value);
  }

  get(index: number): T | undefined {
    return this.frames.get(index);
  }

  discardBefore(targetIndex: number): void {
    const oldest = targetIndex - this.radius;
    for (const index of this.frames.keys()) if (index < oldest) this.frames.delete(index);
  }

  clear(): void {
    this.frames.clear();
  }

  get size(): number {
    return this.frames.size;
  }
}

/** Compatibility container for callers that only provide reconstructed history. */
export class TemporalContext {
  private readonly frames: TemporalFrame[] = [];
  constructor(private readonly windowSize: number) {}

  push(source: ImageData, reconstruction: ImageData): void {
    this.frames.push({ source, reconstruction });
    const keep = Math.max(1, Math.floor(this.windowSize / 2));
    while (this.frames.length > keep) this.frames.shift();
  }

  history(): TemporalFrame[] {
    return [...this.frames];
  }

  clear(): void {
    this.frames.length = 0;
  }
}

export interface TemporalBlendResult {
  imageData: ImageData;
  motion: LocalMotionField[];
  confidence: number;
  method: "none" | "local-multiblock" | "translation-fallback";
  pastFrames: number;
  futureFrames: number;
}

function compatible(current: ImageData, frame: TemporalFrame): boolean {
  return frame.source.width === current.width && frame.source.height === current.height &&
    frame.reconstruction.width === current.width && frame.reconstruction.height === current.height;
}

/**
 * Blend motion-aligned reconstructed past and future frames. Pixel disagreement
 * attenuates the temporal weight so fast motion does not create ghost trails.
 */
export function blendBidirectionalContext(
  current: ImageData,
  currentSource: ImageData,
  neighborhood: TemporalNeighborhood,
  strength: number,
): TemporalBlendResult {
  const past = neighborhood.past.filter((frame) => compatible(current, frame));
  const future = neighborhood.future.filter((frame) => compatible(current, frame));
  const context = [
    ...past.map((frame, index) => ({ frame, direction: "past" as const, distance: past.length - index })),
    ...future.map((frame, index) => ({ frame, direction: "future" as const, distance: index + 1 })),
  ];
  if (!context.length || strength <= 0) {
    return { imageData: current, motion: [], confidence: context.length ? 1 : 0, method: "none", pastFrames: past.length, futureFrames: future.length };
  }

  const motion: LocalMotionField[] = [];
  const aligned = context.map(({ frame, distance, direction }) => {
    const field = estimateLocalMotionField(frame.source, currentSource, 20, 3, 3);
    motion.push(field);
    return {
      image: warpImageWithMotionField(frame.reconstruction, field),
      field,
      weight: Math.max(0.01, field.confidence) / Math.max(1, distance) * (direction === "future" ? 0.96 : 1),
    };
  });

  const alpha = Math.max(0, Math.min(0.58, strength));
  const output = new ImageData(current.width, current.height);
  for (let index = 0; index < current.data.length; index += 4) {
    let weightSum = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const candidate of aligned) {
      if (candidate.image.data[index + 3] === 0 || candidate.field.confidence < 0.12) continue;
      const disagreement = (
        Math.abs(candidate.image.data[index] - current.data[index]) +
        Math.abs(candidate.image.data[index + 1] - current.data[index + 1]) +
        Math.abs(candidate.image.data[index + 2] - current.data[index + 2])
      ) / 3;
      const agreementWeight = disagreement <= 24 ? 1 : disagreement >= 96 ? 0.04 : 1 - (disagreement - 24) / 75;
      const weight = candidate.weight * agreementWeight;
      weightSum += weight;
      r += candidate.image.data[index] * weight;
      g += candidate.image.data[index + 1] * weight;
      b += candidate.image.data[index + 2] * weight;
    }
    const confidenceAlpha = alpha * Math.min(1, weightSum);
    if (weightSum > 0.001) {
      output.data[index] = current.data[index] * (1 - confidenceAlpha) + (r / weightSum) * confidenceAlpha;
      output.data[index + 1] = current.data[index + 1] * (1 - confidenceAlpha) + (g / weightSum) * confidenceAlpha;
      output.data[index + 2] = current.data[index + 2] * (1 - confidenceAlpha) + (b / weightSum) * confidenceAlpha;
    } else {
      output.data[index] = current.data[index];
      output.data[index + 1] = current.data[index + 1];
      output.data[index + 2] = current.data[index + 2];
    }
    output.data[index + 3] = 255;
  }
  const confidence = motion.reduce((sum, field) => sum + field.confidence, 0) / Math.max(1, motion.length);
  return {
    imageData: output,
    motion,
    confidence,
    method: motion.some((field) => field.method === "local-multiblock") ? "local-multiblock" : "translation-fallback",
    pastFrames: past.length,
    futureFrames: future.length,
  };
}

export function blendMotionCompensatedHistory(
  current: ImageData,
  currentSource: ImageData,
  history: TemporalFrame[],
  strength: number,
): TemporalBlendResult {
  return blendBidirectionalContext(current, currentSource, { past: history, future: [] }, strength);
}
