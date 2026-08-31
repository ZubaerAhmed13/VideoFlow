export type AIProvider = "webgpu" | "wasm";
export type AIModelState = "not-installed" | "installing" | "installed" | "loading" | "ready" | "error";
export type AIQuality = "fast" | "balanced" | "high" | "maximum";
export type AIJobState = "waiting" | "preparing" | "loading-model" | "decoding" | "tracking" | "inference" | "temporal-pass" | "blending" | "encoding" | "complete" | "cancelled" | "failed";

export interface AIModelDescriptor {
  id: string;
  name: string;
  version: string;
  license: string;
  source: string;
  sha256: string;
  size: number;
  inputWidth: number;
  inputHeight: number;
  imageInput: string;
  maskInput: string;
  output: string;
}

export interface AISettings {
  provider: "auto" | AIProvider;
  quality: AIQuality;
  roiPadding: number;
  maskExpansion: number;
  feather: number;
  temporalWindow: number;
  consistencyStrength: number;
  blendingStrength: number;
  trackingMethod: "auto" | "template" | "manual";
}

export interface AIModelInstallRecord {
  descriptor: AIModelDescriptor;
  state: AIModelState;
  installedAt?: string;
  verifiedAt?: string;
  error?: string;
}

export interface ROI {
  x: number; y: number; width: number; height: number;
  sourceWidth: number; sourceHeight: number;
}

export interface ROITransform {
  originalWidth: number;
  originalHeight: number;
  modelWidth: number;
  modelHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  scale: number;
}

export interface AITileMetadata {
  roi: ROI;
  localX: number;
  localY: number;
  overlap: number;
  transform: ROITransform;
}

export interface TrackingPoint {
  time: number;
  x: number; y: number; width: number; height: number;
  confidence?: number;
  method: "template" | "manual";
  manual?: boolean;
}

export interface TrackingIssue {
  start: number;
  end: number;
  minimumConfidence: number;
  reason: "low-confidence" | "tracking-lost";
}

export interface AIJobProgress {
  id: string;
  state: AIJobState;
  progress: number;
  detail: string;
}

export interface AIFrameResult {
  imageData: ImageData;
  sourceROI: ImageData;
  provider: AIProvider;
  inferenceMs: number;
  roi: ROI;
  temporalConfidence?: number;
  temporalMethod?: "none" | "local-multiblock" | "translation-fallback";
  temporalPastFrames?: number;
  temporalFutureFrames?: number;
  tileCount: number;
  tiles: AITileMetadata[];
}
