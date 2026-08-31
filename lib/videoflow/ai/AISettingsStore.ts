import type { AISettings } from "./types";

const KEY = "videoflow-ai-default-settings-v1";

export const BASE_AI_DEFAULTS: AISettings = {
  provider: "auto",
  quality: "balanced",
  roiPadding: 96,
  maskExpansion: 8,
  feather: 12,
  temporalWindow: 9,
  consistencyStrength: 0.18,
  blendingStrength: 0.85,
  trackingMethod: "auto",
};

export function loadAIDefaultSettings(): AISettings {
  if (typeof localStorage === "undefined") return { ...BASE_AI_DEFAULTS };
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AISettings> | null;
    return { ...BASE_AI_DEFAULTS, ...(parsed ?? {}) };
  } catch {
    return { ...BASE_AI_DEFAULTS };
  }
}

export function saveAIDefaultSettings(settings: AISettings): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(settings));
}

export function clearAIDefaultSettings(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY);
}
