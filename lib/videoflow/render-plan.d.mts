import type { Clip, ExportSettings, VideoFlowProject } from "./types";

export type PlannedClip = Clip & {
  duration: number;
  trackGain: number;
  zIndex: number;
  renderAssetId: string;
  sourceKind: "video" | "audio" | "image" | "text" | "subtitle";
};

export const RENDER_PLAN_VERSION: number;
export function linearExpression(
  keyframes: Array<{ property: string; time: number; value: number }>,
  property: string,
  fallback: number,
  timeVariable?: string,
): string;
export function createRenderPlan(
  project: VideoFlowProject,
  assets?: MediaAssetRecord[],
): {
  version: number;
  projectId: string;
  revision: number;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  backgroundColor: string;
  masterGain: number;
  sources: string[];
  visualClips: PlannedClip[];
  audioClips: PlannedClip[];
};
export function buildDeterministicRenderArgs(options: {
  plan: ReturnType<typeof createRenderPlan>;
  inputs: Array<{
    id: string;
    filename: string;
    kind: string;
    hasVideo: boolean;
    hasAudio: boolean;
  }>;
  output: string;
  settings: ExportSettings;
}): { args: string[]; filterComplex: string; plan: ReturnType<typeof createRenderPlan> };
