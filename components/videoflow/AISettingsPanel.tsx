"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Cpu, LoaderCircle, ShieldCheck, Sparkles, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { detectAICapability, type AICapabilityReport } from "@/lib/videoflow/ai/AICapability";
import { runImageInpainting, resetAISession } from "@/lib/videoflow/ai/AIInferenceEngine";
import {
  bundledAIModelAvailable,
  getAIModelBytes,
  getAIModelRecord,
  installAIModel,
  installBundledAIModel,
  isAIModelInstalled,
  removeAIModel,
} from "@/lib/videoflow/ai/AIModelLoader";
import { DEFAULT_AI_MODEL, PREVIEW_AI_MODEL } from "@/lib/videoflow/ai/AIModelRegistry";
import {
  installAIRuntime,
  removeAIRuntime,
  runtimeAvailability,
} from "@/lib/videoflow/ai/AIRuntimeInstaller";
import {
  loadAIDefaultSettings,
  saveAIDefaultSettings,
} from "@/lib/videoflow/ai/AISettingsStore";
import type { AIProvider, AIQuality, AISettings } from "@/lib/videoflow/ai/types";
import { createROITransform, restoreROI } from "@/lib/videoflow/ai/inpainting/ROIPreprocessor";
import { buildModelMask } from "@/lib/videoflow/ai/inpainting/MaskProcessor";
import { blendBidirectionalContext } from "@/lib/videoflow/ai/temporal/TemporalContext";
import { getAIDiagnosticsSnapshot, type AIDiagnosticsSnapshot } from "@/lib/videoflow/ai/AIDiagnostics";

