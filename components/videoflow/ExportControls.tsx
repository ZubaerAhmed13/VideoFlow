"use client";

import {
  CheckCircle2,
  Download,
  ListPlus,
  RefreshCw,
  Square,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { projectDuration } from "@/lib/videoflow/core.mjs";
import { exportFilename } from "@/lib/videoflow/export";
import { pickExportFileHandle, supportsDiskBackedExport } from "@/lib/videoflow/media";
import { assessRenderRisk } from "@/lib/videoflow/import-policy.mjs";
import {
  FPS_PRESETS,
  RESOLUTION_PRESETS,
  assessSmartCopy,
  describeColor,
  recommendedVideoBitrate,
} from "@/lib/videoflow/media-quality.mjs";
import type {
  ExportJob,
  ExportSettings,
  RuntimeAsset,
  VideoFlowProject,
} from "@/lib/videoflow/types";

const prettySize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};

const PRESETS: Record<ExportSettings["preset"], Partial<ExportSettings>> = {
  source: {},
  "match-first-clip": {},
  "480p": RESOLUTION_PRESETS["480p"],
  "720p": RESOLUTION_PRESETS["720p"],
  "1080p": RESOLUTION_PRESETS["1080p"],
  "1440p": RESOLUTION_PRESETS["1440p"],
  "2k-dci": RESOLUTION_PRESETS["2k-dci"],
  "4k-uhd": RESOLUTION_PRESETS["4k-uhd"],
  "4k-dci": RESOLUTION_PRESETS["4k-dci"],
  "vertical-1080": RESOLUTION_PRESETS["vertical-1080"],
  "vertical-1440": RESOLUTION_PRESETS["vertical-1440"],
  "vertical-2160": RESOLUTION_PRESETS["vertical-2160"],
  "instagram-square": RESOLUTION_PRESETS.square,
  "instagram-portrait": RESOLUTION_PRESETS.portrait,
  "youtube-4k": {
    width: 3840,
    height: 2160,
    videoBitrate: 20_000_000,
  },
  "youtube-1080": {
    width: 1920,
    height: 1080,
    videoBitrate: 12_000_000,
  },
  "youtube-720": { width: 1280, height: 720, videoBitrate: 5_000_000 },
  "youtube-shorts": { width: 1080, height: 1920, videoBitrate: 10_000_000 },
  "instagram-reel": { width: 1080, height: 1920, videoBitrate: 8_000_000 },
  tiktok: { width: 1080, height: 1920, videoBitrate: 8_000_000 },
  "high-quality": { qualityMode: "high", audioMode: "high", audioBitrate: 320_000 },
  balanced: { qualityMode: "balanced", audioMode: "balanced", audioBitrate: 192_000 },
  small: { width: 854, height: 480, qualityMode: "smaller", audioMode: "smaller", audioBitrate: 128_000 },
  "web-optimized": { width: 1280, height: 720, qualityMode: "balanced", audioBitrate: 192_000 },
  custom: {},
};

const defaultSettings = (project: VideoFlowProject, assets: RuntimeAsset[]): ExportSettings => {
  const firstClip = project.clips.find((clip) => clip.kind === "video" && clip.assetId);
  const source = assets.find((asset) => asset.id === firstClip?.assetId);
  return ({
  preset: "source",
  format: "mp4",
  width: project.settings.width,
  height: project.settings.height,
  fps: project.settings.fps,
  fpsMode: "source-project",
  videoBitrate: recommendedVideoBitrate(project.settings.width, project.settings.height, project.settings.fps, "h264", "high"),
  audioBitrate: 320_000,
  audioSampleRate: 0,
  audioMode: "match-source",
  qualityMode: "high",
  colorMode: "preserve",
  hdrPolicy: "preserve-compatible",
  sourceColorInfo: source?.colorInfo,
  videoCodec: "h264",
  audioCodec: "aac",
  includeAudio: true,
  gifFps: 12,
  gifWidth: Math.min(640, project.settings.width),
  aspectStrategy: "fit",
  rangeStart: 0,
  rangeEnd: projectDuration(project),
  });
};

