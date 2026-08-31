export type MediaKind = "video" | "audio" | "image" | "subtitle";
export type MediaStorageMode = "persisted" | "reference" | "session";

export interface VideoColorInfo {
  primaries?: string;
  transfer?: string;
  matrix?: string;
  range: "limited" | "full" | "unknown";
  pixelFormat?: string;
  bitDepth?: number;
  hdr?: boolean;
}

export interface AudioMediaInfo {
  sampleRate?: number;
  channels?: number;
  channelLayout?: string;
  bitrate?: number;
  codec?: string;
}

export interface MediaFingerprint {
  name: string;
  size: number;
  lastModified: number;
  signature: string;
  duration: number;
  width: number;
  height: number;
  frameRate?: number;
  videoCodec?: string;
  colorInfo?: VideoColorInfo;
  audioInfo?: AudioMediaInfo;
  partialHash?: {
    algorithm: "SHA-256";
    sampleOffsets: number[];
    sampleSizes: number[];
    digest: string;
  };
}
export type TrackKind = "video" | "audio" | "text" | "subtitle";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  crop: CropRect;
}

export type KeyframeProperty =
  | "x"
  | "y"
  | "scale"
  | "rotation"
  | "opacity"
  | "volume";

export interface PropertyKeyframe {
  id: string;
  time: number;
  property: KeyframeProperty;
  value: number;
  easing: "linear";
}

export interface TextStyle {
  fontFamily: "system-ui" | "serif" | "monospace";
  fontWeight: 400 | 500 | 600 | 700 | 800;
  italic: boolean;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  strokeColor: string;
  strokeWidth: number;
  shadowColor: string;
  shadowBlur: number;
  backgroundOpacity: number;
  padding: number;
  preset?: "title" | "subtitle" | "lower-third" | "caption" | "callout" | "end-card";
}

export interface MaskKeyframe {
  time: number;
  x: number;
  y: number;
  width: number;
  height: number;
  easing: "linear";
}

export interface WatermarkMask {
  id: string;
  shape: "rectangle" | "ellipse";
  method: "blur" | "pixelate" | "cover" | "clone" | "ai";
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
  feather: number;
  enabled: boolean;
  keyframes: MaskKeyframe[];
  ai?: {
    modelId: string;
    modelVersion: string;
    quality: "fast" | "balanced" | "high" | "maximum";
    provider: "auto" | "webgpu" | "wasm";
    roiPadding: number;
    maskExpansion: number;
    temporalWindow: number;
    consistencyStrength: number;
    blendingStrength: number;
    trackingMethod: "auto" | "template" | "manual";
    tracking?: Array<{ time: number; x: number; y: number; width: number; height: number; confidence?: number; method: "template" | "manual"; manual?: boolean }>;
    trackingIssues?: Array<{ start: number; end: number; minimumConfidence: number; reason: "low-confidence" | "tracking-lost" }>;
    trackingRange?: { start: number; end: number; completed: boolean };
  };
}

export interface MediaAssetRecord {
  id: string;
  projectId: string;
  name: string;
  kind: MediaKind;
  mime: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  frameRate?: number;
  videoCodec?: string;
  colorInfo?: VideoColorInfo;
  audioInfo?: AudioMediaInfo;
  createdAt: string;
  signature: string;
  nativeDecodable?: boolean;
  proxy?: {
    mime: string;
    size: number;
    width: number;
    height: number;
    fps?: number;
    duration?: number;
    sourceDuration?: number;
    quality?: "low" | "balanced" | "high";
    createdAt: string;
  };
  storageMode: MediaStorageMode;
  risk?: "normal" | "large" | "very-large";
  sourceLastModified?: number;
  fingerprint?: MediaFingerprint;
  fileHandle?: FileSystemFileHandle;
  offline?: boolean;
}

export interface RuntimeAsset extends MediaAssetRecord {
  blob?: Blob;
  url?: string;
  proxyBlob?: Blob;
  proxyUrl?: string;
}

