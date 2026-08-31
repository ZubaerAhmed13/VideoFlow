"use client";

import {
  AudioLines,
  Download,
  Film,
  Gauge,
  Import,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import {
  createProxy,
  stabilizeMedia,
  transcodeMedia,
  type LocalOutputFormat,
  type ProxyQuality,
} from "@/lib/videoflow/ffmpeg";
import { downloadBlob } from "@/lib/videoflow/media";
import type { RuntimeAsset } from "@/lib/videoflow/types";

const prettySize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function MediaTools({
  assets,
  onImport,
  onProxy,
}: {
  assets: RuntimeAsset[];
  onImport: () => void;
  onProxy: (assetId: string, proxy: Blob | null, quality?: ProxyQuality) => Promise<void>;
}) {
  const media = assets.filter(
    (asset) => asset.kind === "video" || asset.kind === "audio",
  );
  const [selectedId, setSelectedId] = useState(media[0]?.id ?? "");
  const selected = media.find((asset) => asset.id === selectedId) ?? media[0];
  const [format, setFormat] = useState<LocalOutputFormat>("mp4");
  const [strength, setStrength] = useState(12);
  const [proxyQuality, setProxyQuality] = useState<ProxyQuality>("balanced");
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("Ready");
  const [processing, setProcessing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  if (!media.length)
    return (
      <div className="vf-empty-view">
        <WandSparkles />
        <h2>No source media</h2>
        <p>
          Import video or audio to use local transcoding, proxies,
          stabilization, stream removal and extraction.
        </p>
        <Button onClick={onImport}>
          <Import /> Import media
        </Button>
      </div>
    );

  const effectiveFormat: LocalOutputFormat =
    selected.kind === "audio" && ["mp4", "webm", "gif"].includes(format)
      ? "mp3"
      : format;

  const execute = async (
    label: string,
    task: (
      signal: AbortSignal,
      update: (value: number, status: string) => void,
    ) => Promise<Blob>,
    filename: string,
  ) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setProcessing(true);
    setProgress(0);
    setPhase(label);
    try {
      const result = await task(controller.signal, (value, status) => {
        setProgress(value * 100);
        setPhase(status);
      });
      downloadBlob(result, filename);
      toast.success(`${label} complete`, {
        description: `${filename} • ${prettySize(result.size)}`,
      });
    } catch (error) {
      if (!controller.signal.aborted)
        toast.error(`${label} failed`, {
          description: error instanceof Error ? error.message : String(error),
        });
    } finally {
      controllerRef.current = null;
      setProcessing(false);
      if (controller.signal.aborted) setPhase("Cancelled");
    }
  };

  const base =
    selected.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-_]+/gi, "-") ||
    "videoflow-media";
  const generateProxy = async () => {
    if (!selected.blob) {
      toast.error("Original media is offline", {
        description: "Relink the original source before generating or regenerating its proxy.",
      });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setProcessing(true);
    setProgress(0);
    setPhase("Generating editing proxy");
    try {
      const proxy = await createProxy(
        selected.blob!,
        selected.name,
        controller.signal,
        (value, status) => {
          setProgress(value * 100);
          setPhase(status);
        },
        proxyQuality,
      );
      await onProxy(selected.id, proxy, proxyQuality);
      toast.success("Editing proxy ready", {
        description: `${prettySize(proxy.size)} • final export still uses the original source`,
      });
      setPhase("Proxy ready");
    } catch (error) {
      if (!controller.signal.aborted)
        toast.error("Proxy generation failed", {
          description: error instanceof Error ? error.message : String(error),
        });
    } finally {
      controllerRef.current = null;
      setProcessing(false);
    }
  };

  return (
    <div className="vf-media-tools">
      <aside>
        <strong>Source media</strong>
        {media.map((asset) => (
          <button
            className={asset.id === selected.id ? "active" : ""}
            key={asset.id}
            onClick={() => setSelectedId(asset.id)}
          >
            {asset.kind === "video" ? <Film /> : <AudioLines />}
            <span>
              <b>{asset.name}</b>
              <small>
                {asset.width ? `${asset.width}×${asset.height} • ` : ""}
                {prettySize(asset.size)}
                {asset.proxy ? " • Proxy ready" : ""}
              </small>
            </span>
          </button>
        ))}
        <Button variant="outline" onClick={onImport}>
          <Import /> Add media
        </Button>
      </aside>
      <section>
        <div className="vf-tool-summary">
          <div className="vf-tool-art">
            {selected.kind === "video" ? <Film /> : <AudioLines />}
          </div>
          <div>
            <span>SELECTED SOURCE</span>
            <h2>{selected.name}</h2>
            <p>
              {selected.nativeDecodable === false
                ? "This browser needs a generated proxy for interactive preview."
                : "Native preview compatible."}{" "}
              Source processing is local and worker-isolated.
            </p>
          </div>
        </div>
        {selected.kind === "video" && (
          <div className="vf-tool-cards">
            <article>
              <Gauge />
              <div>
                <h3>Editing proxy</h3>
                <p>
                  Generate a Low, Balanced or High H.264 editing proxy for responsive preview. The
                  project keeps exact source timing and the original mapping.
                </p>
                <label className="vf-tool-inline-field">
                  <span>Proxy quality</span>
                  <select
                    value={proxyQuality}
                    onChange={(event) => setProxyQuality(event.target.value as ProxyQuality)}
                    disabled={processing}
                  >
                    <option value="low">Low • 640×360 / 24 fps</option>
                    <option value="balanced">Balanced • 960×540 / 30 fps</option>
                    <option value="high">High • 1280×720 / 30 fps</option>
                  </select>
                </label>
                <div>
                  <Button
                    size="sm"
                    disabled={processing || !selected.blob}
                    onClick={() => void generateProxy()}
                  >
                    {selected.proxy ? <RefreshCw /> : <Gauge />}
                    {selected.proxy ? "Regenerate" : "Generate proxy"}
                  </Button>
                  {selected.proxy && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={processing || !selected.blob}
                      onClick={() => void onProxy(selected.id, null)}
                    >
                      <Trash2 /> Remove
                    </Button>
                  )}
                </div>
              </div>
            </article>
            <article>
              <ShieldCheck />
              <div>
                <h3>Stabilize video</h3>
                <p>
                  Local FFmpeg deshake with crop-edge compensation. Preview the
                  downloaded result before replacing a source.
                </p>
                <label className="vf-range">
                  <span>
                    Strength <b>{strength}</b>
                  </span>
                  <Slider
                    min={4}
                    max={32}
                    step={2}
                    value={[strength]}
                    onValueChange={([value]) => setStrength(value)}
                  />
                </label>
                <Button
                  size="sm"
                  disabled={processing || !selected.blob}
                  onClick={() =>
                    void execute(
                      "Stabilization",
                      (signal, update) =>
                        stabilizeMedia(
                          selected.blob!,
                          selected.name,
                          strength,
                          signal,
                          update,
                        ),
                      `${base}-stabilized.mp4`,
                    )
                  }
                >
                  <WandSparkles /> Stabilize
                </Button>
              </div>
            </article>
          </div>
        )}
        <div className="vf-convert-panel">
          <div>
            <h3>Convert, compress or extract</h3>
            <p>Only codecs bundled in the local FFmpeg build are offered.</p>
          </div>
          <label>
            <span>Output</span>
            <select
              value={effectiveFormat}
              onChange={(event) =>
                setFormat(event.target.value as LocalOutputFormat)
              }
            >
              {selected.kind === "video" && (
                <>
                  <option value="mp4">MP4 • H.264/AAC</option>
                  <option value="webm">WebM • VP9/Opus</option>
                  <option value="gif">Animated GIF</option>
                </>
              )}
              <option value="wav">WAV audio</option>
              <option value="mp3">MP3 audio</option>
              <option value="opus">Opus audio</option>
            </select>
          </label>
          <Button
            disabled={processing || !selected.blob}
            onClick={() =>
              void execute(
                "Media conversion",
                (signal, update) =>
                  transcodeMedia(
                    selected.blob!,
                    selected.name,
                    {
                      format: effectiveFormat,
                      bitrate: 4_000_000,
                      audioBitrate: 160_000,
                      includeAudio: true,
                      gifFps: 12,
                      gifWidth: 640,
                    },
                    signal,
                    update,
                  ),
                `${base}.${effectiveFormat}`,
              )
            }
          >
            <Download /> Convert & download
          </Button>
          {selected.kind === "video" && (
            <Button
              variant="outline"
              disabled={processing || !selected.blob}
              onClick={() =>
                void execute(
                  "Audio removal",
                  (signal, update) =>
                    transcodeMedia(
                      selected.blob!,
                      selected.name,
                      {
                        format: "mp4",
                        bitrate: 7_500_000,
                        includeAudio: false,
                      },
                      signal,
                      update,
                    ),
                  `${base}-silent.mp4`,
                )
              }
            >
              <AudioLines /> Remove audio stream
            </Button>
          )}
        </div>
        {processing && (
          <div className="vf-export-progress">
            <div>
              <span>{phase}</span>
              <b>{Math.round(progress)}%</b>
            </div>
            <Progress value={progress} />
            <Button
              variant="destructive"
              size="sm"
              onClick={() => controllerRef.current?.abort()}
            >
              <Square /> Cancel
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