export function AISettingsPanel() {
  const modelInput = useRef<HTMLInputElement>(null);
  const runtimeInput = useRef<HTMLInputElement>(null);
  const [defaults, setDefaults] = useState<AISettings>(() => loadAIDefaultSettings());
  const [model, setModel] = useState(() => getAIModelRecord());
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [bundled, setBundled] = useState(false);
  const [capability, setCapability] = useState<AICapabilityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Checking local AI…");
  const [diagnostics, setDiagnostics] = useState<AIDiagnosticsSnapshot>(() => getAIDiagnosticsSnapshot());

  const refresh = async () => {
    const [runtime, detected, hasBundled] = await Promise.all([
      runtimeAvailability(),
      detectAICapability(),
      bundledAIModelAvailable(),
    ]);
    setRuntimeReady(runtime.ready);
    setCapability(detected);
    setBundled(hasBundled);
    setModel(getAIModelRecord());
    setStatus("AI state refreshed.");
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const patchDefaults = (patch: Partial<AISettings>) => {
    const next = { ...defaults, ...patch };
    setDefaults(next);
    saveAIDefaultSettings(next);
  };

  const installBundled = async () => {
    setBusy(true);
    setStatus("Validating bundled production + preview LaMa checksums…");
    try {
      const record = await installBundledAIModel();
      setModel(record);
      setStatus("AI model pack installed locally — checksum verified for both models.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const installModel = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setStatus("Validating selected ONNX model…");
    try {
      setModel(await installAIModel(file));
      setStatus("Model installed locally and checksum verified.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const installRuntime = async (files?: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setStatus("Installing local ONNX Runtime Web assets…");
    try {
      const result = await installAIRuntime(files);
      const current = await runtimeAvailability();
      setRuntimeReady(current.ready);
      setStatus(result.missing.length ? `Runtime incomplete: missing ${result.missing.join(", ")}.` : "Runtime installed locally.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const selfTest = async () => {
    setBusy(true);
    setStatus("Running local runtime, integrity, preprocessing, inference, temporal and cancellation tests…");
    try {
      const runtime = await runtimeAvailability();
      if (!runtime.ready) throw new Error("Local ONNX runtime pack is incomplete.");
      const modelBytes = await getAIModelBytes(DEFAULT_AI_MODEL);
      if (!modelBytes || modelBytes.byteLength !== DEFAULT_AI_MODEL.size) throw new Error("Checksum-validated production model cache is unavailable or has the wrong size.");
      if (isAIModelInstalled(PREVIEW_AI_MODEL.id)) {
        const previewBytes = await getAIModelBytes(PREVIEW_AI_MODEL);
        if (!previewBytes || previewBytes.byteLength !== PREVIEW_AI_MODEL.size) throw new Error("Checksum-validated preview accelerator cache is unavailable or has the wrong size.");
      }
      await resetAISession();
      const image = new ImageData(512, 512);
      for (let y = 0; y < 512; y += 1) {
        for (let x = 0; x < 512; x += 1) {
          const i = (y * 512 + x) * 4;
          image.data[i] = 40 + Math.round((x / 511) * 150);
          image.data[i + 1] = 70 + Math.round((y / 511) * 120);
          image.data[i + 2] = 140;
          image.data[i + 3] = 255;
        }
      }
      const mask = new Float32Array(512 * 512);
      for (let y = 204; y < 308; y += 1) for (let x = 180; x < 332; x += 1) mask[y * 512 + x] = 1;
      const transform = createROITransform(800, 200, 512, 512);
      if (transform.scaledWidth !== 512 || transform.scaledHeight !== 128 || transform.paddingTop !== 192 || transform.paddingBottom !== 192) throw new Error("ROI aspect-preservation transform failed.");
      const roi = { x: 0, y: 0, width: 800, height: 200, sourceWidth: 800, sourceHeight: 200 };
      const transformedMask = buildModelMask({ x: 0.25, y: 0.2, width: 0.5, height: 0.6, shape: "rectangle" }, roi, transform, 8);
      if (transformedMask.length !== 512 * 512 || !transformedMask.some((value) => value > 0)) throw new Error("Mask preprocessing transform failed.");
      const restored = restoreROI(image, transform);
      if (restored.width !== 800 || restored.height !== 200) throw new Error("ROI restore transform failed.");
      const wasm = await runImageInpainting(image, mask, { ...defaults, provider: "wasm" });
      let webgpu = "not available";
      if (capability?.webgpu === "available") {
        await resetAISession();
        const gpu = await runImageInpainting(image, mask, { ...defaults, provider: "webgpu" });
        webgpu = `${gpu.provider.toUpperCase()} ${Math.round(gpu.inferenceMs)} ms`;
      }
      const temporalImage = new ImageData(32, 32);
      temporalImage.data.fill(128);
      const temporal = blendBidirectionalContext(
        temporalImage,
        temporalImage,
        { past: [{ source: temporalImage, reconstruction: temporalImage }], future: [{ source: temporalImage, reconstruction: temporalImage }] },
        0.2,
      );
      if (temporal.pastFrames !== 1 || temporal.futureFrames !== 1) throw new Error("Bidirectional temporal context failed.");
      const cancelled = new AbortController();
      cancelled.abort();
      let cancellationPassed = false;
      try { await runImageInpainting(image, mask, defaults, cancelled.signal); }
      catch (error) { cancellationPassed = error instanceof DOMException && error.name === "AbortError"; }
      if (!cancellationPassed) throw new Error("AI cancellation self-test failed.");
      setDiagnostics(getAIDiagnosticsSnapshot());
      setStatus(`PASS • local model checksum/cache • ROI/mask/restore • WASM ${Math.round(wasm.inferenceMs)} ms • WebGPU ${webgpu} • past+future temporal • cancellation.`);
    } catch (error) {
      setStatus(`FAIL • ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Remove the locally cached AI model and runtime? Basic Blur, Pixelate, Cover and Clone remain available.")) return;
    setBusy(true);
    try {
      await Promise.all([removeAIModel(), removeAIRuntime(), resetAISession()]);
      await refresh();
      setStatus("AI model/runtime removed from local storage.");
    } finally {
      setBusy(false);
    }
  };

  const installed = model.state === "installed" || model.state === "ready";
  return (
    <section className="vf-ai-settings">
      <h2><Sparkles /> AI Reconstruction</h2>
      <p>Local neural inpainting only. Use watermark reconstruction only on media you own or are authorized to modify.</p>
      <div className="vf-ai-status">
        <ShieldCheck />
        <div>
          <strong>{DEFAULT_AI_MODEL.name}</strong>
          <span>{installed ? `Checksum verified • production 512${isAIModelInstalled(PREVIEW_AI_MODEL.id) ? " + 256 preview accelerator" : ""} • ${((DEFAULT_AI_MODEL.size + (isAIModelInstalled(PREVIEW_AI_MODEL.id) ? PREVIEW_AI_MODEL.size : 0)) / 1024 / 1024).toFixed(1)} MiB` : bundled ? "Bundled production + preview pack available to install" : "Model not installed"}</span>
        </div>
      </div>
      <div className="vf-capability-grid">
        <div><span>Provider</span><b>{diagnostics.provider}</b></div>
        <div><span>Inference ROI</span><b>{diagnostics.inferenceROI}</b></div>
        <div><span>Temporal context</span><b>{diagnostics.temporalContext}</b></div>
        <div><span>Recent inference</span><b>{diagnostics.recentInferenceMs === null ? "not run" : `${Math.round(diagnostics.recentInferenceMs)} ms`}</b></div>
        <div><span>Worker</span><b>{diagnostics.workerState} • {diagnostics.workerRestarts} restart(s)</b></div>
        <div><span>Tiling</span><b>{diagnostics.tileCount || "not run"}</b></div>
        <div><span>AI intermediate</span><b>{diagnostics.intermediate === "png-lossless" ? "Lossless PNG micro-batch" : diagnostics.intermediate === "jpeg-fallback" ? "JPEG fallback" : "not run"}</b></div>
      </div>
      <div className="vf-ai-status">
        <Cpu />
        <div>
          <strong>ONNX Runtime Web</strong>
          <span>{runtimeReady ? "Local runtime ready" : "Runtime not fully available"} • WebGPU {capability?.webgpu ?? "checking"} • WASM {capability?.wasm === false ? "unavailable" : "available"}</span>
        </div>
      </div>
      <div className="vf-ai-settings-fields">
        <label>
          <span>Provider</span>
          <select value={defaults.provider} onChange={(event) => patchDefaults({ provider: event.target.value as "auto" | AIProvider })}>
            <option value="auto">Automatic</option>
            <option value="webgpu">WebGPU</option>
            <option value="wasm">WASM</option>
          </select>
        </label>
        <label>
          <span>Default quality</span>
          <select value={defaults.quality} onChange={(event) => patchDefaults({ quality: event.target.value as AIQuality })}>
            <option value="fast">Fast</option>
            <option value="balanced">Balanced</option>
            <option value="high">High</option>
            <option value="maximum">Maximum</option>
          </select>
        </label>
        <label>
          <span>Maximum temporal window</span>
          <select value={defaults.temporalWindow} onChange={(event) => patchDefaults({ temporalWindow: Number(event.target.value) })}>
            <option value={3}>3 frames</option>
            <option value={9}>9 frames</option>
            <option value={11}>11 frames</option>
            <option value={15}>15 frames</option>
          </select>
        </label>
      </div>
      <div className="vf-storage-actions">
        {bundled && !installed && <Button disabled={busy} onClick={() => void installBundled()}>{busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />} Install bundled AI</Button>}
        <Button variant="outline" disabled={busy} onClick={() => modelInput.current?.click()}><Upload /> Install model file</Button>
        <Button variant="outline" disabled={busy} onClick={() => runtimeInput.current?.click()}><Upload /> Install runtime files</Button>
        <Button variant="outline" disabled={busy || !installed || !runtimeReady} onClick={() => void selfTest()}><Activity /> Run AI self-test</Button>
        <Button variant="destructive" disabled={busy || (!installed && !runtimeReady)} onClick={() => void remove()}><Trash2 /> Remove AI model</Button>
      </div>
      <input ref={modelInput} hidden type="file" accept=".onnx,application/octet-stream" onChange={(event) => void installModel(event.target.files?.[0])} />
      <input ref={runtimeInput} hidden multiple type="file" accept=".mjs,.wasm,application/wasm,text/javascript" onChange={(event) => void installRuntime(event.target.files)} />
      <p className="vf-note">{status}</p>
    </section>
  );
}