export interface Clip {
  id: string;
  assetId?: string;
  trackId: string;
  kind: TrackKind;
  name: string;
  timelineStart: number;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  gain: number;
  opacity: number;
  transform: Transform;
  text?: string;
  fontSize?: number;
  color?: string;
  background?: string;
  textStyle?: TextStyle;
  fadeIn: number;
  fadeOut: number;
  keyframes: PropertyKeyframe[];
  watermarkMasks: WatermarkMask[];
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  index: number;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  visible: boolean;
  gain: number;
}

export interface SubtitleCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  snapping: boolean;
  snapSeconds: number;
  previewQuality: "full" | "half" | "quarter";
  masterGain: number;
  backgroundColor: string;
}

export interface VideoFlowProject {
  id: string;
  name: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
  tracks: Track[];
  clips: Clip[];
  subtitles: SubtitleCue[];
  settings: ProjectSettings;
}

export interface SnapshotRecord {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  revision: number;
  project: VideoFlowProject;
}

export interface ExportJob {
  id: string;
  name: string;
  filename: string;
  format: "webm" | "mp4" | "gif" | "wav" | "mp3" | "opus";
  status:
    | "waiting"
    | "preparing"
    | "rendering"
    | "ai-processing"
    | "muxing"
    | "validating"
    | "complete"
    | "failed"
    | "cancelled";
  phase: string;
  progress: number;
  createdAt: number;
  startedAt?: number;
  elapsed?: number;
  error?: string;
  url?: string;
  blob?: Blob;
  diskBacked?: boolean;
  fileSize?: number;
  segmentCount?: number;
  validation?: {
    duration: number;
    width?: number;
    height?: number;
    videoCodec?: string;
    audioCodec?: string;
    fps?: number;
    pixelFormat?: string;
    colorInfo?: VideoColorInfo;
    audioSampleRate?: number;
    audioChannels?: number;
    audioDuration?: number;
    exportMode?: "smart-copy" | "re-encode";
    hasVideo: boolean;
    hasAudio: boolean;
  };
}

export interface ExportSettings {
  preset:
    | "source"
    | "match-first-clip"
    | "480p"
    | "720p"
    | "1080p"
    | "1440p"
    | "2k-dci"
    | "4k-uhd"
    | "4k-dci"
    | "vertical-1080"
    | "vertical-1440"
    | "vertical-2160"
    | "instagram-square"
    | "instagram-portrait"
    | "youtube-4k"
    | "youtube-1080"
    | "youtube-720"
    | "youtube-shorts"
    | "instagram-reel"
    | "tiktok"
    | "high-quality"
    | "balanced"
    | "small"
    | "web-optimized"
    | "custom";
  format: ExportJob["format"];
  width: number;
  height: number;
  fps: number;
  fpsMode?: "source-project" | "custom";
  videoBitrate: number;
  audioBitrate: number;
  audioSampleRate: 0 | 44100 | 48000;
  audioMode?: "match-source" | "high" | "balanced" | "smaller" | "custom";
  qualityMode?: "smart-copy" | "visually-lossless" | "high" | "balanced" | "smaller" | "custom";
  colorMode?: "preserve" | "rec709-limited" | "rec709-full";
  hdrPolicy?: "preserve-compatible";
  sourceColorInfo?: VideoColorInfo;
  videoCodec: "h264" | "vp9" | "gif" | "none";
  audioCodec: "aac" | "opus" | "mp3" | "pcm" | "none";
  includeAudio: boolean;
  gifFps: number;
  gifWidth: number;
  aspectStrategy: "fit" | "fill" | "crop" | "blur";
  rangeStart?: number;
  rangeEnd?: number;
}

export interface DiagnosticEntry {
  timestamp: string;
  module: string;
  severity: "info" | "warning" | "error";
  message: string;
}
