import type { ExportSettings, RuntimeAsset, VideoColorInfo, VideoFlowProject } from "./types";

export const RESOLUTION_PRESETS: Readonly<Record<string, { width: number; height: number }>>;
export const FPS_PRESETS: Readonly<Record<string, number>>;
export function parseFrameRate(value: string | number | undefined): number | undefined;
export function frameRatesMatch(actual: number | undefined, expected: number | undefined, tolerance?: number): boolean;
export function videoColorInfoFromStream(stream?: Record<string, unknown>): VideoColorInfo | undefined;
export function describeColor(info?: VideoColorInfo): string;
export function colorMetadataArgs(info?: VideoColorInfo): string[];
export function finalSdrPixelFilter(info?: VideoColorInfo): string;
export function recommendedVideoBitrate(width: number, height: number, fps: number, codec?: string, quality?: string): number;
export function encodingPolicy(settings: Partial<ExportSettings>): { mode: "crf" | "bitrate"; crf?: number; bitrate?: number; preset?: string };
export function assessSmartCopy(project: VideoFlowProject, assets: RuntimeAsset[], settings: ExportSettings): { eligible: boolean; reason: string; asset?: RuntimeAsset; clip?: VideoFlowProject["clips"][number] };
