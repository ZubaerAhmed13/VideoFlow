"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, Cpu, LoaderCircle, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resolveWatermarkMask } from "@/lib/videoflow/core.mjs";
import { DEFAULT_AI_SETTINGS, effectiveAISettings, reconstructFrame } from "@/lib/videoflow/ai/AIManager";
import { resetAIWorker } from "@/lib/videoflow/ai/AIWorkerClient";
import { compositeInpaintedROI } from "@/lib/videoflow/ai/inpainting/InpaintPostprocessor";
import { detectAICapability } from "@/lib/videoflow/ai/AICapability";
import { bundledAIModelAvailable, getAIModelRecord, installAIModel, installBundledAIModel, removeAIModel } from "@/lib/videoflow/ai/AIModelLoader";
import { DEFAULT_AI_MODEL } from "@/lib/videoflow/ai/AIModelRegistry";
import { installAIRuntime, removeAIRuntime, runtimeAvailability } from "@/lib/videoflow/ai/AIRuntimeInstaller";
import { trackTemplateWithWorker } from "@/lib/videoflow/ai/tracking/TrackingWorkerClient";
import { renderAIPreviewSegment } from "@/lib/videoflow/ai/VideoInpainter";
import type { AIQuality, AISettings, TrackingIssue, TrackingPoint } from "@/lib/videoflow/ai/types";
import { loadAIDefaultSettings } from "@/lib/videoflow/ai/AISettingsStore";
import type { Clip, RuntimeAsset, WatermarkMask } from "@/lib/videoflow/types";

const FRAME_DECODE_TIMEOUT_MS = 8_000;
const FRAME_CAPTURE_RETRIES = 4;
const FRAME_RETRY_DELAY_MS = 80;

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("AI job cancelled.", "AbortError");
}