export function ExportDialog({
  open,
  setOpen,
  project,
  assets,
  queuedCount,
  onQueue,
  onOpenQueue,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  project: VideoFlowProject;
  assets: RuntimeAsset[];
  queuedCount: number;
  onQueue: (settings: ExportSettings, targetHandle?: FileSystemFileHandle) => void;
  onOpenQueue: () => void;
}) {
  const [settings, setSettings] = useState<ExportSettings>(() =>
    defaultSettings(project, assets),
  );
  const [deliveryMode, setDeliveryMode] = useState<"browser" | "disk">("browser");
  const [queueError, setQueueError] = useState("");
  const sourceAsset = useMemo(() => {
    const clip = project.clips.find((entry) => entry.kind === "video" && entry.assetId);
    return assets.find((asset) => asset.id === clip?.assetId);
  }, [project.clips, assets]);
  const missing = useMemo(
    () =>
      project.clips.filter(
        (clip) =>
          clip.assetId && !assets.some((asset) => asset.id === clip.assetId),
      ).length,
    [project.clips, assets],
  );
  const offline = useMemo(() => {
    const usedIds = new Set(project.clips.flatMap((clip) => (clip.assetId ? [clip.assetId] : [])));
    return assets.filter((asset) => usedIds.has(asset.id) && !asset.blob).length;
  }, [project.clips, assets]);
  const fullDuration = projectDuration(project);
  const rangeStart = Math.max(0, Math.min(settings.rangeStart ?? 0, fullDuration));
  const rangeEnd = Math.max(rangeStart, Math.min(settings.rangeEnd ?? fullDuration, fullDuration));
  const exportDuration = Math.max(0, rangeEnd - rangeStart);
  const diskSaveAvailable = supportsDiskBackedExport();
  const renderRisk = assessRenderRisk({
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    duration: exportDuration,
    videoBitrate: settings.videoBitrate,
    clipCount: project.clips.length,
    effectComplexity: project.clips.some((clip) => clip.watermarkMasks.length || clip.keyframes.length) ? 1.6 : 1,
    aiEffects: project.clips.some((clip) => clip.watermarkMasks.some((mask) => mask.enabled && mask.method === "ai")),
    directDiskAvailable: diskSaveAvailable,
    deviceMemoryGb: typeof navigator !== "undefined" ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) : undefined,
  });
  const largeOutputUnsafe = !renderRisk.inMemoryAllowed;
  const diskModeEligible = settings.format === "mp4" && diskSaveAvailable;
  const browserOutputBlocked = largeOutputUnsafe && deliveryMode !== "disk";
  const audioOnly = ["wav", "mp3", "opus"].includes(settings.format);
  const smartCopy = assessSmartCopy(project, assets, settings);
  const hdrBlocked = Boolean(sourceAsset?.colorInfo?.hdr && !smartCopy.eligible);
  const resolutionReduced = Boolean(sourceAsset && (settings.width < sourceAsset.width || settings.height < sourceAsset.height));
  const fpsReduced = Boolean(sourceAsset?.frameRate && settings.fps < sourceAsset.frameRate - 0.002);
  useEffect(() => {
    if (!open || fullDuration <= 0) return;
    const timer = window.setTimeout(() => {
      setSettings((current) => {
        const currentEnd = current.rangeEnd ?? 0;
        if (currentEnd > 0 && currentEnd <= fullDuration) return current;
        return { ...current, rangeEnd: fullDuration };
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, fullDuration]);
  useEffect(() => {
    if (!open) return;
    const nextMode = largeOutputUnsafe && diskModeEligible ? "disk" : !diskModeEligible ? "browser" : null;
    if (!nextMode) return;
    const timer = window.setTimeout(() => setDeliveryMode(nextMode), 0);
    return () => window.clearTimeout(timer);
  }, [open, largeOutputUnsafe, diskModeEligible]);
  const choosePreset = (preset: ExportSettings["preset"]) => setSettings((current) => {
    const sourceDimensions = preset === "source"
      ? { width: project.settings.width, height: project.settings.height, fps: project.settings.fps, fpsMode: "source-project" as const }
      : preset === "match-first-clip" && sourceAsset
        ? { width: sourceAsset.width, height: sourceAsset.height, fps: sourceAsset.frameRate ?? project.settings.fps, fpsMode: "source-project" as const, sourceColorInfo: sourceAsset.colorInfo }
        : {};
    const next = { ...current, ...PRESETS[preset], ...sourceDimensions, preset };
    return {
      ...next,
      videoBitrate: recommendedVideoBitrate(next.width, next.height, next.fps, next.videoCodec, next.qualityMode),
    };
  });
  const queue = async () => {
    setQueueError("");
    const sourceSettings =
      settings.preset === "source"
        ? {
            ...settings,
            width: project.settings.width,
            height: project.settings.height,
            fps: project.settings.fps,
          }
        : settings;
    const queuedSettings: ExportSettings = {
      ...sourceSettings,
      sourceColorInfo: sourceAsset?.colorInfo,
      audioSampleRate: sourceSettings.audioSampleRate || ([44_100, 48_000].includes(sourceAsset?.audioInfo?.sampleRate ?? 0)
        ? sourceAsset!.audioInfo!.sampleRate as 44_100 | 48_000
        : 48_000),
      includeAudio: audioOnly
        ? true
        : settings.format === "gif"
          ? false
          : settings.includeAudio,
    };
    let targetHandle: FileSystemFileHandle | undefined;
    if (deliveryMode === "disk") {
      try {
        targetHandle = await pickExportFileHandle(
          exportFilename(project.name, queuedSettings),
          "video/mp4",
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setQueueError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    onQueue(queuedSettings, targetHandle);
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="vf-export-dialog">
        <DialogHeader>
          <DialogTitle>Export project</DialogTitle>
          <DialogDescription>
            Queue a local render. MP4, GIF and audio outputs use the bundled
            offline FFmpeg worker; media never leaves this device.
          </DialogDescription>
        </DialogHeader>
        <div className="vf-preflight">
          <strong>Export preflight</strong>
          <span className={project.clips.length ? "" : "error"}>
            <CheckCircle2 />{" "}
            {project.clips.length
              ? "Timeline contains media"
              : "Timeline is empty"}
          </span>
          <span className={missing ? "error" : ""}>
            <CheckCircle2 />{" "}
            {missing
              ? `${missing} source reference${missing === 1 ? " is" : "s are"} missing`
              : "All project references resolved"}
          </span>
          <span className={offline ? "error" : ""}>
            <CheckCircle2 />{" "}
            {offline
              ? `${offline} original source${offline === 1 ? " is" : "s are"} offline — proxy editing can continue, final export requires relink`
              : "All required originals are online"}
          </span>
          <span>
            <CheckCircle2 /> {settings.width}×{settings.height} • {settings.fps}{" "}
            fps
          </span>
          <span><CheckCircle2 /> Input colour: {describeColor(sourceAsset?.colorInfo)}</span>
          <span><CheckCircle2 /> Output: {settings.qualityMode === "smart-copy" && smartCopy.eligible ? "Smart Copy • original compressed stream" : `${settings.qualityMode ?? "high"} • re-encode`}</span>
          <span className={largeOutputUnsafe ? "error" : renderRisk.largeOutputWarning ? "warning" : ""}>
            <CheckCircle2 /> Estimated output {prettySize(renderRisk.estimatedBytes)} • {renderRisk.level} local render risk • memory budget {prettySize(renderRisk.inMemoryLimitBytes)}
          </span>
          {renderRisk.largeOutputWarning && <span><CheckCircle2 /> {renderRisk.recommendation}</span>}
          <span>
            <CheckCircle2 /> Local {settings.format.toUpperCase()} encoder
          </span>
        </div>
        <div className="vf-export-options">
          <label>
            <span>Preset</span>
            <select
              value={settings.preset}
              onChange={(event) =>
                choosePreset(event.target.value as ExportSettings["preset"])
              }
            >
              <option value="source">Source / project</option>
              <option value="match-first-clip">Match first clip</option>
              <option value="480p">480p • 854×480</option>
              <option value="720p">720p HD • 1280×720</option>
              <option value="1080p">1080p Full HD • 1920×1080</option>
              <option value="1440p">1440p QHD • 2560×1440</option>
              <option value="2k-dci">2K DCI • 2048×1080</option>
              <option value="4k-uhd">4K UHD • 3840×2160</option>
              <option value="4k-dci">4K DCI • 4096×2160</option>
              <option value="vertical-1080">Vertical • 1080×1920</option>
              <option value="vertical-1440">Vertical QHD • 1440×2560</option>
              <option value="vertical-2160">Vertical 4K • 2160×3840</option>
              <option value="instagram-square">Instagram Square • 1080×1080</option>
              <option value="instagram-portrait">Instagram Portrait • 1080×1350</option>
              <option value="youtube-4k">YouTube 4K</option>
              <option value="youtube-1080">YouTube 1080p</option>
              <option value="youtube-720">YouTube 720p</option>
              <option value="youtube-shorts">YouTube Shorts</option>
              <option value="instagram-reel">Instagram Reel</option>
              <option value="tiktok">TikTok</option>
              <option value="high-quality">High Quality</option>
              <option value="balanced">Balanced</option>
              <option value="small">Small File</option>
              <option value="web-optimized">Web Optimized</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>
            <span>Container</span>
            <select
              value={settings.format}
              onChange={(event) =>
                setSettings((current) => {
                  const format = event.target.value as ExportSettings["format"];
                  return {
                    ...current,
                    format,
                    videoCodec:
                      format === "mp4"
                        ? "h264"
                        : format === "webm"
                          ? "vp9"
                          : format === "gif"
                            ? "gif"
                            : "none",
                    audioCodec:
                      format === "mp4"
                        ? "aac"
                        : format === "webm" || format === "opus"
                          ? "opus"
                          : format === "mp3"
                            ? "mp3"
                            : format === "wav"
                              ? "pcm"
                              : "none",
                  };
                })
              }
            >
              <option value="mp4">MP4 • H.264/AAC</option>
              <option value="webm">WebM • VP9/Opus</option>
              <option value="gif">Animated GIF</option>
              <option value="wav">Audio only • WAV</option>
              <option value="mp3">Audio only • MP3</option>
              <option value="opus">Audio only • Opus</option>
            </select>
          </label>
          <label>
            <span>Export from (seconds)</span>
            <input
              type="number"
              min={0}
              max={fullDuration}
              step={0.1}
              value={rangeStart}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  rangeStart: Math.max(0, Number(event.target.value)),
                }))
              }
            />
          </label>
          <label>
            <span>Export to (seconds)</span>
            <input
              type="number"
              min={0}
              max={fullDuration}
              step={0.1}
              value={rangeEnd}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  rangeEnd: Math.max(0, Number(event.target.value)),
                }))
              }
            />
          </label>
          {settings.preset === "custom" && (
            <>
              <label>
                <span>Width</span>
                <input
                  type="number"
                  min={160}
                  max={7680}
                  step={2}
                  value={settings.width}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      width: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label>
                <span>Height</span>
                <input
                  type="number"
                  min={90}
                  max={4320}
                  step={2}
                  value={settings.height}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      height: Number(event.target.value),
                    }))
                  }
                />
              </label>
            </>
          )}
          {!audioOnly && settings.format !== "gif" && <label>
            <span>Frame rate</span>
            <select
              value={settings.fpsMode === "source-project" ? "source" : String(settings.fps)}
              onChange={(event) => setSettings((current) => {
                const source = event.target.value === "source";
                const fps = source ? project.settings.fps : Number(event.target.value);
                return { ...current, fpsMode: source ? "source-project" : "custom", fps, videoBitrate: recommendedVideoBitrate(current.width, current.height, fps, current.videoCodec, current.qualityMode) };
              })}
            >
              <option value="source">Source / project • {project.settings.fps}</option>
              {Object.entries(FPS_PRESETS).map(([label, value]) => <option key={label} value={value}>{label} fps</option>)}
            </select>
          </label>}
          {!audioOnly && settings.format !== "gif" && (
            <>
              <label>
                <span>Aspect handling</span>
                <select
                  value={settings.aspectStrategy}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      aspectStrategy: event.target.value as ExportSettings["aspectStrategy"],
                    }))
                  }
                >
                  <option value="fit">Fit inside frame</option>
                  <option value="fill">Fill frame</option>
                  <option value="crop">Crop to frame</option>
                  <option value="blur">Fit with background</option>
                </select>
              </label>
              <label>
                <span>Quality</span>
                <select
                  value={settings.qualityMode ?? "high"}
                  onChange={(event) => setSettings((current) => {
                    const qualityMode = event.target.value as NonNullable<ExportSettings["qualityMode"]>;
                    return { ...current, qualityMode, videoBitrate: recommendedVideoBitrate(current.width, current.height, current.fps, current.videoCodec, qualityMode) };
                  })}
                >
                  <option value="smart-copy">Source / Smart Copy</option>
                  <option value="visually-lossless">Visually Lossless</option>
                  <option value="high">High Quality</option>
                  <option value="balanced">Balanced</option>
                  <option value="smaller">Smaller File</option>
                  <option value="custom">Custom bitrate</option>
                </select>
              </label>
              {settings.qualityMode === "custom" && <label><span>Video bitrate</span><input type="number" min={500_000} max={140_000_000} step={100_000} value={settings.videoBitrate} onChange={(event) => setSettings((current) => ({ ...current, videoBitrate: Number(event.target.value) }))} /></label>}
              <label className="vf-export-switch">
                <span>Include audio</span>
                <Switch
                  checked={settings.includeAudio}
                  onCheckedChange={(includeAudio) =>
                    setSettings((current) => ({ ...current, includeAudio }))
                  }
                />
              </label>
            </>
          )}
          {(audioOnly || settings.includeAudio) && settings.format !== "gif" && (
            <label>
              <span>Audio sample rate</span>
              <select
                value={settings.audioSampleRate}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    audioSampleRate: Number(event.target.value) as 0 | 44100 | 48000,
                  }))
                }
              >
                <option value={0}>Match source</option>
                <option value={48000}>48 kHz</option>
                <option value={44100}>44.1 kHz</option>
              </select>
            </label>
          )}
          {settings.format === "gif" && (
            <>
              <label>
                <span>GIF frame rate</span>
                <select
                  value={settings.gifFps}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      gifFps: Number(event.target.value),
                    }))
                  }
                >
                  <option value={8}>8 fps</option>
                  <option value={12}>12 fps</option>
                  <option value={15}>15 fps</option>
                  <option value={24}>24 fps</option>
                </select>
              </label>
              <label>
                <span>GIF width</span>
                <select
                  value={settings.gifWidth}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      gifWidth: Number(event.target.value),
                    }))
                  }
                >
                  <option value={480}>480 px</option>
                  <option value={640}>640 px</option>
                  <option value={960}>960 px</option>
                </select>
              </label>
            </>
          )}
          {settings.format !== "gif" && (
            <label>
              <span>Audio bitrate</span>
              <select
                value={settings.audioBitrate}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    audioBitrate: Number(event.target.value),
                  }))
                }
              >
                <option value={128_000}>128 kbps</option>
                <option value={160_000}>160 kbps</option>
                <option value={192_000}>192 kbps</option>
                <option value={256_000}>256 kbps</option>
                <option value={320_000}>320 kbps</option>
              </select>
            </label>
          )}
          {settings.format === "mp4" && (
            <label>
              <span>Output handling</span>
              <select
                value={deliveryMode}
                onChange={(event) =>
                  setDeliveryMode(event.target.value as "browser" | "disk")
                }
              >
                <option value="browser">Standard browser file</option>
                <option value="disk" disabled={!diskSaveAvailable}>
                  Direct-to-disk segmented MP4{diskSaveAvailable ? "" : " • unavailable in this browser"}
                </option>
              </select>
            </label>
          )}
          {!audioOnly && settings.format !== "gif" && <label>
            <span>Colour</span>
            <select value={settings.colorMode ?? "preserve"} onChange={(event) => setSettings((current) => ({ ...current, colorMode: event.target.value as ExportSettings["colorMode"] }))}>
              <option value="preserve">Preserve source metadata</option>
              <option value="rec709-limited">Rec.709 limited</option>
              <option value="rec709-full">Rec.709 full</option>
            </select>
          </label>}
        </div>
        {settings.qualityMode === "smart-copy" && <p className="vf-export-warning">Smart Copy: {smartCopy.reason}{smartCopy.eligible ? " Export will not re-encode video." : " VideoFlow will fall back to a High Quality frame-accurate re-encode."}</p>}
        {resolutionReduced && <p className="vf-export-warning">This export intentionally reduces source resolution and encoded detail.</p>}
        {fpsReduced && <p className="vf-export-warning">Frame-rate conversion will remove frames. Choose Source / project FPS to preserve cadence.</p>}
        {hdrBlocked && <p className="vf-export-warning">HDR source detected. VideoFlow 1.0 does not certify HDR through Canvas, effects, or AI. Only an eligible Smart Copy can preserve this HDR stream; change the timeline or use an external controlled HDR-to-SDR workflow.</p>}
        {(settings.width >= 3840 || settings.height >= 2160) && (
          <p className="vf-export-warning">
            4K output uses adaptive local processing but remains hardware-dependent. For multi-gigabyte sources, use a short in/out range first to certify the original-source render path.
          </p>
        )}
        {settings.format === "mp4" && (
          <p className="vf-export-warning">
            Bounded renderer: approximately {Math.round(renderRisk.segmentSeconds)}s per segment.
            {deliveryMode === "disk"
              ? " Each encoded fragment is written to the selected file before the next segment is rendered, avoiding one giant output Blob."
              : " Standard browser output remains suitable while the estimated result stays below the in-memory safety threshold."}
          </p>
        )}
        {largeOutputUnsafe && (
          <p className="vf-export-warning">
            {diskModeEligible
              ? "This multi-gigabyte estimate requires Direct-to-disk segmented MP4. Standard browser output is blocked to prevent a giant JavaScript/MEMFS result."
              : "This multi-gigabyte estimate exceeds the safe standard-browser output path. Use a browser with File System Access direct saving for MP4, or export a smaller in/out range."}
          </p>
        )}
        {queueError && <p className="vf-export-warning">{queueError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          {queuedCount > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                onOpenQueue();
              }}
            >
              View queue ({queuedCount})
            </Button>
          )}
          <Button
            disabled={!project.clips.length || missing > 0 || offline > 0 || exportDuration <= 0 || browserOutputBlocked || hdrBlocked}
            onClick={() => void queue()}
          >
            <ListPlus /> Add to queue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatElapsed(milliseconds = 0): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function CancelJob({
  job,
  onCancel,
}: {
  job: ExportJob;
  onCancel: (id: string) => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive">
          <Square /> Cancel
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this render?</AlertDialogTitle>
          <AlertDialogDescription>
            The partial output will be discarded. The project and source media
            are not changed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep rendering</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => onCancel(job.id)}
          >
            Cancel render
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ExportQueueView({
  jobs,
  onAdd,
  onCancel,
  onRetry,
  onRemove,
  onClear,
  onDownload,
}: {
  jobs: ExportJob[];
  onAdd: () => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onDownload: (id: string) => void;
}) {
  const active = jobs.some((job) =>
    ["preparing", "rendering", "ai-processing", "muxing", "validating"].includes(job.status),
  );
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!jobs.length)
    return (
      <div className="vf-empty-view">
        <Download />
        <h2>No export jobs</h2>
        <p>
          Queue MP4, WebM, GIF, WAV, MP3 or Opus output. Jobs run one at a time
          locally.
        </p>
        <Button onClick={onAdd}>
          <Upload /> Add export job
        </Button>
      </div>
    );
  return (
    <div className="vf-queue">
      <div className="vf-queue-toolbar">
        <div>
          <strong>Local export queue</strong>
          <span>One render runs at a time to protect browser memory.</span>
        </div>
        <div>
          <Button variant="outline" onClick={onClear}>
            Clear finished
          </Button>
          <Button onClick={onAdd}>
            <ListPlus /> Add job
          </Button>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Elapsed / remaining</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => {
            const elapsed =
              job.elapsed ??
              (job.startedAt && clock ? clock - job.startedAt : 0);
            const remaining =
              job.progress > 2 && job.progress < 100
                ? (elapsed / job.progress) * (100 - job.progress)
                : 0;
            const processing = [
              "preparing",
              "rendering",
              "ai-processing",
              "muxing",
              "validating",
            ].includes(job.status);
            return (
              <TableRow key={job.id}>
                <TableCell>
                  <div className="vf-job-name">
                    <strong>{job.name}</strong>
                    <span>{job.filename}</span>
                    {job.error && <small>{job.error}</small>}
                    {job.validation && (
                      <small className="valid">
                        <CheckCircle2 />{" "}
                        {job.validation.width
                          ? `${job.validation.width}×${job.validation.height} • `
                          : ""}
                        {job.validation.videoCodec ?? job.validation.audioCodec}{" "}
                        • {job.validation.duration.toFixed(2)}s
                      </small>
                    )}
                    {job.diskBacked && job.status === "complete" && (
                      <small className="valid">
                        <CheckCircle2 /> Saved directly to disk
                        {job.fileSize ? ` • ${prettySize(job.fileSize)}` : ""}
                        {job.segmentCount ? ` • ${job.segmentCount} bounded segment${job.segmentCount === 1 ? "" : "s"}` : ""}
                      </small>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <span className={`vf-job-status ${job.status}`}>
                    {job.status === "failed" ? (
                      <XCircle />
                    ) : job.status === "complete" ? (
                      <CheckCircle2 />
                    ) : null}
                    {job.phase}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="vf-job-progress">
                    <Progress value={job.progress} />
                    <span>{Math.round(job.progress)}%</span>
                  </div>
                </TableCell>
                <TableCell>
                  {job.startedAt ? (
                    <>
                      {formatElapsed(elapsed)}
                      {remaining > 0 && <> / ~{formatElapsed(remaining)}</>}
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <div className="vf-job-actions">
                    {job.status === "complete" && !job.diskBacked && (
                      <Button size="sm" onClick={() => onDownload(job.id)}>
                        <Download /> Download
                      </Button>
                    )}
                    {processing && <CancelJob job={job} onCancel={onCancel} />}
                    {job.status === "waiting" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onCancel(job.id)}
                      >
                        <Square /> Cancel
                      </Button>
                    )}
                    {["failed", "cancelled"].includes(job.status) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onRetry(job.id)}
                      >
                        <RefreshCw /> Retry
                      </Button>
                    )}
                    {!processing && job.status !== "waiting" && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${job.name}`}
                        onClick={() => onRemove(job.id)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
