import { videoFlowResources } from "../resource-manager";
import { runImageInpainting } from "./AIInferenceEngine";
import { buildModelMask } from "./inpainting/MaskProcessor";
import { extractOriginalROI, extractROI, normalizedMaskToROI, restoreROI } from "./inpainting/ROIPreprocessor";
import { blendTiles, planROITiles } from "./inpainting/TiledInference";
import { matchPatchBoundary } from "./inpainting/InpaintPostprocessor";
import { blendBidirectionalContext, type TemporalFrame, type TemporalNeighborhood } from "./temporal/TemporalContext";
import type { AIFrameResult, AIInferencePurpose, AISettings } from "./types";
import { updateAIDiagnostics } from "./AIDiagnostics";

export const DEFAULT_AI_SETTINGS: AISettings = { provider: "auto", quality: "balanced", roiPadding: 96, maskExpansion: 8, feather: 12, temporalWindow: 9, consistencyStrength: 0.18, blendingStrength: 0.85, trackingMethod: "auto" };

function oddWithin(value: number, minimum: number, maximum: number): number {
  const bounded = Math.max(minimum, Math.min(maximum, Math.round(value)));
  return bounded % 2 === 0 ? Math.min(maximum, bounded + 1) : bounded;
}

export function effectiveAISettings(settings: AISettings): AISettings {
  const maximumWindow = typeof navigator !== "undefined" && Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) >= 8 ? 17 : 15;
  const presets = {
    fast: { roiPadding: Math.min(settings.roiPadding, 72), maskExpansion: Math.min(settings.maskExpansion, 6), temporalWindow: oddWithin(settings.temporalWindow, 3, 5), consistencyStrength: Math.min(settings.consistencyStrength, 0.1), blendingStrength: Math.min(settings.blendingStrength, 0.82) },
    balanced: { temporalWindow: oddWithin(settings.temporalWindow, 7, 9) },
    high: { roiPadding: Math.max(settings.roiPadding, 128), maskExpansion: Math.max(settings.maskExpansion, 10), temporalWindow: oddWithin(settings.temporalWindow, 11, 15), consistencyStrength: Math.max(settings.consistencyStrength, 0.24), blendingStrength: Math.max(settings.blendingStrength, 0.88) },
    maximum: { roiPadding: Math.max(settings.roiPadding, 160), maskExpansion: Math.max(settings.maskExpansion, 12), temporalWindow: oddWithin(settings.temporalWindow, 15, maximumWindow), consistencyStrength: Math.max(settings.consistencyStrength, 0.32), blendingStrength: Math.max(settings.blendingStrength, 0.92) },
  } as const;
  return { ...settings, ...presets[settings.quality] };
}

export async function reconstructFrame(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  mask: { x: number; y: number; width: number; height: number; shape: "rectangle" | "ellipse" },
  settings: AISettings = DEFAULT_AI_SETTINGS,
  context?: TemporalNeighborhood | TemporalFrame[] | null,
  signal?: AbortSignal,
  inferenceSize: 256 | 512 = 512,
  purpose: AIInferencePurpose = "production",
): Promise<AIFrameResult> {
  const effective = effectiveAISettings(settings);
  if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");
  return videoFlowResources.run("ai", async () => {
    const roi = normalizedMaskToROI(mask, sourceWidth, sourceHeight, effective.roiPadding);
    const sourceROI = extractOriginalROI(source, roi);
    const plans = planROITiles(roi, effective.quality);
    const processed = [];
    let provider: AIFrameResult["provider"] = "wasm";
    let inferenceMs = 0;
    for (const plan of plans) {
      if (signal?.aborted) throw new DOMException("AI reconstruction cancelled.", "AbortError");
      const prepared = extractROI(source, plan.roi, inferenceSize, inferenceSize);
      const modelMask = buildModelMask(mask, plan.roi, prepared.transform, effective.maskExpansion);
      const result = await runImageInpainting(prepared.imageData, modelMask, effective, signal, purpose);
      provider = result.provider;
      inferenceMs += result.inferenceMs;
      processed.push({ plan, imageData: restoreROI(result.imageData, prepared.transform), transform: prepared.transform });
    }
    const tiled = blendTiles(roi, processed);
    const matched = matchPatchBoundary(tiled.imageData, sourceROI, mask, roi, Math.max(6, Math.min(18, effective.feather)));
    const neighborhood: TemporalNeighborhood = Array.isArray(context)
      ? { past: context, future: [] }
      : (context ?? { past: [], future: [] });
    const temporal = blendBidirectionalContext(matched, sourceROI, neighborhood, effective.consistencyStrength);
    updateAIDiagnostics({
      provider,
      inferenceROI: `${Math.round(roi.width)}×${Math.round(roi.height)}`,
      temporalWindow: effective.temporalWindow,
      temporalContext: `${temporal.pastFrames} past + ${temporal.futureFrames} future • ${temporal.method}`,
      tileCount: tiled.metadata.length,
      recentInferenceMs: inferenceMs,
    });
    return {
      imageData: temporal.imageData,
      sourceROI,
      provider,
      inferenceMs,
      roi,
      temporalConfidence: temporal.confidence,
      temporalMethod: temporal.method,
      temporalPastFrames: temporal.pastFrames,
      temporalFutureFrames: temporal.futureFrames,
      tileCount: tiled.metadata.length,
      tiles: tiled.metadata,
    };
  });
}