function waitForFramePresentation(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("AI job cancelled.", "AbortError"));
  const frameVideo = video as VideoWithFrameCallback;
  return new Promise((resolve, reject) => {
    let timeout = 0;
    let raf = 0;
    let frameHandle: number | undefined;
    const cleanup = () => {
      if (timeout) window.clearTimeout(timeout);
      if (raf) window.cancelAnimationFrame(raf);
      if (frameHandle !== undefined) frameVideo.cancelVideoFrameCallback?.(frameHandle);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(new DOMException("AI job cancelled.", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(finish, FRAME_RETRY_DELAY_MS * 2);
    if (typeof frameVideo.requestVideoFrameCallback === "function")
      frameHandle = frameVideo.requestVideoFrameCallback(() => finish());
    else raf = window.requestAnimationFrame(() => finish());
  });
}

async function waitForDecodedVideoFrame(video: HTMLVideoElement, target: number, signal?: AbortSignal): Promise<void> {
  abortIfRequested(signal);
  const durationLimit = Number.isFinite(video.duration) && video.duration > 0
    ? Math.max(0, video.duration - 0.001)
    : Math.max(0, target);
  // Firefox can treat currentTime = 0 as a no-op before the first
  // Ogg/Theora frame is decoded. Nudge the decoder by one millisecond
  // only when the requested time already equals currentTime and no
  // decoded frame data exists yet. The captured frame remains the
  // source's first presentation frame and timeline timing is unchanged.
  const decodeTarget =
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA &&
    Math.abs(video.currentTime - target) <= 0.0005 &&
    durationLimit > 0
      ? Math.min(durationLimit, Math.max(0.001, target + 0.001))
      : target;
  const ready = () =>
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0 &&
    Math.abs(video.currentTime - decodeTarget) <= 0.05;
  if (!ready()) {
    await new Promise<void>((resolve, reject) => {
      let timeout = 0;
      const cleanup = () => {
        if (timeout) window.clearTimeout(timeout);
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("canplay", onReady);
        video.removeEventListener("seeked", onReady);
        video.removeEventListener("timeupdate", onReady);
        video.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = () => { cleanup(); resolve(); };
      const onReady = () => { if (ready()) finish(); };
      const onError = () => { cleanup(); reject(new Error("Could not decode the selected AI frame.")); };
      const onAbort = () => { cleanup(); reject(new DOMException("AI job cancelled.", "AbortError")); };
      timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while decoding the selected AI frame."));
      }, FRAME_DECODE_TIMEOUT_MS);
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("canplay", onReady);
      video.addEventListener("seeked", onReady);
      video.addEventListener("timeupdate", onReady);
      video.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (Math.abs(video.currentTime - decodeTarget) > 0.0005 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
video.currentTime = decodeTarget;
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      onReady();
    });
  }
  await waitForFramePresentation(video, signal);
}
async function frameAt(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
  abortIfRequested(signal);
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Math.max(0, time);
  const finalFrame = Math.max(0, duration - 0.001);
  const target = Math.max(0, Math.min(finalFrame, time));
  await waitForDecodedVideoFrame(video, target, signal);
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas frame capture is unavailable.");
  let lastError: unknown;
  for (let attempt = 0; attempt < FRAME_CAPTURE_RETRIES; attempt += 1) {
    abortIfRequested(signal);
    try {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return await createImageBitmap(canvas);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < FRAME_CAPTURE_RETRIES) {
        await waitForFramePresentation(video, signal);
        await new Promise<void>((resolve, reject) => {
          let timer = 0;
          const cleanup = () => {
            if (timer) window.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          };
          const finish = () => { cleanup(); resolve(); };
          const onAbort = () => {
            cleanup();
            reject(new DOMException("AI job cancelled.", "AbortError"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          timer = window.setTimeout(finish, FRAME_RETRY_DELAY_MS);
        });
      }
    }
  }
  throw new Error(`Could not capture the decoded AI frame after ${FRAME_CAPTURE_RETRIES} attempts: ${String(lastError)}`);
}
function maskSettings(mask: WatermarkMask): AISettings {
  return { ...DEFAULT_AI_SETTINGS, ...loadAIDefaultSettings(), ...(mask.ai ?? {}) } as AISettings;
}

function formatClock(time: number): string {
  const safe = Math.max(0, time);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  return hours ? [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":") : [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function mergeTracking(existing: TrackingPoint[] | undefined, incoming: TrackingPoint[], start: number, end: number): TrackingPoint[] {
  const outside = (existing ?? []).filter((point) => point.time < start - 0.001 || point.time > end + 0.001);
  const manual = (existing ?? []).filter((point) => point.manual && point.time >= start - 0.001 && point.time <= end + 0.001);
  const combined = [...outside, ...incoming.filter((point) => !manual.some((anchor) => Math.abs(anchor.time - point.time) < 0.001)), ...manual];
  return combined.sort((a, b) => a.time - b.time);
}

type StillPreview = { before: string; after: string };

export function AIWatermarkControls({ clip, mask, asset, playhead, updateMask, onReviewTime }: {
  clip: Clip;
  mask: WatermarkMask;
  asset?: RuntimeAsset;
  playhead: number;
  updateMask: (patch: Partial<WatermarkMask>, label?: string) => void;
  onReviewTime?: (time: number) => void;
}) {
  const modelInput = useRef<HTMLInputElement>(null);
  const runtimeInput = useRef<HTMLInputElement>(null);
  const jobController = useRef<AbortController | null>(null);
  const stillCache = useRef(new Map<string, StillPreview>());
  const segmentCache = useRef(new Map<string, string>());
  const [record, setRecord] = useState(() => getAIModelRecord());
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [bundledModel, setBundledModel] = useState(false);
  const [provider, setProvider] = useState("Checking…");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [stillPreview, setStillPreview] = useState<StillPreview | null>(null);
  const [segmentPreviewUrl, setSegmentPreviewUrl] = useState<string | null>(null);
  const [comparison, setComparison] = useState<"before" | "after" | "split">("after");
  const [error, setError] = useState<string | null>(null);
  const [rangeStart, setRangeStart] = useState(mask.start);
  const [rangeEnd, setRangeEnd] = useState(mask.end);
  const settings = useMemo(() => maskSettings(mask), [mask]);
  const sourceUrl = asset?.proxyUrl ?? asset?.url;

  useEffect(() => {
    void Promise.all([runtimeAvailability(), detectAICapability(), bundledAIModelAvailable()]).then(([runtime, capability, bundled]) => {
      setRuntimeReady(runtime.ready);
      setBundledModel(bundled);
      setProvider(capability.webgpu === "available" ? "WebGPU available" : `WASM fallback • WebGPU ${capability.webgpu}`);
    });
  }, []);

  useEffect(() => {
    const urls = segmentCache.current;
    return () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); };
  }, []);

  const patchAI = (patch: Partial<AISettings>) => updateMask({ ai: { modelId: DEFAULT_AI_MODEL.id, modelVersion: DEFAULT_AI_MODEL.version, ...settings, ...patch } }, "AI settings changed");

  const installModel = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError(null); setProgress("Validating model checksum…");
    try { setRecord(await installAIModel(file)); setProgress("Model installed locally and checksum verified."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const installBundled = async () => {
    setBusy(true); setError(null); setProgress("Validating bundled AI model…");
    try { setRecord(await installBundledAIModel()); setProgress("Bundled AI model installed locally and checksum verified."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const installRuntime = async (files?: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setError(null); setProgress("Installing local ONNX runtime…");
    try {
      const result = await installAIRuntime(files);
      const status = await runtimeAvailability(); setRuntimeReady(status.ready);
      setProgress(result.missing.length ? `Runtime partial: missing ${result.missing.join(", ")}.` : "Runtime installed locally.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const previewCurrent = async () => {
    if (!asset || !sourceUrl) { setError("Original/proxy media is offline. Relink it before AI preview."); return; }
    const cacheKey = JSON.stringify([asset.id, "still", playhead.toFixed(4), settings, mask.x, mask.y, mask.width, mask.height, mask.shape, mask.ai?.tracking]);
    const cached = stillCache.current.get(cacheKey);
    if (cached) { setStillPreview(cached); setSegmentPreviewUrl(null); setProgress("Reused unchanged AI preview cache."); return; }
    const controller = new AbortController(); jobController.current = controller;
    setBusy(true); setError(null); setProgress("Decoding current frame…");
    const video = document.createElement("video"); video.muted = true; video.preload = "auto"; video.src = sourceUrl;
    try {
      await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("Could not open media for AI preview.")); });
      const sourceTime = clip.sourceStart + Math.max(0, playhead - clip.timelineStart) * clip.speed;
      const bitmap = await frameAt(video, sourceTime, controller.signal);
      const resolved = resolveWatermarkMask(mask, playhead) as WatermarkMask;
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
      const before = canvas.toDataURL("image/jpeg", 0.92);
      setProgress("Running local ONNX inpainting…");
      const result = await reconstructFrame(bitmap, bitmap.width, bitmap.height, resolved, settings, null, controller.signal);
      const effective = effectiveAISettings(settings);
      compositeInpaintedROI(context, result.imageData, result.roi, resolved, effective.feather, effective.blendingStrength);
      const preview = { before, after: canvas.toDataURL("image/jpeg", 0.92) };
      bitmap.close();
      stillCache.current.set(cacheKey, preview);
      setStillPreview(preview);
      setSegmentPreviewUrl(null);
      setProgress(`${result.provider.toUpperCase()} inference • ${Math.round(result.inferenceMs)} ms • ROI ${result.roi.width}×${result.roi.height} • ${result.tileCount} tile${result.tileCount === 1 ? "" : "s"}`);
      updateMask({ method: "ai", ai: { modelId: DEFAULT_AI_MODEL.id, modelVersion: DEFAULT_AI_MODEL.version, ...settings } }, "AI reconstruction enabled");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") setProgress("AI preview cancelled; resources released.");
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (jobController.current === controller) jobController.current = null;
      setBusy(false); video.removeAttribute("src"); video.load();
    }
  };

  const previewSegment = async (seconds: number) => {
    if (!asset || !sourceUrl) { setError("Original/proxy media is offline. Relink it before AI preview."); return; }
    const start = Math.max(clip.timelineStart, Math.min(playhead, clip.timelineStart + Math.max(0, clip.sourceEnd - clip.sourceStart) / Math.max(0.01, clip.speed) - 0.1));
    const cacheKey = JSON.stringify([asset.id, "segment", seconds, start.toFixed(3), settings, mask, sourceUrl]);
    const cached = segmentCache.current.get(cacheKey);
    if (cached) { setSegmentPreviewUrl(cached); setStillPreview(null); setProgress(`Reused unchanged ${seconds}-second AI preview cache.`); return; }
    const controller = new AbortController(); jobController.current = controller;
    setBusy(true); setError(null); setProgress(`Preparing ${seconds}-second AI preview…`);
    try {
      const previewAsset: RuntimeAsset = {
        ...asset,
        url: sourceUrl,
        width: asset.proxy?.width ?? asset.width,
        height: asset.proxy?.height ?? asset.height,
      };
      const blob = await renderAIPreviewSegment(clip, mask, previewAsset, start, seconds, controller.signal, (value, phase) => setProgress(`${phase} • ${Math.round(value * 100)}%`));
      const url = URL.createObjectURL(blob);
      segmentCache.current.set(cacheKey, url);
      setSegmentPreviewUrl(url);
      setStillPreview(null);
      setProgress(`${seconds}-second AI preview ready • same tiled bidirectional pipeline as export.`);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") setProgress("AI preview cancelled; resources released.");
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally { if (jobController.current === controller) jobController.current = null; setBusy(false); }
  };

  const track = async (mode: "forward" | "backward" | "selected") => {
    if (!asset || !sourceUrl) { setError("Media is offline. Relink before tracking."); return; }
    const controller = new AbortController(); jobController.current = controller;
    setBusy(true); setError(null);
    const video = document.createElement("video"); video.muted = true; video.preload = "auto"; video.src = sourceUrl;
    try {
      await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("Could not decode media for tracking.")); });
      const anchor = Math.max(mask.start, Math.min(mask.end, playhead));
      const start = mode === "forward" ? anchor : mode === "backward" ? mask.start : Math.max(mask.start, Math.min(rangeStart, rangeEnd));
      const end = mode === "forward" ? mask.end : mode === "backward" ? anchor : Math.min(mask.end, Math.max(rangeStart, rangeEnd));
      if (end - start < 0.001) throw new Error("Selected tracking range is empty.");
      const trackingProfile = {
        fast: { step: 0.25, searchRadius: 24 },
        balanced: { step: 0.125, searchRadius: 32 },
        high: { step: 0.08, searchRadius: 40 },
        maximum: { step: 0.05, searchRadius: 48 },
      }[settings.quality];
      const step = trackingProfile.step;
      const times: number[] = [];
      if (mode === "backward") for (let time = end; time >= start - 1e-6; time -= step) times.push(Math.max(start, time));
      else for (let time = start; time <= end + 1e-6; time += step) times.push(Math.min(end, time));
      if (Math.abs(times.at(-1)! - (mode === "backward" ? start : end)) > 0.001) times.push(mode === "backward" ? start : end);
      const resolved = resolveWatermarkMask(mask, anchor) as WatermarkMask;
      const initial: TrackingPoint = { time: times[0], x: resolved.x, y: resolved.y, width: resolved.width, height: resolved.height, confidence: 1, method: "manual", manual: true };
      const result = await trackTemplateWithWorker(
        times,
        initial,
        async (timelineTime) => frameAt(video, clip.sourceStart + Math.max(0, timelineTime - clip.timelineStart) * clip.speed, controller.signal),
        {
          searchRadius: trackingProfile.searchRadius,
          signal: controller.signal,
          onProgress: ({ completed, total, time }) => setProgress(`Tracking ${formatClock(start)} → ${formatClock(end)} • ${Math.round(completed / total * 100)}% • ${formatClock(time)}`),
        },
      );
      const rangeMinimum = Math.min(start, end);
      const rangeMaximum = Math.max(start, end);
      const points = mergeTracking(mask.ai?.tracking, result.points, rangeMinimum, rangeMaximum);
      updateMask({
        ai: {
          modelId: DEFAULT_AI_MODEL.id,
          modelVersion: DEFAULT_AI_MODEL.version,
          ...settings,
          trackingMethod: "template",
          tracking: points,
          trackingIssues: result.issues,
          trackingRange: { start: rangeMinimum, end: rangeMaximum, completed: result.completed },
        },
      }, result.completed ? "Watermark tracked across range" : "Watermark tracking paused for correction");
      const average = result.points.reduce((sum, point) => sum + (point.confidence ?? 1), 0) / Math.max(1, result.points.length);
      setProgress(result.completed
        ? `Tracking complete • ${result.points.length} points • average confidence ${Math.round(average * 100)}%${result.issues.length ? ` • ${result.issues.length} range${result.issues.length === 1 ? "" : "s"} need review` : ""}`
        : `Tracking paused at ${formatClock(result.points.at(-1)?.time ?? anchor)} after confidence loss. Correct the mask, then re-track from this point.`);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") setProgress("Tracking cancelled; decoded frames released.");
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (jobController.current === controller) jobController.current = null;
      setBusy(false); video.removeAttribute("src"); video.load();
    }
  };

  const trackingIssues = (mask.ai?.trackingIssues ?? []) as TrackingIssue[];
  return <div className="vf-ai-panel">
    <div className="vf-ai-status"><Sparkles /><div><strong>AI Reconstruction</strong><span>{record.state === "not-installed" ? "Model not installed" : `${record.descriptor.name} • v${record.descriptor.version} • ${record.state}`}</span></div><b className={record.state === "installed" || record.state === "ready" ? "supported" : "limited"}>{runtimeReady ? provider : "Runtime pack required"}</b></div>
    <p className="vf-note">Local-only neural reconstruction. Use only on media you own or are authorized to modify. Reconstruction creates plausible pixels; it cannot recover permanently hidden originals.</p>
    {mask.ai?.modelVersion && mask.ai.modelVersion !== DEFAULT_AI_MODEL.version && <p className="vf-note vf-error">This project used AI model {mask.ai.modelVersion}; installed release model is {DEFAULT_AI_MODEL.version}. Preview before export because neural output can change between model versions.</p>}
    <input ref={modelInput} hidden type="file" accept=".onnx,application/octet-stream" onChange={(event) => void installModel(event.target.files?.[0])}/>
    <input ref={runtimeInput} hidden type="file" multiple accept=".mjs,.wasm,application/wasm,text/javascript" onChange={(event) => void installRuntime(event.target.files)}/>
    <div className="vf-button-grid">
      {bundledModel && record.state === "not-installed" && <Button size="sm" disabled={busy} onClick={() => void installBundled()}><Sparkles /> Install bundled AI</Button>}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => modelInput.current?.click()}><Upload /> Install model file</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => runtimeInput.current?.click()}><Cpu /> Install runtime</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void Promise.all([removeAIModel(), removeAIRuntime()]).then(() => { setRecord(getAIModelRecord()); setRuntimeReady(false); setProgress("AI model/runtime removed from local storage."); })}><Trash2 /> Remove AI</Button>
    </div>
    <div className="vf-mask-fields">
      <label>Quality<select value={settings.quality} onChange={(event) => patchAI({ quality: event.target.value as AIQuality })}><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="high">High</option><option value="maximum">Maximum</option></select></label>
      <label>Provider<select value={settings.provider} onChange={(event) => patchAI({ provider: event.target.value as AISettings["provider"] })}><option value="auto">Automatic</option><option value="webgpu">WebGPU</option><option value="wasm">WASM</option></select></label>
      <label>Temporal window<input type="number" min={3} max={17} step={2} value={settings.temporalWindow} onChange={(event) => patchAI({ temporalWindow: Math.max(3, Number(event.target.value) | 1) })}/></label>
      <label>ROI padding<input type="number" min={16} max={256} value={settings.roiPadding} onChange={(event) => patchAI({ roiPadding: Number(event.target.value) })}/></label>
    </div>
    <div className="vf-button-grid">
      <Button aria-label="Run AI preview" size="sm" disabled={busy || record.state === "not-installed" || !runtimeReady} onClick={() => void previewCurrent()}>{busy ? <LoaderCircle className="animate-spin"/> : <Sparkles/>} Current frame</Button>
      {[2, 5, 10].map((seconds) => <Button key={seconds} variant="outline" size="sm" disabled={busy || record.state === "not-installed" || !runtimeReady} onClick={() => void previewSegment(seconds)}>{seconds} sec</Button>)}
    </div>
    <div className="vf-button-grid">
      <Button variant="outline" size="sm" disabled={busy || !asset} onClick={() => void track("forward")}><Activity/> Track Forward to End</Button>
      <Button variant="outline" size="sm" disabled={busy || !asset} onClick={() => void track("backward")}><Activity/> Track Backward to Start</Button>
      <Button variant="outline" size="sm" disabled={busy || !asset} onClick={() => void track("selected")}><Activity/> Track Selected Range</Button>
      <Button variant="outline" size="sm" disabled={busy || !asset} onClick={() => void track("forward")}><Activity/> Re-track from this point</Button>
      {busy && <Button variant="destructive" size="sm" onClick={() => { jobController.current?.abort(); void resetAIWorker(); setProgress("Cancelling AI job…"); }}>Cancel AI Job</Button>}
    </div>
    <div className="vf-mask-fields">
      <label>Track from<input aria-label="Tracking range start" type="number" min={mask.start} max={mask.end} step={0.1} value={rangeStart} onChange={(event) => setRangeStart(Number(event.target.value))}/></label>
      <label>Track to<input aria-label="Tracking range end" type="number" min={mask.start} max={mask.end} step={0.1} value={rangeEnd} onChange={(event) => setRangeEnd(Number(event.target.value))}/></label>
    </div>
    {trackingIssues.length > 0 && <div className="vf-ai-review"><strong>Low confidence</strong>{trackingIssues.map((issue) => <Button key={`${issue.start}-${issue.end}`} variant="outline" size="sm" onClick={() => onReviewTime?.(issue.start)}>{formatClock(issue.start)}–{formatClock(issue.end)} • {Math.round(issue.minimumConfidence * 100)}% • Review</Button>)}</div>}
    {stillPreview && <>
      <div className="vf-button-grid"><Button size="sm" variant={comparison === "before" ? "default" : "outline"} onClick={() => setComparison("before")}>Before</Button><Button size="sm" variant={comparison === "after" ? "default" : "outline"} onClick={() => setComparison("after")}>After</Button><Button size="sm" variant={comparison === "split" ? "default" : "outline"} onClick={() => setComparison("split")}>Split</Button></div>
      <div className={`vf-ai-comparison ${comparison}`}>
        {(comparison === "before" || comparison === "split") && <img className="vf-ai-preview" src={stillPreview.before} alt="Frame before AI reconstruction" />}
        {(comparison === "after" || comparison === "split") && <img className="vf-ai-preview" src={stillPreview.after} alt="Frame after AI reconstruction" />}
      </div>
    </>}
    {segmentPreviewUrl && <video className="vf-ai-preview" src={segmentPreviewUrl} controls aria-label="AI reconstructed segment preview" />}
    {progress && <div className="vf-note"><CheckCircle2 /> {progress}</div>}
    {error && <div className="vf-note vf-error">{error}</div>}
  </div>;
}
