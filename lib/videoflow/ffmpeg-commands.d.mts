export type CommandFormat = "webm" | "mp4" | "gif" | "wav" | "mp3" | "opus";
export const AUDIO_FREQUENCIES: number[];
export const FORMAT_INFO: Readonly<
  Record<CommandFormat, { extension: string; mime: string; kind: string }>
>;
export function atempoFilters(rate: number): string[];
export function buildTranscodeArgs(options?: {
  input?: string;
  output?: string;
  format?: CommandFormat;
  bitrate?: number;
  audioBitrate?: number;
  includeAudio?: boolean;
  gifFps?: number;
  gifWidth?: number;
}): string[];
export function buildProxyArgs(input?: string, output?: string, options?: { width?: number; height?: number; fps?: number; crf?: number }): string[];
export function buildStabilizeArgs(options?: {
  input?: string;
  output?: string;
  strength?: number;
  includeAudio?: boolean;
}): string[];
export function buildAudioProcessArgs(options?: {
  input?: string;
  output?: string;
  start?: number;
  end?: number;
  speed?: number;
  pitchSemitones?: number;
  gain?: number;
  reverse?: boolean;
  normalize?: boolean;
  equalizer?: number[];
}): string[];
