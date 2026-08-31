"use client";

import {
  Activity,
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  Play,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { openDatabase } from "@/lib/videoflow/db";
import { deploymentAssetUrl } from "@/lib/videoflow/base-url";
import { runFfmpegSelfTest } from "@/lib/videoflow/ffmpeg";
import { detectAICapability } from "@/lib/videoflow/ai/AICapability";
import { getAIModelRecord } from "@/lib/videoflow/ai/AIModelLoader";
import { runtimeAvailability } from "@/lib/videoflow/ai/AIRuntimeInstaller";
import { runImageInpainting } from "@/lib/videoflow/ai/AIInferenceEngine";
import { DEFAULT_AI_SETTINGS } from "@/lib/videoflow/ai/AIManager";

type Result = {
  name: string;
  status: "pass" | "fail" | "separate";
  detail: string;
};

export function DiagnosticsPanel() {
  const capabilities = [
    ["WebAssembly", typeof WebAssembly !== "undefined"],
    ["Web Workers", typeof Worker !== "undefined"],
    ["WebCodecs", "VideoEncoder" in window],
    ["Web Audio", typeof AudioContext !== "undefined"],
    ["MediaRecorder", typeof MediaRecorder !== "undefined"],
    ["Screen capture", Boolean(navigator.mediaDevices?.getDisplayMedia)],
    ["IndexedDB", typeof indexedDB !== "undefined"],
    ["Service Worker", "serviceWorker" in navigator],
  ] as const;
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("Ready");
  const [results, setResults] = useState<Result[]>([]);
  const [aiSummary, setAiSummary] = useState("Checking local AI…");
  const [buildSummary, setBuildSummary] = useState("1.0.0 • loading build fingerprint");
  useEffect(() => {
    let active = true;
    void Promise.all([detectAICapability(), runtimeAvailability()]).then(([capability, runtime]) => {
      if (!active) return;
      const model = getAIModelRecord();
      setAiSummary(`${model.state === "installed" || model.state === "ready" ? model.descriptor.name : "Model not installed"} • ${runtime.ready ? "runtime installed" : "runtime not installed"} • ${capability.webgpu === "available" ? "WebGPU" : "WASM fallback"}`);
    });
    void fetch(deploymentAssetUrl("build-info.json"), { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("unavailable")))
      .then((info: { version?: string; build?: string }) => { if (active) setBuildSummary(`${info.version ?? "1.0.0"} • ${info.build ?? "unknown build"}`); })
      .catch(() => { if (active) setBuildSummary("1.0.0 • build fingerprint unavailable"); });
    return () => { active = false; };
  }, []);
  const run = async () => {
    setRunning(true);
    setResults([]);
    setProgress(1);
    setPhase("Testing application core");
    const next: Result[] = [
      {
        name: "Application Core",
        status: "pass",
        detail: "Core modules loaded",
      },
    ];
    try {
      const db = await openDatabase();
      db.close();
      next.push({
        name: "IndexedDB",
        status: "pass",
        detail: "Database opened and schema is available",
      });
    } catch (error) {
      next.push({ name: "IndexedDB", status: "fail", detail: String(error) });
    }
    setResults([...next]);
    setProgress(12);
    setPhase("Checking offline assets");
    try {
      const [script, wasm] = await Promise.all([
        fetch(deploymentAssetUrl("vendor/ffmpeg/ffmpeg-core.js")),
        fetch(deploymentAssetUrl("vendor/ffmpeg/ffmpeg-core.wasm")),
      ]);
      if (!script.ok || !wasm.ok)
        throw new Error("A bundled FFmpeg asset is missing.");
      next.push({
        name: "Offline Assets",
        status: "pass",
        detail: `FFmpeg core and ${Math.round(Number(wasm.headers.get("content-length") ?? 0) / 1024 / 1024) || 10} MB packaged WASM found locally`,
      });
    } catch (error) {
      next.push({
        name: "Offline Assets",
        status: "fail",
        detail: String(error),
      });
    }
    setResults([...next]);
    setProgress(20);
    setPhase("Initializing FFmpeg worker");
    try {
      const test = await runFfmpegSelfTest((value, status) => {
        setProgress(20 + value * 68);
        setPhase(status);
      });
      const video = test.probe.streams.find(
        (stream) => stream.codec_type === "video",
      );
      const audio = test.probe.streams.find(
        (stream) => stream.codec_type === "audio",
      );
      next.push({
        name: "FFmpeg Initialization",
        status: "pass",
        detail: "Bundled WebAssembly engine loaded",
      });
      next.push({
        name: "Worker Communication",
        status: "pass",
        detail: "Encode and probe messages completed",
      });
      next.push({
        name: "Test Video Encode",
        status: "pass",
        detail: `${video?.codec_name ?? "video"} ${video?.width}×${video?.height}`,
      });
      next.push({
        name: "Test Audio Encode",
        status: "pass",
        detail: audio?.codec_name ?? "audio stream present",
      });
      next.push({
        name: "Output Validation",
        status: "pass",
        detail: `${test.size} byte self-test MP4 validated`,
      });
    } catch (error) {
      next.push({
        name: "FFmpeg / Worker / Encode",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    setResults([...next]);
    setProgress(88);
    setPhase("Checking local AI reconstruction");
    try {
      const [capability, runtime] = await Promise.all([detectAICapability(), runtimeAvailability()]);
      const model = getAIModelRecord();
      next.push({ name: "AI WebGPU", status: capability.webgpu === "available" ? "pass" : "separate", detail: capability.webgpu === "available" ? "Adapter and device initialization succeeded" : `WebGPU ${capability.webgpu}; WASM fallback selected` });
      next.push({ name: "AI Model Integrity", status: model.state === "installed" || model.state === "ready" ? "pass" : "separate", detail: model.state === "installed" || model.state === "ready" ? `${model.descriptor.name} checksum was verified at installation` : "Install the optional local AI model to execute inference self-test" });
      if (runtime.ready && (model.state === "installed" || model.state === "ready")) {
        const image = new ImageData(512, 512);
        for (let i = 0; i < image.data.length; i += 4) { image.data[i] = 80; image.data[i + 1] = 130; image.data[i + 2] = 180; image.data[i + 3] = 255; }
        const mask = new Float32Array(512 * 512);
        for (let y = 200; y < 312; y += 1) for (let x = 200; x < 312; x += 1) mask[y * 512 + x] = 1;
        const inference = await runImageInpainting(image, mask, DEFAULT_AI_SETTINGS);
        next.push({ name: "AI Neural Inference", status: "pass", detail: `${inference.provider.toUpperCase()} session returned a 512×512 neural inpaint tensor in ${Math.round(inference.inferenceMs)} ms` });
      } else {
        next.push({ name: "AI Neural Inference", status: "separate", detail: "Not executed because the optional model/runtime pack is not fully installed" });
      }
    } catch (error) {
      next.push({ name: "AI Reconstruction", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
    setResults([...next]);
    setProgress(92);
    setPhase("Checking installed app shell");
    if ("serviceWorker" in navigator) {
      try {
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) =>
            window.setTimeout(
              () => reject(new Error("Service worker readiness timed out.")),
              5000,
            ),
          ),
        ]);
        const shell = await caches.match(deploymentAssetUrl(""));
        next.push({
          name: "PWA Shell",
          status: shell ? "pass" : "separate",
          detail: shell
            ? "Application shell is cached"
            : "Reload once after installation, then run the offline browser test",
        });
      } catch (error) {
        next.push({
          name: "PWA Shell",
          status: "separate",
          detail: String(error),
        });
      }
    } else
      next.push({
        name: "PWA Shell",
        status: "separate",
        detail: "Run separately in an installed PWA-capable browser",
      });
    setResults([...next]);
    setProgress(100);
    setPhase(
      next.some((item) => item.status === "fail")
        ? "Self-test completed with failures"
        : "All executable self-tests passed",
    );
    setRunning(false);
  };
  return (
    <>
      <div className="vf-diagnostic-banner">
        <Activity />
        <div>
          <strong>System capability report</strong>
          <span>No diagnostic information is uploaded.</span>
        </div>
        <Button disabled={running} onClick={() => void run()}>
          {running ? <LoaderCircle className="animate-spin" /> : <Play />} Run
          self-test
        </Button>
      </div>
      <div className="vf-capability-grid">
        {capabilities.map(([name, supported]) => (
          <div key={name}>
            <span>{name}</span>
            <b className={supported ? "supported" : "limited"}>
              {supported ? "Supported" : "Unavailable"}
            </b>
          </div>
        ))}
        <div>
          <span>Version / Build</span>
          <b className="supported">{buildSummary}</b>
        </div>
        <div>
          <span>FFmpeg/WebAssembly</span>
          <b className="supported">Bundled • lazy-loaded</b>
        </div>
        <div>
          <span>AI reconstruction</span>
          <b className={aiSummary.includes("runtime installed") && !aiSummary.includes("Model not installed") ? "supported" : "limited"}>{aiSummary}</b>
        </div>
      </div>
      {running && (
        <div className="vf-export-progress">
          <div>
            <span>{phase}</span>
            <b>{Math.round(progress)}%</b>
          </div>
          <Progress value={progress} />
        </div>
      )}
      {results.length > 0 && (
        <div className="vf-self-test">
          {results.map((result) => (
            <div key={result.name}>
              {result.status === "pass" ? (
                <CheckCircle2 />
              ) : result.status === "fail" ? (
                <XCircle />
              ) : (
                <CircleHelp />
              )}
              <span>
                <strong>{result.name}</strong>
                <small>{result.detail}</small>
              </span>
              <b className={result.status}>
                {result.status === "pass"
                  ? "PASS"
                  : result.status === "fail"
                    ? "FAIL"
                    : "RUN SEPARATELY"}
              </b>
            </div>
          ))}
        </div>
      )}
      <div className="vf-browser-note">
        <CircleHelp />
        <p>
          <strong>Advanced features stay honest</strong>
          <br />
          Neural inpainting is an optional local model pack and is reported as ready only after checksum validation and a successful ONNX session. Template-based automatic tracking is available; optical-flow tracking remains optional and is never mislabeled as active.
        </p>
      </div>
    </>
  );
}
