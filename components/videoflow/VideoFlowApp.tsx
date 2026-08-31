"use client";

import {
  Activity,
  AudioLines,
  Camera,
  ChevronDown,
  Crop,
  Download,
  Film,
  FolderOpen,
  Gauge,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Import,
  Layers3,
  LockKeyhole,
  LockOpen,
  Menu,
  Mic,
  Moon,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Scissors,
  Search,
  Settings2,
  SlidersHorizontal,
  Square,
  Sun,
  Trash2,
  Type,
  Undo2,
  Upload,
  Video,
  WandSparkles,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { DiagnosticsPanel } from "@/components/videoflow/DiagnosticsPanel";
import { AISettingsPanel } from "./AISettingsPanel";
import { AIWatermarkControls } from "@/components/videoflow/AIWatermarkControls";
import {
  ExportDialog,
  ExportQueueView,
} from "@/components/videoflow/ExportControls";
import { MediaTools } from "@/components/videoflow/MediaTools";
import { useExportQueue } from "@/hooks/use-export-queue";
import {
  listProjects,
  listSnapshots,
  clearRecovery,
  deleteAsset,
  deleteProject,
  deleteSnapshot,
  loadAssets,
  loadProject,
  loadRecovery,
  saveAsset,
  saveProject,
  saveRecovery,
  saveSnapshot,
  clearTemporaryData,
  deleteProjectProxies,
  removeUnusedMedia,
  resetDatabase,
  storageBreakdown,
  type StorageBreakdown,
} from "@/lib/videoflow/db";
import {
  clipDuration,
  cuesToSrt,
  formatTime,
  migrateProject,
  parseSrt,
  projectDuration,
  isTrackAudible,
  resolveClipState,
  resolveWatermarkMask,
  serializeProject,
  snapTime,
  uid,
  upsertWatermarkKeyframe,
  upsertPropertyKeyframe,
} from "@/lib/videoflow/core.mjs";
import { processAudioWithFfmpeg, type ProxyQuality } from "@/lib/videoflow/ffmpeg";
import { deploymentAssetUrl, deploymentBaseUrl } from "@/lib/videoflow/base-url";
import {
  decideFileStorage,
  downloadBlob,
  inspectFile,
  pickReferenceFiles,
  reconnectAssetFromHandle,
  relinkRuntimeAsset,
  revokeAssets,
  supportsReferenceImport,
} from "@/lib/videoflow/media";
import {
  drawCompositionFrame,
  prepareMedia,
  type PreparedMedia,
} from "@/lib/videoflow/render";
import { joinAudio, processAudio, waveformPyramid } from "@/lib/videoflow/audio";
import type {
  Clip,
  ExportSettings,
  RuntimeAsset,
  SnapshotRecord,
  TextStyle,
  Track,
  VideoFlowProject,
  WatermarkMask,
} from "@/lib/videoflow/types";

type WatermarkTrackingPoint = NonNullable<NonNullable<WatermarkMask["ai"]>["tracking"]>[number];

type View =
  | "dashboard"
  | "editor"
  | "tools"
  | "audio"
  | "recorder"
  | "projects"
  | "exports"
  | "diagnostics"
  | "settings";

const TRACKS: Track[] = [
  {
    id: "v2",
    name: "V2",
    kind: "video",
    index: 5,
    muted: false,
    solo: false,
    locked: false,
    visible: true,
    gain: 1,
  },
  {
    id: "v1",
    name: "V1",
    kind: "video",
    index: 4,
    muted: false,
    solo: false,
    locked: false,
    visible: true,
    gain: 1,
  },
  {
    id: "t1",
    name: "T1",
    kind: "text",
    index: 3,
    muted: false,
    solo: false,
    locked: false,
    visible: true,
    gain: 1,
  },
  {
    id: "a1",
    name: "A1",
    kind: "audio",
    index: 2,
    muted: false,
    solo: false,
    locked: false,
    visible: true,
    gain: 1,
  },
  {
    id: "a2",
    name: "A2",
    kind: "audio",
    index: 1,
    muted: false,
    solo: false,
    locked: false,
    visible: true,
    gain: 1,
  },
];

const DEFAULT_TRANSFORM = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  flipX: false,
  flipY: false,
  crop: { x: 0, y: 0, width: 1, height: 1 },
};

function defaultTextStyle(): TextStyle {
  return {
    fontFamily: "system-ui",
    fontWeight: 600,
    italic: false,
    align: "center",
    lineHeight: 1.15,
    letterSpacing: 0,
    strokeColor: "rgba(0,0,0,.78)",
    strokeWidth: 2,
    shadowColor: "rgba(0,0,0,.45)",
    shadowBlur: 4,
    backgroundOpacity: 0.6,
    padding: 18,
    preset: "title",
  };
}

function blankProject(name = "Untitled Project"): VideoFlowProject {
  const now = new Date().toISOString();
  return {
    id: uid("project"),
    name,
    schemaVersion: 3,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    tracks: structuredClone(TRACKS),
    clips: [],
    subtitles: [],
    settings: {
      width: 1280,
      height: 720,
      fps: 30,
      snapping: true,
      snapSeconds: 0.15,
      previewQuality: "half",
      masterGain: 1,
      backgroundColor: "#080a0f",
    },
  };
}

function makeClip(
  asset: RuntimeAsset,
  trackId: string,
  timelineStart: number,
): Clip {
  return {
    id: uid("clip"),
    assetId: asset.id,
    trackId,
    kind: asset.kind === "audio" ? "audio" : "video",
    name: asset.name,
    timelineStart,
    sourceStart: 0,
    sourceEnd: Math.max(asset.duration, asset.kind === "image" ? 5 : 0.1),
    speed: 1,
    gain: 1,
    opacity: 1,
    transform: structuredClone(DEFAULT_TRANSFORM),
    fadeIn: 0,
    fadeOut: 0,
    keyframes: [],
    watermarkMasks: [],
  };
}

const NAV_ITEMS: Array<{
  id: View;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "dashboard", label: "Home", icon: Gauge },
  { id: "editor", label: "Video Editor", icon: Film },
  { id: "tools", label: "Video Tools", icon: WandSparkles },
  { id: "audio", label: "Audio Tools", icon: AudioLines },
  { id: "recorder", label: "Recorder", icon: Camera },
  { id: "projects", label: "Projects", icon: FolderOpen },
  { id: "exports", label: "Export Queue", icon: Download },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings2 },
];

const prettySize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};
const updateClip = (
  project: VideoFlowProject,
  id: string,
  patch: Partial<Clip>,
): VideoFlowProject => ({
  ...project,
  clips: project.clips.map((clip) =>
    clip.id === id ? { ...clip, ...patch } : clip,
  ),
});

function Preview({
  project,
  assets,
  playhead,
  setPlayhead,
  playing,
  setPlaying,
  selectedId,
  onDirectEdit,
}: {
  project: VideoFlowProject;
  assets: RuntimeAsset[];
  playhead: number;
  setPlayhead: (value: number) => void;
  playing: boolean;
  setPlaying: (value: boolean) => void;
  selectedId: string | null;
  onDirectEdit: (id: string, patch: Partial<Clip>, label: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const preparedRef = useRef<PreparedMedia | null>(null);
  const [maskMode, setMaskMode] = useState<"original" | "processed" | "split">(
    "processed",
  );
  const [interactionMode, setInteractionMode] = useState<
    "move" | "crop" | "resize" | "rotate" | "mask"
  >("move");
  const timeRef = useRef(playhead);
  const projectRef = useRef(project);
  const duration = projectDuration(project);
  useEffect(() => {
    timeRef.current = playhead;
  }, [playhead]);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  useEffect(() => {
    let active = true;
    preparedRef.current?.cleanup();
    preparedRef.current = null;
    void prepareMedia(project, assets, { useProxies: true }).then((prepared) => {
      if (!active) return prepared.cleanup();
      preparedRef.current = prepared;
      if (canvasRef.current)
        drawCompositionFrame(
          canvasRef.current,
          projectRef.current,
          prepared,
          timeRef.current,
          { maskMode, showMaskGuides: true, selectedId, showCropGuide: interactionMode === "crop" },
        );
    });
    return () => {
      active = false;
      preparedRef.current?.cleanup();
      preparedRef.current = null;
    };
  }, [assets, interactionMode, maskMode, project, selectedId]);
  const draw = useCallback(
    (time: number) => {
      const prepared = preparedRef.current;
      const canvas = canvasRef.current;
      if (!prepared || !canvas) return;
      for (const clip of projectRef.current.clips) {
        if (!clip.assetId) continue;
        const media = prepared.audible.get(clip.id);
        const visual = prepared.visual.get(clip.id);
        if (
          time >= clip.timelineStart &&
          time < clip.timelineStart + clipDuration(clip)
        ) {
          const resolved = resolveClipState(clip, time) as Clip;
          const desired =
            clip.sourceStart + (time - clip.timelineStart) * clip.speed;
          if (media) {
            if (Math.abs(media.currentTime - desired) > 0.08)
              media.currentTime = desired;
            const track = projectRef.current.tracks.find(
              (entry) => entry.id === clip.trackId,
            );
            const audible = isTrackAudible(projectRef.current, clip.trackId);
            const local = time - clip.timelineStart;
            const envelope = Math.max(
              0,
              Math.min(
                1,
                clip.fadeIn > 0 ? local / clip.fadeIn : 1,
                clip.fadeOut > 0
                  ? (clipDuration(clip) - local) / clip.fadeOut
                  : 1,
              ),
            );
            media.playbackRate = Math.max(0.25, Math.min(4, clip.speed));
            media.muted = !audible;
            media.volume = Math.max(
              0,
              Math.min(
                1,
                resolved.gain * envelope *
                  (track?.gain ?? 1) *
                  (projectRef.current.settings.masterGain ?? 1),
              ),
            );
            if (playing) void media.play().catch(() => undefined);
          }
          if (
            visual instanceof HTMLVideoElement &&
            visual !== media &&
            Math.abs(visual.currentTime - desired) > 0.08
          ) {
            visual.currentTime = desired;
            visual.muted = true;
            visual.playbackRate = Math.max(0.25, Math.min(4, clip.speed));
            if (playing) void visual.play().catch(() => undefined);
          }
        } else {
          media?.pause();
          if (visual instanceof HTMLVideoElement && visual !== media)
            visual.pause();
        }
      }
      drawCompositionFrame(canvas, projectRef.current, prepared, time, {
        maskMode,
        showMaskGuides: true,
        selectedId,
        showCropGuide: interactionMode === "crop",
      });
    },
    [maskMode, playing, selectedId, interactionMode],
  );
  useEffect(() => {
    draw(playhead);
  }, [playhead, project, draw]);
  useEffect(() => {
    if (!playing) {
      for (const media of preparedRef.current?.audible.values() ?? [])
        media.pause();
      for (const visual of preparedRef.current?.visual.values() ?? [])
        if (visual instanceof HTMLVideoElement) visual.pause();
    }
  }, [playing]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = timeRef.current + (now - last) / 1000;
      last = now;
      if (next >= duration) {
        setPlayhead(0);
        setPlaying(false);
        return;
      }
      setPlayhead(next);
      draw(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, draw, setPlayhead, setPlaying]);
  const saveFrame = () =>
    canvasRef.current?.toBlob((blob) => {
      if (blob)
        downloadBlob(
          blob,
          `videoflow-frame-${formatTime(playhead).replaceAll(":", "-")}.png`,
        );
    }, "image/png");
  const usingProxy = assets.some((asset) => asset.proxyUrl);
  const mixLevel = Math.min(
    1,
    project.clips.reduce((sum, clip) => {
      if (
        clip.kind === "text" ||
        playhead < clip.timelineStart ||
        playhead >= clip.timelineStart + clipDuration(clip) ||
        !isTrackAudible(project, clip.trackId)
      )
        return sum;
      const track = project.tracks.find((entry) => entry.id === clip.trackId);
      const local = playhead - clip.timelineStart;
      const envelope = Math.max(
        0,
        Math.min(
          1,
          clip.fadeIn > 0 ? local / clip.fadeIn : 1,
          clip.fadeOut > 0
            ? (clipDuration(clip) - local) / clip.fadeOut
            : 1,
        ),
      );
      return sum + clip.gain * (track?.gain ?? 1) * envelope;
    }, 0) * (project.settings.masterGain ?? 1),
  );
  const directPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const selected = project.clips.find((clip) => clip.id === selectedId);
    const track = project.tracks.find((entry) => entry.id === selected?.trackId);
    if (!selected || track?.locked || selected.kind === "audio") return;
    event.preventDefault();
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const startX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const startY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    let clientX = event.clientX;
    let clientY = event.clientY;
    const handleThresholdX = 18 / Math.max(1, rect.width);
    const handleThresholdY = 18 / Math.max(1, rect.height);
    const nearCorner = (x: number, y: number, box: { x: number; y: number; width: number; height: number }) => {
      const points = [
        [box.x, box.y, "nw"],
        [box.x + box.width, box.y, "ne"],
        [box.x, box.y + box.height, "sw"],
        [box.x + box.width, box.y + box.height, "se"],
      ] as const;
      return points.find(([px, py]) => Math.abs(x - px) <= handleThresholdX && Math.abs(y - py) <= handleThresholdY)?.[2] ?? null;
    };
    const nearEdge = (x: number, y: number, box: { x: number; y: number; width: number; height: number }) => {
      if (y >= box.y && y <= box.y + box.height) {
        if (Math.abs(x - box.x) <= handleThresholdX) return "w" as const;
        if (Math.abs(x - (box.x + box.width)) <= handleThresholdX) return "e" as const;
      }
      if (x >= box.x && x <= box.x + box.width) {
        if (Math.abs(y - box.y) <= handleThresholdY) return "n" as const;
        if (Math.abs(y - (box.y + box.height)) <= handleThresholdY) return "s" as const;
      }
      return null;
    };
    const activeMask =
      selected.watermarkMasks.find((entry) => entry.enabled) ?? selected.watermarkMasks[0];
    const maskHandle = interactionMode === "mask" && activeMask
      ? nearCorner(startX, startY, activeMask) ?? nearEdge(startX, startY, activeMask)
      : null;
    const cropHandle = interactionMode === "crop" && selected.kind === "video"
      ? nearCorner(startX, startY, selected.transform.crop) ?? nearEdge(startX, startY, selected.transform.crop)
      : null;
    const move = (next: PointerEvent) => {
      clientX = next.clientX;
      clientY = next.clientY;
    };
    const resizeBoxFromCorner = (
      box: { x: number; y: number; width: number; height: number },
      corner: "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w",
      x: number,
      y: number,
    ) => {
      const right = box.x + box.width;
      const bottom = box.y + box.height;
      let left = box.x;
      let top = box.y;
      let nextRight = right;
      let nextBottom = bottom;
      if (corner.includes("w")) left = Math.min(right - 0.01, Math.max(0, x));
      if (corner.includes("e")) nextRight = Math.max(box.x + 0.01, Math.min(1, x));
      if (corner.includes("n")) top = Math.min(bottom - 0.01, Math.max(0, y));
      if (corner.includes("s")) nextBottom = Math.max(box.y + 0.01, Math.min(1, y));
      return { x: left, y: top, width: nextRight - left, height: nextBottom - top };
    };
    const up = () => {
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      if (interactionMode === "mask" && activeMask) {
        const nextGeometry = maskHandle
          ? resizeBoxFromCorner(activeMask, maskHandle, x, y)
          : {
              ...activeMask,
              x: Math.max(0, Math.min(1 - activeMask.width, x - activeMask.width / 2)),
              y: Math.max(0, Math.min(1 - activeMask.height, y - activeMask.height / 2)),
            };
        const next = { ...activeMask, ...nextGeometry };
        onDirectEdit(
          selected.id,
          {
            watermarkMasks: selected.watermarkMasks.map((entry) =>
              entry.id === activeMask.id
                ? activeMask.keyframes.length
                  ? upsertWatermarkKeyframe(next, playhead)
                  : next
                : entry,
            ),
          },
          maskHandle ? "Mask resized in preview" : "Mask moved in preview",
        );
      } else if (interactionMode === "crop" && selected.kind === "video") {
        const crop = selected.transform.crop;
        const nextCrop = cropHandle
          ? resizeBoxFromCorner(crop, cropHandle, x, y)
          : {
              ...crop,
              x: Math.max(0, Math.min(1 - crop.width, x - crop.width / 2)),
              y: Math.max(0, Math.min(1 - crop.height, y - crop.height / 2)),
            };
        onDirectEdit(
          selected.id,
          { transform: { ...selected.transform, crop: nextCrop } },
          cropHandle ? "Crop resized in preview" : "Crop positioned in preview",
        );
      } else if (interactionMode === "rotate") {
        const angle = Math.atan2(y - 0.5, x - 0.5) * (180 / Math.PI) + 90;
        onDirectEdit(
          selected.id,
          { transform: { ...selected.transform, rotation: Math.round(angle * 10) / 10 } },
          "Clip rotated in preview",
        );
      } else if (interactionMode === "resize") {
        const distance = Math.hypot(x - 0.5, y - 0.5);
        const scale = Math.max(0.05, Math.min(10, distance * 2.5));
        onDirectEdit(
          selected.id,
          { transform: { ...selected.transform, scale } },
          "Clip resized in preview",
        );
      } else {
        onDirectEdit(
          selected.id,
          {
            transform: {
              ...selected.transform,
              x: selected.kind === "text" ? x : x - 0.5,
              y: selected.kind === "text" ? y : y - 0.5,
            },
          },
          "Clip positioned in preview",
        );
      }
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };
  return (
    <div className="vf-preview-stage">
      <canvas
        ref={canvasRef}
        width={project.settings.width}
        height={project.settings.height}
        aria-label="Video preview"
        onPointerDown={directPointerDown}
      />
      {selectedId && (
        <div className="vf-direct-controls" aria-label="Direct manipulation mode">
          {(["move", "crop", "resize", "rotate", "mask"] as const).map((mode) => (
            <button
              key={mode}
              className={interactionMode === mode ? "active" : ""}
              onClick={() => setInteractionMode(mode)}
              type="button"
            >
              {mode === "move"
                ? "Move"
                : mode === "crop"
                  ? "Crop"
                  : mode === "resize"
                    ? "Resize"
                    : mode === "rotate"
                      ? "Rotate"
                      : "Watermark"}
            </button>
          ))}
        </div>
      )}
      <div className="vf-mix-meter" aria-label={`Preview mix level ${Math.round(mixLevel * 100)} percent`}>
        <span style={{ height: `${Math.max(3, mixLevel * 100)}%` }} />
      </div>
      {!project.clips.length && (
        <div className="vf-empty-preview">
          <Video />
          <strong>No media on the timeline</strong>
          <span>Import media to begin editing locally.</span>
        </div>
      )}
      <div className="vf-preview-compare" aria-label="Watermark preview mode">
        <button
          className={maskMode === "original" ? "active" : ""}
          onClick={() => setMaskMode("original")}
        >
          Original
        </button>
        <button
          className={maskMode === "processed" ? "active" : ""}
          onClick={() => setMaskMode("processed")}
        >
          Processed
        </button>
        <button
          className={maskMode === "split" ? "active" : ""}
          onClick={() => setMaskMode("split")}
        >
          Split
        </button>
      </div>
      <div className="vf-preview-badge">
        <span className="vf-dot" />{" "}
        {usingProxy
          ? "Proxy preview"
          : `${project.settings.previewQuality} preview`}
      </div>
      <button
        className="vf-frame-button"
        onClick={saveFrame}
        disabled={!project.clips.length}
      >
        <Download /> Current frame
      </button>
    </div>
  );
}

function Timeline({
  project,
  selectedId,
  playhead,
  zoom,
  setSelectedId,
  setPlayhead,
  moveClip,
  trimClip,
  updateTrack,
}: {
  project: VideoFlowProject;
  selectedId: string | null;
  playhead: number;
  zoom: number;
  setSelectedId: (id: string) => void;
  setPlayhead: (time: number) => void;
  moveClip: (id: string, start: number) => void;
  trimClip: (id: string, side: "start" | "end", delta: number) => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
}) {
  const scale = 78 * zoom;
  const duration = Math.max(10, projectDuration(project) + 5);
  const width = Math.max(900, duration * scale);
  const pointerDown = (
    event: React.PointerEvent,
    clip: Clip,
    mode: "move" | "start" | "end",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const track = project.tracks.find((entry) => entry.id === clip.trackId);
    if (track?.locked) return;
    setSelectedId(clip.id);
    const originX = event.clientX;
    const originStart = clip.timelineStart;
    let finalDelta = 0;
    const move = (next: PointerEvent) => {
      finalDelta = (next.clientX - originX) / scale;
    };
    const up = () => {
      const delta = finalDelta;
      if (mode === "move") {
        const raw = Math.max(0, originStart + delta);
        const points = project.settings.snapping
          ? [
              0,
              playhead,
              ...project.clips
                .filter((entry) => entry.id !== clip.id)
                .flatMap((entry) => [
                  entry.timelineStart,
                  entry.timelineStart + clipDuration(entry),
                ]),
            ]
          : [];
        moveClip(
          clip.id,
          project.settings.snapping
            ? snapTime(raw, points, project.settings.snapSeconds)
            : raw,
        );
      } else trimClip(clip.id, mode, delta);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };
  return (
    <section className="vf-timeline" aria-label="Timeline editor">
      <div className="vf-track-labels">
        <div className="vf-ruler-label">Tracks</div>
        {project.tracks.map((track) => (
          <div className="vf-track-label" key={track.id}>
            <span>{track.name}</span>
            <button
              className={track.muted ? "active" : ""}
              aria-label={`${track.muted ? "Unmute" : "Mute"} ${track.name}`}
              onClick={() => updateTrack(track.id, { muted: !track.muted })}
            >
              M
            </button>
            <button
              className={track.solo ? "active" : ""}
              aria-label={`${track.solo ? "Unsolo" : "Solo"} ${track.name}`}
              onClick={() => updateTrack(track.id, { solo: !track.solo })}
            >
              S
            </button>
            <button
              className={!track.visible ? "active" : ""}
              aria-label={`${track.visible ? "Hide" : "Show"} ${track.name}`}
              onClick={() => updateTrack(track.id, { visible: !track.visible })}
            >
              {track.visible ? <Eye /> : <EyeOff />}
            </button>
            <button
              className={track.locked ? "active" : ""}
              aria-label={`${track.locked ? "Unlock" : "Lock"} ${track.name}`}
              onClick={() => updateTrack(track.id, { locked: !track.locked })}
            >
              {track.locked ? <LockKeyhole /> : <LockOpen />}
            </button>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={track.gain}
              aria-label={`${track.name} gain`}
              title={`${Math.round(track.gain * 100)}% gain`}
              onChange={(event) =>
                updateTrack(track.id, { gain: Number(event.target.value) })
              }
            />
          </div>
        ))}
      </div>
      <div className="vf-timeline-scroll">
        <div
          className="vf-timeline-canvas"
          style={{ width }}
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setPlayhead(Math.max(0, (event.clientX - rect.left) / scale));
          }}
        >
          <div className="vf-ruler" style={{ width }}>
            {Array.from({ length: Math.ceil(duration) + 1 }, (_, second) => (
              <span key={second} style={{ left: second * scale }}>
                <i />
                {second % 5 === 0 ? formatTime(second, false).slice(3) : ""}
              </span>
            ))}
          </div>
          {project.tracks.map((track) => (
            <div className="vf-track" key={track.id} style={{ width }}>
              {project.clips
                .filter((clip) => clip.trackId === track.id)
                .map((clip) => (
                  <button
                    key={clip.id}
                    type="button"
                    className={`vf-clip vf-clip-${clip.kind} ${selectedId === clip.id ? "selected" : ""}`}
                    disabled={track.locked}
                    style={{
                      left: clip.timelineStart * scale,
                      width: Math.max(18, clipDuration(clip) * scale),
                    }}
                    onPointerDown={(event) => pointerDown(event, clip, "move")}
                  >
                    <span
                      className="vf-trim-handle left"
                      onPointerDown={(event) =>
                        pointerDown(event, clip, "start")
                      }
                    />
                    <span className="vf-clip-name">
                      {clip.kind === "text" ? (
                        <Type />
                      ) : clip.kind === "audio" ? (
                        <AudioLines />
                      ) : (
                        <Film />
                      )}
                      {clip.name}
                    </span>
                    {clip.keyframes.map((keyframe) => (
                      <span
                        key={keyframe.id}
                        className="vf-keyframe-marker"
                        title={`${keyframe.property} keyframe at ${formatTime(keyframe.time)}`}
                        style={{
                          left: Math.max(
                            2,
                            Math.min(
                              clipDuration(clip) * scale - 4,
                              (keyframe.time - clip.timelineStart) * scale,
                            ),
                          ),
                        }}
                      />
                    ))}
                    <span
                      className="vf-trim-handle right"
                      onPointerDown={(event) => pointerDown(event, clip, "end")}
                    />
                  </button>
                ))}
            </div>
          ))}
          <div className="vf-playhead" style={{ left: playhead * scale }}>
            <span />
          </div>
        </div>
      </div>
    </section>
  );
}

export function VideoFlowApp() {
  const { theme, setTheme } = useTheme();
  const [view, setView] = useState<View>("editor");
  const [project, setProject] = useState<VideoFlowProject>(() =>
    blankProject(),
  );
  const [assets, setAssets] = useState<RuntimeAsset[]>([]);
  const [recent, setRecent] = useState<VideoFlowProject[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [past, setPast] = useState<VideoFlowProject[]>([]);
  const [future, setFuture] = useState<VideoFlowProject[]>([]);
  const [commandOpen, setCommandOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [savedAt, setSavedAt] = useState("Not saved yet");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [subtitlesOpen, setSubtitlesOpen] = useState(false);
  const [quickTool, setQuickTool] = useState<string | null>(null);
  const [largeMediaPrompt, setLargeMediaPrompt] = useState<{
    asset: RuntimeAsset;
    resolve: (choice: { mode: "session" | "reference"; file?: File; handle?: FileSystemFileHandle }) => void;
  } | null>(null);
  const [pwaUpdateWorker, setPwaUpdateWorker] = useState<ServiceWorker | null>(null);
  const pwaReloadRequestedRef = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const relinkRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);
  const assetsRef = useRef(assets);
  const exportQueue = useExportQueue();
  const selected = useMemo(
    () => project.clips.find((clip) => clip.id === selectedId) ?? null,
    [project.clips, selectedId],
  );
  const selectedTrackLocked = Boolean(
    project.tracks.find((track) => track.id === selected?.trackId)?.locked,
  );
  const totalDuration = projectDuration(project);
  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let reloading = false;
    const controllerChanged = () => {
      // A newly installed service worker may claim this page on first load.
      // That must never interrupt imports/edits. Reload only after the user
      // explicitly accepted an already-installed update via Restart & Update.
      if (!pwaReloadRequestedRef.current || reloading) return;
      reloading = true;
      pwaReloadRequestedRef.current = false;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
    void navigator.serviceWorker
      .register(deploymentAssetUrl("service-worker.js"), {
        scope: deploymentBaseUrl().pathname,
      })
      .then((registration) => {
        if (registration.waiting) setPwaUpdateWorker(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller)
              setPwaUpdateWorker(installing);
          });
        });
      })
      .catch(() => undefined);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
  }, []);
  useEffect(() => {
    void listSnapshots(project.id)
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
  }, [project.id]);
  useEffect(() => {
    const next = { ...project, updatedAt: new Date().toISOString() };
    void saveRecovery(next).catch(() => undefined);
    const timer = window.setTimeout(() => {
      void saveProject(next)
        .then(() => clearRecovery())
        .then(() => {
          setSavedAt("Saved locally • just now");
          setRecent((items) =>
            [next, ...items.filter((item) => item.id !== next.id)].slice(0, 8),
          );
        })
        .catch((error) =>
          toast.error("Local save failed", { description: String(error) }),
        );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [project]);
  const commit = useCallback(
    (
      label: string,
      mutate: (current: VideoFlowProject) => VideoFlowProject,
    ) => {
      setProject((current) => {
        const next = mutate(structuredClone(current));
        next.revision = current.revision + 1;
        next.updatedAt = new Date().toISOString();
        setPast((items) => [...items.slice(-49), current]);
        setFuture([]);
        return next;
      });
      setSavedAt(`${label} • saving…`);
    },
    [],
  );
  const undo = useCallback(
    () =>
      setPast((items) => {
        const previous = items.at(-1);
        if (!previous) return items;
        setProject((current) => {
          setFuture((next) => [current, ...next].slice(0, 50));
          return previous;
        });
        return items.slice(0, -1);
      }),
    [],
  );
  const redo = useCallback(
    () =>
      setFuture((items) => {
        const next = items[0];
        if (!next) return items;
        setProject((current) => {
          setPast((previous) => [...previous.slice(-49), current]);
          return next;
        });
        return items.slice(1);
      }),
    [],
  );
  const openStored = useCallback(
    async (id: string, fallback?: VideoFlowProject) => {
      try {
        const stored = fallback ?? (await loadProject(id));
        if (!stored) throw new Error("Project not found.");
        revokeAssets(assetsRef.current);
        const rows = await loadAssets(id);
        const restoredAssets = await Promise.all(
          rows.map(async (row) => {
            const normalizedMode =
              (row.storageMode as string) === "persistent"
                ? "persisted"
                : row.storageMode ?? (row.blob ? "persisted" : "session");
            const runtime: RuntimeAsset = {
              ...row,
              storageMode: normalizedMode,
              ...(row.blob ? { blob: row.blob, url: URL.createObjectURL(row.blob) } : {}),
              ...(row.proxyBlob
                ? { proxyBlob: row.proxyBlob, proxyUrl: URL.createObjectURL(row.proxyBlob) }
                : {}),
              offline: !row.blob,
            };
            return normalizedMode === "reference"
              ? reconnectAssetFromHandle(runtime)
              : runtime;
          }),
        );
        setAssets(restoredAssets);
        setProject(migrateProject(stored) as VideoFlowProject);
        void clearRecovery();
        setPast([]);
        setFuture([]);
        setSelectedId(null);
        setPlayhead(0);
        setView("editor");
      } catch (error) {
        toast.error("Could not open project", { description: String(error) });
      }
    },
    [],
  );
  useEffect(() => {
    void listProjects().then(setRecent);
    void loadRecovery().then((recovery) => {
      if (recovery)
        toast.info("An unfinished session is available.", {
          action: {
            label: "Restore",
            onClick: () =>
              void openStored(recovery.project.id, recovery.project),
          },
        });
    });
    return () => revokeAssets(assetsRef.current);
  }, [openStored]);
  const newProject = () => {
    void clearRecovery();
    revokeAssets(assets);
    setAssets([]);
    setProject(blankProject());
    setPast([]);
    setFuture([]);
    setSelectedId(null);
    setPlayhead(0);
    setView("editor");
  };
  const refreshProjects = () => void listProjects().then(setRecent);
  const renameStoredProject = async (id: string) => {
    const stored = await loadProject(id);
    if (!stored) return;
    const name = window.prompt("Project name", stored.name)?.trim();
    if (!name) return;
    const renamed = { ...stored, name: name.slice(0, 120), updatedAt: new Date().toISOString() };
    await saveProject(renamed);
    if (project.id === id) setProject((current) => ({ ...current, name: renamed.name }));
    refreshProjects();
  };
  const duplicateStoredProject = async (id: string) => {
    const stored = await loadProject(id);
    if (!stored) return;
    const rows = await loadAssets(id);
    const nextId = uid("project");
    const assetIds = new Map(rows.map((asset) => [asset.id, uid("asset")]));
    const copy: VideoFlowProject = {
      ...structuredClone(stored),
      id: nextId,
      name: `${stored.name} copy`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 0,
      clips: stored.clips.map((clip) => ({
        ...structuredClone(clip),
        id: uid("clip"),
        assetId: clip.assetId ? assetIds.get(clip.assetId) : undefined,
      })),
    };
    await Promise.all([
      saveProject(copy),
      ...rows.map((asset) =>
        saveAsset({
          ...asset,
          id: assetIds.get(asset.id)!,
          projectId: nextId,
          createdAt: new Date().toISOString(),
        }),
      ),
    ]);
    refreshProjects();
    toast.success("Project duplicated");
  };
  const removeStoredProject = async (id: string) => {
    const stored = await loadProject(id);
    if (!stored || !window.confirm(`Delete “${stored.name}” and its stored media?`)) return;
    const [rows, storedSnapshots] = await Promise.all([loadAssets(id), listSnapshots(id)]);
    await Promise.all([
      deleteProject(id),
      ...rows.map((asset) => deleteAsset(asset.id)),
      ...storedSnapshots.map((snapshot) => deleteSnapshot(snapshot.id)),
    ]);
    if (project.id === id) newProject();
    refreshProjects();
    toast.success("Project deleted");
  };
  const chooseLargeMediaStorage = (asset: RuntimeAsset) =>
    new Promise<{ mode: "session" | "reference"; file?: File; handle?: FileSystemFileHandle }>((resolve) => {
      setLargeMediaPrompt({ asset, resolve });
    });
  const importFiles = async (
    files: FileList | File[],
    handles = new Map<File, FileSystemFileHandle>(),
  ) => {
    const accepted: RuntimeAsset[] = [];
    const errors: string[] = [];
    const sessionOnly: RuntimeAsset[] = [];
    const referenced: RuntimeAsset[] = [];
    for (const file of Array.from(files))
      try {
        const fileHandle = handles.get(file);
        let asset = await inspectFile(file, project.id, {
          fileHandle,
          storageMode: fileHandle ? "reference" : undefined,
        });
        if (
          assets.some(
            (entry) =>
              entry.name === asset.name &&
              entry.size === asset.size &&
              entry.signature === asset.signature,
          )
        ) {
          if (asset.url) URL.revokeObjectURL(asset.url);
          throw new Error(`${file.name} is already imported.`);
        }
        if (asset.kind === "subtitle") {
          const cues = parseSrt((await file.text()).replace(/^WEBVTT\s*/i, ""));
          if (!cues.length)
            throw new Error(`${file.name} contains no valid cues.`);
          commit("Subtitles imported", (current) => ({
            ...current,
            subtitles: [...current.subtitles, ...cues],
          }));
        } else {
          let storage = await decideFileStorage(asset.size, {
            hasPersistentHandle: Boolean(asset.fileHandle),
            forceReference: Boolean(asset.fileHandle),
          });
          asset.risk = storage.risk;
          if (!asset.fileHandle && storage.risk !== "normal") {
            const choice = await chooseLargeMediaStorage(asset);
            if (choice.mode === "reference" && choice.file && choice.handle) {
              const relinked = await relinkRuntimeAsset(asset, choice.file, choice.handle);
              asset = { ...relinked.asset, risk: storage.risk };
              storage = { ...storage, mode: "reference" };
            } else {
              storage = { ...storage, mode: "session" };
            }
          }
          asset.storageMode = storage.mode;
          try {
            if (storage.mode === "persisted") await navigator.storage?.persist?.();
            await saveAsset(asset);
          } catch {
            asset.storageMode = "session";
            asset.fileHandle = undefined;
            await saveAsset(asset).catch(() => undefined);
          }
          if (asset.storageMode === "session") sessionOnly.push(asset);
          if (asset.storageMode === "reference") referenced.push(asset);
          accepted.push(asset);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    if (accepted.length) {
      setAssets((items) => [...items, ...accepted]);
      commit("Media imported", (current) => {
        const firstImportedVideo = current.clips.some((clip) => clip.kind === "video")
          ? undefined
          : accepted.find((asset) => asset.kind === "video" && asset.width > 0 && asset.height > 0);
        let videoEnd = current.clips
          .filter((clip) => clip.trackId === "v1")
          .reduce(
            (max, clip) =>
              Math.max(max, clip.timelineStart + clipDuration(clip)),
            0,
          );
        let audioEnd = current.clips
          .filter((clip) => clip.trackId === "a1")
          .reduce(
            (max, clip) =>
              Math.max(max, clip.timelineStart + clipDuration(clip)),
            0,
          );
        const clips = [...current.clips];
        for (const asset of accepted) {
          const track = asset.kind === "audio" ? "a1" : "v1";
          const clip = makeClip(
            asset,
            track,
            track === "a1" ? audioEnd : videoEnd,
          );
          clips.push(clip);
          if (track === "a1") audioEnd += clipDuration(clip);
          else videoEnd += clipDuration(clip);
        }
        return {
          ...current,
          clips,
          settings: firstImportedVideo ? {
            ...current.settings,
            width: firstImportedVideo.width,
            height: firstImportedVideo.height,
            fps: firstImportedVideo.frameRate ?? current.settings.fps,
          } : current.settings,
        };
      });
      setView("editor");
      toast.success(
        `${accepted.length} local file${accepted.length === 1 ? "" : "s"} imported`,
      );
      if (referenced.length)
        toast.success(
          `${referenced.length} source${referenced.length === 1 ? "" : "s"} imported by reference`,
          {
            description:
              "The original stays outside IndexedDB. VideoFlow will reconnect the file handle after restart when browser permission allows.",
          },
        );
      if (sessionOnly.length)
        toast.warning(
          `${sessionOnly.length} file${sessionOnly.length === 1 ? " is" : "s are"} session-attached`,
          {
            description:
              "The project metadata is saved without copying the original. Generate a proxy to keep editing after restart, then relink the original for final export.",
          },
        );
      const demanding = accepted.find(
        (asset) =>
          asset.kind === "video" &&
          (asset.width >= 3840 ||
            asset.height >= 2160 ||
            asset.size >= 500 * 1024 * 1024 ||
            asset.nativeDecodable === false),
      );
      if (demanding)
        toast.warning("Large or compatibility-sensitive media detected", {
          description:
            "Generate an editing proxy in Video Tools for a more responsive preview.",
          action: { label: "Open tools", onClick: () => setView("tools") },
        });
    }
    if (errors.length)
      toast.warning("Some files were not imported", {
        description: errors.join(" • "),
      });
  };
  const addText = () => {
    if (project.tracks.find((track) => track.id === "t1")?.locked) {
      toast.info("Unlock T1 before adding text.");
      return;
    }
    const clip: Clip = {
      id: uid("text"),
      trackId: "t1",
      kind: "text",
      name: "Title",
      timelineStart: playhead,
      sourceStart: 0,
      sourceEnd: 5,
      speed: 1,
      gain: 1,
      opacity: 1,
      transform: { ...structuredClone(DEFAULT_TRANSFORM), x: 0.5, y: 0.82 },
      text: "Your title",
      fontSize: 58,
      color: "#ffffff",
      background: "rgba(0,0,0,.6)",
      textStyle: {
        fontFamily: "system-ui",
        fontWeight: 600,
        italic: false,
        align: "center",
        lineHeight: 1.15,
        letterSpacing: 0,
        strokeColor: "rgba(0,0,0,.78)",
        strokeWidth: 2,
        shadowColor: "rgba(0,0,0,.45)",
        shadowBlur: 4,
        backgroundOpacity: 0.6,
        padding: 18,
        preset: "title",
      },
      fadeIn: 0,
      fadeOut: 0,
      keyframes: [],
      watermarkMasks: [],
    };
    commit("Text added", (current) => ({
      ...current,
      clips: [...current.clips, clip],
    }));
    setSelectedId(clip.id);
  };
  const splitSelected = useCallback(() => {
    if (!selected) return;
    if (selectedTrackLocked) return toast.info("Unlock the track before editing this clip.");
    const local = playhead - selected.timelineStart;
    if (local <= 0.05 || local >= clipDuration(selected) - 0.05)
      return toast.warning("Move the playhead inside the selected clip.");
    const sourceSplit = selected.sourceStart + local * selected.speed;
    const left = { ...selected, sourceEnd: sourceSplit };
    const right = {
      ...selected,
      id: uid("clip"),
      timelineStart: playhead,
      sourceStart: sourceSplit,
      name: `${selected.name} • split`,
    };
    commit("Clip split", (current) => ({
      ...current,
      clips: current.clips.flatMap((clip) =>
        clip.id === selected.id ? [left, right] : [clip],
      ),
    }));
    setSelectedId(right.id);
  }, [selected, selectedTrackLocked, playhead, commit]);
  const deleteSelected = useCallback(() => {
    if (!selected) return;
    if (selectedTrackLocked) return toast.info("Unlock the track before editing this clip.");
    commit("Clip removed", (current) => ({
      ...current,
      clips: current.clips.filter((clip) => clip.id !== selected.id),
    }));
    setSelectedId(null);
  }, [selected, selectedTrackLocked, commit]);
  const addMask = () => {
    if (!selected || selected.kind !== "video")
      return toast.info("Select a video clip first.");
    if (selectedTrackLocked) return toast.info("Unlock the track before editing this clip.");
    const mask: WatermarkMask = {
      id: uid("mask"),
      shape: "rectangle",
      method: "blur",
      x: 0.72,
      y: 0.07,
      width: 0.2,
      height: 0.12,
      start: selected.timelineStart,
      end: selected.timelineStart + clipDuration(selected),
      feather: 10,
      enabled: true,
      keyframes: [],
    };
    commit("Watermark region added", (current) =>
      updateClip(current, selected.id, {
        watermarkMasks: [...selected.watermarkMasks, mask],
      }),
    );
  };
  const runQuickTool = (label: string) => setQuickTool(label);
  const importReferenceMedia = async () => {
    try {
      const picked = await pickReferenceFiles();
      const handles = new Map<File, FileSystemFileHandle>(
        picked.map(({ file, handle }) => [file, handle]),
      );
      await importFiles(picked.map(({ file }) => file), handles);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("Reference import unavailable", { description: String(error) });
    }
  };

  const relinkReferenceOriginals = async () => {
    try {
      const picked = await pickReferenceFiles();
      const offline = [...assetsRef.current.filter((asset) => asset.offline || !asset.blob)];
      let relinked = 0;
      for (const { file, handle } of picked) {
        const candidates = offline
          .filter((asset) => asset.size === file.size || asset.name === file.name)
          .sort((a, b) => Number(b.name === file.name) - Number(a.name === file.name));
        for (const candidate of candidates) {
          try {
            const result = await relinkRuntimeAsset(candidate, file, handle);
            await saveAsset(result.asset);
            setAssets((items) =>
              items.map((entry) => (entry.id === result.asset.id ? result.asset : entry)),
            );
            const index = offline.findIndex((entry) => entry.id === candidate.id);
            if (index >= 0) offline.splice(index, 1);
            relinked += 1;
            break;
          } catch {
            // Continue until a fingerprint match is found.
          }
        }
      }
      if (relinked) toast.success(`${relinked} original source${relinked === 1 ? "" : "s"} relinked by reference`);
      if (offline.length) toast.warning(`${offline.length} original source${offline.length === 1 ? " is" : "s are"} still offline`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("Relink failed", { description: String(error) });
    }
  };

  const relinkFiles = async (files: FileList | File[]) => {
    const offline = assetsRef.current.filter((asset) => asset.offline || !asset.blob);
    if (!offline.length) {
      toast.info("All original media is currently online.");
      return;
    }
    const remaining = [...offline];
    let relinked = 0;
    for (const file of Array.from(files)) {
      const candidates = remaining
        .filter((asset) => asset.size === file.size || asset.name === file.name)
        .sort((a, b) => Number(b.name === file.name) - Number(a.name === file.name));
      for (const candidate of candidates) {
        try {
          const result = await relinkRuntimeAsset(candidate, file);
          const updated = result.asset;
          await saveAsset(updated);
          setAssets((items) =>
            items.map((entry) => (entry.id === updated.id ? updated : entry)),
          );
          const index = remaining.findIndex((entry) => entry.id === candidate.id);
          if (index >= 0) remaining.splice(index, 1);
          relinked += 1;
          break;
        } catch {
          // Mismatched files are never silently accepted.
        }
      }
    }
    if (relinked)
      toast.success(`${relinked} original source${relinked === 1 ? "" : "s"} relinked`);
    if (remaining.length)
      toast.warning(`${remaining.length} original source${remaining.length === 1 ? " is" : "s are"} still offline`);
  };

  const exportBackup = () =>
    downloadBlob(
      new Blob([serializeProject(project)], { type: "application/json" }),
      `${project.name.replace(/[^a-z0-9-_]+/gi, "-")}.videoFlowProject.json`,
    );
  const importBackup = async (file: File) => {
    try {
      const restored = migrateProject(
        JSON.parse(await file.text()),
      ) as VideoFlowProject;
      revokeAssets(assets);
      setAssets([]);
      setProject(restored);
      setPast([]);
      setFuture([]);
      setSelectedId(null);
      setPlayhead(0);
      toast.success("Project metadata restored", {
        description: "Relink or import the original media files to continue.",
      });
    } catch (error) {
      toast.error("Project backup could not be opened", {
        description: String(error),
      });
    }
  };
  const createSnapshot = async () => {
    const snapshot: SnapshotRecord = {
      id: uid("snapshot"),
      projectId: project.id,
      name: `Revision ${project.revision}`,
      createdAt: new Date().toISOString(),
      revision: project.revision,
      project: structuredClone(project),
    };
    await saveSnapshot(snapshot);
    setSnapshots((items) => [snapshot, ...items]);
    toast.success("Project snapshot created");
  };
  const renameSnapshotRecord = async (snapshot: SnapshotRecord) => {
    const name = window.prompt("Snapshot name", snapshot.name)?.trim();
    if (!name) return;
    const updated = { ...snapshot, name: name.slice(0, 120) };
    await saveSnapshot(updated);
    setSnapshots((items) => items.map((item) => item.id === snapshot.id ? updated : item));
    toast.success("Snapshot renamed");
  };
  const removeSnapshotRecord = async (snapshot: SnapshotRecord) => {
    if (!window.confirm(`Delete snapshot “${snapshot.name}”?`)) return;
    await deleteSnapshot(snapshot.id);
    setSnapshots((items) => items.filter((item) => item.id !== snapshot.id));
    toast.success("Snapshot deleted");
  };
  const updateProxy = async (
    assetId: string,
    proxyBlob: Blob | null,
    quality: ProxyQuality = "balanced",
  ) => {
    const asset = assetsRef.current.find((entry) => entry.id === assetId);
    if (!asset) throw new Error("The source asset is no longer available.");
    if (asset.proxyUrl) URL.revokeObjectURL(asset.proxyUrl);
    const target =
      quality === "low"
        ? { width: 640, height: 360, fps: 24 }
        : quality === "high"
          ? { width: 1280, height: 720, fps: 30 }
          : { width: 960, height: 540, fps: 30 };
    const ratio = Math.min(
      target.width / Math.max(1, asset.width),
      target.height / Math.max(1, asset.height),
      1,
    );
    const updated: RuntimeAsset = proxyBlob
      ? {
          ...asset,
          proxyBlob,
          proxyUrl: URL.createObjectURL(proxyBlob),
          proxy: {
            mime: proxyBlob.type || "video/mp4",
            size: proxyBlob.size,
            width: Math.max(2, Math.round((asset.width * ratio) / 2) * 2),
            height: Math.max(2, Math.round((asset.height * ratio) / 2) * 2),
            fps: target.fps,
            duration: asset.duration,
            sourceDuration: asset.duration,
            quality,
            createdAt: new Date().toISOString(),
          },
        }
      : {
          ...asset,
          proxy: undefined,
          proxyBlob: undefined,
          proxyUrl: undefined,
        };
    // Proxies are persisted independently from the original source mode.
    await saveAsset(updated);
    setAssets((items) =>
      items.map((entry) => (entry.id === assetId ? updated : entry)),
    );
  };
  const installPwaUpdate = async () => {
    if (!pwaUpdateWorker) return;
    const safeProject = { ...project, updatedAt: new Date().toISOString() };
    try {
      await saveProject(safeProject);
      await clearRecovery();
      pwaReloadRequestedRef.current = true;
      pwaUpdateWorker.postMessage({ type: "SKIP_WAITING" });
    } catch (error) {
      toast.error("Update postponed", {
        description: `VideoFlow could not save the open project safely: ${String(error)}`,
      });
    }
  };
  const queueExport = (settings: ExportSettings, targetHandle?: FileSystemFileHandle) => {
    exportQueue.enqueue(project, assets, settings, targetHandle);
    toast.success("Export added to the local queue", {
      action: { label: "View queue", onClick: () => setView("exports") },
    });
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing =
        /INPUT|TEXTAREA|SELECT/.test(target.tagName) ||
        target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (event.key === " ") {
        event.preventDefault();
        setPlaying((value) => !value);
      } else if (event.key.toLowerCase() === "s") splitSelected();
      else if (event.key === "Delete" || event.key === "Backspace")
        deleteSelected();
      else if (event.key === "ArrowLeft")
        setPlayhead((value) => Math.max(0, value - 1 / project.settings.fps));
      else if (event.key === "ArrowRight")
        setPlayhead((value) =>
          Math.min(totalDuration, value + 1 / project.settings.fps),
        );
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    undo,
    redo,
    splitSelected,
    deleteSelected,
    project.settings.fps,
    totalDuration,
  ]);

  return (
    <div className="vf-app">
      <input
        ref={importRef}
        data-testid="media-import"
        className="sr-only"
        type="file"
        multiple
        accept="video/*,audio/*,image/*,.srt,.vtt"
        onChange={(event) => {
          if (event.target.files) void importFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={relinkRef}
        data-testid="media-relink"
        className="sr-only"
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        onChange={(event) => {
          if (event.target.files) void relinkFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={backupRef}
        className="sr-only"
        type="file"
        accept=".json,.videoFlowProject"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importBackup(file);
          event.target.value = "";
        }}
      />
      <header className="vf-topbar">
        <div className="vf-brand">
          <button
            className="vf-mobile-menu"
            onClick={() => setSidebarOpen((value) => !value)}
            aria-label="Toggle navigation"
          >
            <Menu />
          </button>
          <span className="vf-mark">
            <Play />
          </span>
          <strong>VideoFlow</strong>
          <em>PRO</em>
        </div>
        <nav className="vf-menubar">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button>Project</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={newProject}>
                New project
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => importRef.current?.click()}>
                Import media
              </DropdownMenuItem>
              {supportsReferenceImport() && (
                <DropdownMenuItem onSelect={() => void importReferenceMedia()}>
                  Reference original + proxy workflow
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() =>
                  supportsReferenceImport()
                    ? void relinkReferenceOriginals()
                    : relinkRef.current?.click()
                }
              >
                Relink offline originals
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={exportBackup}>
                Export project metadata
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => backupRef.current?.click()}>
                Import project metadata
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void createSnapshot()}>
                Create snapshot
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button onClick={undo}>Edit</button>
          <button onClick={() => setView("editor")}>View</button>
          <button onClick={() => setView("tools")}>Tools</button>
          <button onClick={() => setSubtitlesOpen(true)}>Subtitles</button>
          <button onClick={() => setExportOpen(true)}>Export</button>
        </nav>
        <div className="vf-top-actions">
          <span className="vf-local-pill">
            <LockKeyhole /> Local Mode
          </span>
          <button
            className="vf-icon-btn"
            onClick={() => setCommandOpen(true)}
            aria-label="Search"
          >
            <Search />
          </button>
          <button
            className="vf-icon-btn"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
          <Button size="sm" onClick={() => setExportOpen(true)}>
            <Upload /> Export
          </Button>
        </div>
      </header>
      {pwaUpdateWorker && (
        <div className="vf-update-banner" role="status">
          <div>
            <strong>Update ready</strong>
            <span>Your open project will be saved before VideoFlow restarts.</span>
          </div>
          <Button size="sm" onClick={() => void installPwaUpdate()}>Restart & Update</Button>
          <Button size="sm" variant="outline" onClick={() => setPwaUpdateWorker(null)}>Later</Button>
        </div>
      )}
      <div className="vf-body">
        <aside className={`vf-sidebar ${sidebarOpen ? "open" : ""}`}>
          <nav>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                onClick={() => {
                  setView(item.id);
                  setSidebarOpen(false);
                }}
              >
                <item.icon />
                {item.label}
                {item.id === "exports" && exportQueue.jobs.length > 0 && (
                  <b className="vf-nav-count">{exportQueue.jobs.length}</b>
                )}
              </button>
            ))}
          </nav>
          <div className="vf-privacy-card">
            <div>
              <LockKeyhole />
              <strong>Private by design</strong>
            </div>
            <span>Files uploaded</span>
            <b>0</b>
            <span>Cloud processing</span>
            <b>Off</b>
            <span>Telemetry</span>
            <b>Off</b>
          </div>
          <div className="vf-version">
            VideoFlow 1.0.0 <span>PWA build pwa9</span>
          </div>
        </aside>
        <main className="vf-main">
          {view === "editor" ? (
            <div className="vf-editor">
              <section className="vf-workspace">
                <MediaPanel
                  assets={assets}
                  importMedia={() => importRef.current?.click()}
                  place={(asset) => {
                    const targetTrack = asset.kind === "audio" ? "a2" : "v2";
                    if (project.tracks.find((track) => track.id === targetTrack)?.locked) {
                      toast.info(`Unlock ${targetTrack.toUpperCase()} before placing media.`);
                      return;
                    }
                    const clip = makeClip(
                      asset,
                      targetTrack,
                      playhead,
                    );
                    commit("Media placed", (current) => ({
                      ...current,
                      clips: [...current.clips, clip],
                    }));
                    setSelectedId(clip.id);
                  }}
                />
                <section className="vf-preview-panel">
                  <div className="vf-preview-toolbar">
                    <span>{project.name}</span>
                    <div aria-label="Preview status">
                      <span>Fit to panel</span>
                      <span className="active">
                        {assets.some((asset) => asset.proxy)
                          ? "Proxy"
                          : "Local"}
                      </span>
                    </div>
                  </div>
                  <Preview
                    project={project}
                    assets={assets}
                    playhead={playhead}
                    setPlayhead={setPlayhead}
                    playing={playing}
                    setPlaying={setPlaying}
                    selectedId={selectedId}
                    onDirectEdit={(id, patch, label) =>
                      commit(label, (current) => {
                        const clip = current.clips.find((entry) => entry.id === id);
                        if (!clip) return current;
                        let next = { ...clip, ...patch } as Clip;
                        for (const property of ["x", "y"] as const) {
                          if (
                            patch.transform &&
                            clip.keyframes.some((keyframe) => keyframe.property === property)
                          )
                            next = upsertPropertyKeyframe(
                              next,
                              property,
                              playhead,
                              patch.transform[property],
                            ) as Clip;
                        }
                        return updateClip(current, id, next);
                      })
                    }
                  />
                  <div className="vf-transport">
                    <span className="vf-timecode">{formatTime(playhead)}</span>
                    <div>
                      <button
                        aria-label="Previous frame"
                        onClick={() =>
                          setPlayhead((value) =>
                            Math.max(0, value - 1 / project.settings.fps),
                          )
                        }
                      >
                        ‹
                      </button>
                      <button
                        className="vf-play"
                        aria-label={playing ? "Pause" : "Play"}
                        onClick={() => setPlaying(!playing)}
                      >
                        {playing ? <Pause /> : <Play />}
                      </button>
                      <button
                        aria-label="Next frame"
                        onClick={() =>
                          setPlayhead((value) =>
                            Math.min(
                              totalDuration,
                              value + 1 / project.settings.fps,
                            ),
                          )
                        }
                      >
                        ›
                      </button>
                    </div>
                    <span className="vf-timecode muted">
                      {formatTime(totalDuration)}
                    </span>
                  </div>
                </section>
                <Inspector
                  selected={selected}
                  locked={selectedTrackLocked}
                  playhead={playhead}
                  setPlayhead={setPlayhead}
                  commit={commit}
                  addMask={addMask}
                  asset={assets.find((asset) => asset.id === selected?.assetId)}
                />
              </section>
              <div className="vf-editbar">
                <div>
                  <button onClick={undo} disabled={!past.length}>
                    <Undo2 /> Undo
                  </button>
                  <button onClick={redo} disabled={!future.length}>
                    <Redo2 /> Redo
                  </button>
                  <span />
                  <button onClick={splitSelected} disabled={!selected}>
                    <Scissors /> Split
                  </button>
                  <button onClick={addText}>
                    <Type /> Add text
                  </button>
                  <button onClick={deleteSelected} disabled={!selected}>
                    <Trash2 /> Delete
                  </button>
                </div>
                <div>
                  <span>Master</span>
                  <Slider
                    className="vf-zoom"
                    min={0}
                    max={2}
                    step={0.05}
                    value={[project.settings.masterGain]}
                    onValueCommit={([masterGain]) =>
                      commit("Master gain changed", (current) => ({
                        ...current,
                        settings: { ...current.settings, masterGain },
                      }))
                    }
                  />
                  <span>Snapping</span>
                  <Switch
                    checked={project.settings.snapping}
                    onCheckedChange={(checked) =>
                      commit("Snapping changed", (current) => ({
                        ...current,
                        settings: { ...current.settings, snapping: checked },
                      }))
                    }
                  />
                  <span>Zoom</span>
                  <Slider
                    className="vf-zoom"
                    min={0.25}
                    max={4}
                    step={0.05}
                    value={[zoom]}
                    onValueChange={([value]) => setZoom(value)}
                  />
                </div>
              </div>
              <Timeline
                project={project}
                selectedId={selectedId}
                playhead={playhead}
                zoom={zoom}
                setSelectedId={setSelectedId}
                setPlayhead={setPlayhead}
                moveClip={(id, start) =>
                  commit("Clip moved", (current) =>
                    updateClip(current, id, { timelineStart: start }),
                  )
                }
                trimClip={(id, side, delta) =>
                  commit("Clip trimmed", (current) => {
                    const clip = current.clips.find((entry) => entry.id === id);
                    if (!clip) return current;
                    if (side === "start") {
                      const safe = Math.max(
                        -clip.sourceStart,
                        Math.min(
                          delta * clip.speed,
                          clip.sourceEnd - clip.sourceStart - 0.05,
                        ),
                      );
                      return updateClip(current, id, {
                        sourceStart: clip.sourceStart + safe,
                        timelineStart: Math.max(
                          0,
                          clip.timelineStart + safe / clip.speed,
                        ),
                      });
                    }
                    return updateClip(current, id, {
                      sourceEnd: Math.max(
                        clip.sourceStart + 0.05,
                        clip.sourceEnd + delta * clip.speed,
                      ),
                    });
                  })
                }
                updateTrack={(id, patch) =>
                  commit("Track changed", (current) => ({
                    ...current,
                    tracks: current.tracks.map((track) =>
                      track.id === id ? { ...track, ...patch } : track,
                    ),
                  }))
                }
              />
            </div>
          ) : (
            <WorkspaceView
              view={view}
              project={project}
              assets={assets}
              recent={recent}
              snapshots={snapshots}
              exportJobs={exportQueue.jobs}
              onRestoreSnapshot={(snapshot) => {
                setPast((items) => [...items, project]);
                setProject(structuredClone(snapshot.project));
                setView("editor");
              }}
              onRenameSnapshot={(snapshot) => void renameSnapshotRecord(snapshot)}
              onDeleteSnapshot={(snapshot) => void removeSnapshotRecord(snapshot)}
              onView={setView}
              onImport={() => importRef.current?.click()}
              onRecorded={(file) => void importFiles([file])}
              onQuickTool={runQuickTool}
              onOpen={(id) => void openStored(id)}
              onRenameProject={(id) => void renameStoredProject(id)}
              onDuplicateProject={(id) => void duplicateStoredProject(id)}
              onDeleteProject={(id) => void removeStoredProject(id)}
              onNew={newProject}
              onExport={() => setExportOpen(true)}
              onProxy={updateProxy}
              onCancelExport={exportQueue.cancel}
              onRetryExport={exportQueue.retry}
              onRemoveExport={exportQueue.remove}
              onClearExports={exportQueue.clearCompleted}
              onDownloadExport={exportQueue.download}
            />
          )}
        </main>
      </div>
      <footer className="vf-statusbar">
        <span>
          <span className="vf-dot" /> Ready
        </span>
        <span>{savedAt}</span>
        <span>Deterministic FFmpeg render plan • local processing</span>
        <span>
          {exportQueue.jobs.some((job) =>
            ["preparing", "rendering", "ai-processing", "muxing", "validating"].includes(job.status),
          )
            ? "Export processing"
            : "Local processing"}
        </span>
      </footer>
      <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
        <CommandInput placeholder="Search commands, tools, media…" />
        <CommandList>
          <CommandEmpty>No matching command.</CommandEmpty>
          <CommandGroup heading="Commands">
            <CommandItem
              onSelect={() => {
                setCommandOpen(false);
                importRef.current?.click();
              }}
            >
              <Import /> Import media<CommandShortcut>⌘I</CommandShortcut>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setCommandOpen(false);
                addText();
              }}
            >
              <Type /> Add text
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setCommandOpen(false);
                splitSelected();
              }}
            >
              <Scissors /> Split at playhead<CommandShortcut>S</CommandShortcut>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setCommandOpen(false);
                setView("tools");
              }}
            >
              <WandSparkles /> Open Video Tools
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setCommandOpen(false);
                setExportOpen(true);
              }}
            >
              <Upload /> Export project
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <ExportDialog
        open={exportOpen}
        setOpen={setExportOpen}
        project={project}
        assets={assets}
        queuedCount={exportQueue.jobs.length}
        onQueue={queueExport}
        onOpenQueue={() => setView("exports")}
      />
      <Dialog
        open={Boolean(largeMediaPrompt)}
        onOpenChange={(open) => {
          if (!open && largeMediaPrompt) {
            largeMediaPrompt.resolve({ mode: "session" });
            setLargeMediaPrompt(null);
          }
        }}
      >
        <DialogContent className="vf-large-media-dialog">
          <DialogHeader>
            <DialogTitle>Large Media Detected</DialogTitle>
            <DialogDescription>
              This source can remain outside browser database storage. Reference mode is recommended when your browser supports persistent file handles; session mode keeps the project metadata but requires relinking after restart.
            </DialogDescription>
          </DialogHeader>
          {largeMediaPrompt && (
            <div className="vf-large-media-summary">
              <dl>
                <div><dt>Filename</dt><dd>{largeMediaPrompt.asset.name}</dd></div>
                <div><dt>Size</dt><dd>{prettySize(largeMediaPrompt.asset.size)}</dd></div>
                <div><dt>Resolution</dt><dd>{largeMediaPrompt.asset.width && largeMediaPrompt.asset.height ? `${largeMediaPrompt.asset.width} × ${largeMediaPrompt.asset.height}` : "Audio / unknown"}</dd></div>
                <div><dt>Risk</dt><dd>{largeMediaPrompt.asset.risk === "very-large" ? "Very large source" : "Large source"}</dd></div>
              </dl>
              <p>Direct persistence may exceed browser storage or memory. Generate a Low, Balanced or High proxy after import for responsive editing.</p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                largeMediaPrompt?.resolve({ mode: "session" });
                setLargeMediaPrompt(null);
              }}
            >
              Session Only
            </Button>
            <Button
              disabled={!supportsReferenceImport()}
              onClick={async () => {
                if (!largeMediaPrompt) return;
                try {
                  const picked = await pickReferenceFiles();
                  const match = picked.find(({ file }) => file.size === largeMediaPrompt.asset.size && file.name === largeMediaPrompt.asset.name) ?? picked[0];
                  if (!match) return;
                  largeMediaPrompt.resolve({ mode: "reference", file: match.file, handle: match.handle });
                  setLargeMediaPrompt(null);
                } catch (error) {
                  if (error instanceof DOMException && error.name === "AbortError") return;
                  toast.error("Reference selection failed", { description: String(error) });
                }
              }}
            >
              Reference Original • Recommended
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <QuickWorkflowDialog
        tool={quickTool}
        assets={assets}
        onOpenChange={(open) => !open && setQuickTool(null)}
        onImport={() => importRef.current?.click()}
        onQueue={(quickProject, settings) => {
          exportQueue.enqueue(quickProject, assetsRef.current, settings);
          setView("exports");
        }}
        onOpenInEditor={(quickProject) => {
          setPast((items) => [...items.slice(-49), project]);
          setFuture([]);
          setProject(quickProject);
          setSelectedId(quickProject.clips[0]?.id ?? null);
          setPlayhead(0);
          setView("editor");
        }}
      />
      <SubtitleDialog
        open={subtitlesOpen}
        setOpen={setSubtitlesOpen}
        project={project}
        commit={commit}
      />
    </div>
  );
}

function MediaPanel({
  assets,
  importMedia,
  place,
}: {
  assets: RuntimeAsset[];
  importMedia: () => void;
  place: (asset: RuntimeAsset) => void;
}) {
  const [query, setQuery] = useState("");
  const visibleAssets = assets.filter((asset) =>
    `${asset.name} ${asset.kind}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <aside className="vf-media-panel">
      <div className="vf-panel-heading">
        <div>
          <span>PROJECT</span>
          <strong>Media</strong>
        </div>
        <button className="vf-icon-btn" onClick={importMedia}>
          <Plus />
        </button>
      </div>
      <button className="vf-import-zone" onClick={importMedia}>
        <Import />
        <strong>Import media</strong>
        <span>Video, audio, images, SRT/VTT • large files supported</span>
      </button>
      <div className="vf-media-search">
        <Search />
        <input
          aria-label="Search project media"
          placeholder="Search project media"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="vf-media-list">
        {!visibleAssets.length ? (
          <div className="vf-small-empty">
            <Layers3 />
            <span>
              {assets.length
                ? "No project media matches that search."
                : "Your imported media will appear here."}
            </span>
          </div>
        ) : (
          visibleAssets.map((asset) => (
            <button
              key={asset.id}
              className="vf-media-item"
              onDoubleClick={() => place(asset)}
            >
              <span className="vf-thumb">
                {asset.kind === "audio" ? (
                  <AudioLines />
                ) : asset.kind === "image" ? (
                  <ImageIcon />
                ) : (
                  <Film />
                )}
              </span>
              <span>
                <strong>{asset.name}</strong>
                <small>
                  {asset.kind} •{" "}
                  {asset.duration
                    ? formatTime(asset.duration, false)
                    : `${asset.width}×${asset.height}`}{" "}
                  • {prettySize(asset.size)}
                </small>
                {asset.offline || !asset.blob ? (
                  <em className="vf-session-badge">Original offline{asset.proxy ? " • Proxy available" : ""}</em>
                ) : asset.storageMode === "reference" ? (
                  <em className="vf-session-badge">Reference original{asset.proxy ? " • Proxy ready" : ""}</em>
                ) : asset.storageMode === "session" ? (
                  <em className="vf-session-badge">Session source{asset.proxy ? " • Proxy ready" : ""}</em>
                ) : null}
              </span>
            </button>
          ))
        )}
      </div>
      <p className="vf-panel-tip">
        Double-click media to place it at the playhead.
      </p>
    </aside>
  );
}

function Inspector({
  selected,
  locked,
  playhead,
  setPlayhead,
  commit,
  addMask,
  asset,
}: {
  selected: Clip | null;
  locked: boolean;
  playhead: number;
  setPlayhead: (time: number) => void;
  asset?: RuntimeAsset;
  commit: (
    label: string,
    mutate: (current: VideoFlowProject) => VideoFlowProject,
  ) => void;
  addMask: () => void;
}) {
  if (!selected)
    return (
      <aside className="vf-inspector">
        <div className="vf-panel-heading">
          <div>
            <span>INSPECTOR</span>
            <strong>Properties</strong>
          </div>
          <SlidersHorizontal />
        </div>
        <div className="vf-inspector-empty">
          <SlidersHorizontal />
          <strong>Select a clip</strong>
          <span>
            Transform, timing, audio and watermark controls appear here.
          </span>
        </div>
      </aside>
    );
  const change = (label: string, patch: Partial<Clip>) =>
    commit(label, (current) => updateClip(current, selected.id, patch));
  const addPropertyKeyframe = (
    property: "x" | "y" | "scale" | "rotation" | "opacity" | "volume",
    value: number,
  ) =>
    change(
      `${property} keyframe added`,
      upsertPropertyKeyframe(selected, property, playhead, value),
    );
  const removePropertyKeyframe = (id: string) =>
    change("Keyframe removed", {
      keyframes: selected.keyframes.filter((keyframe) => keyframe.id !== id),
    });
  const changeAnimatedProperty = (
    property: "scale" | "rotation" | "opacity" | "volume",
    value: number,
  ) => {
    if (selected.keyframes.some((keyframe) => keyframe.property === property)) {
      change(`${property} keyframe updated`, upsertPropertyKeyframe(selected, property, playhead, value));
      return;
    }
    if (property === "opacity") change("Opacity changed", { opacity: value });
    else if (property === "volume") change("Volume changed", { gain: value });
    else
      change(`${property} changed`, {
        transform: { ...selected.transform, [property]: value },
      });
  };
  const crop = (patch: Partial<Clip["transform"]["crop"]>) =>
    change("Crop changed", {
      transform: {
        ...selected.transform,
        crop: { ...selected.transform.crop, ...patch },
      },
    });
  const loop = (count: number) =>
    commit("Clip looped", (current) => {
      const duration = clipDuration(selected);
      const copies = Array.from({ length: count - 1 }, (_, index) => ({
        ...structuredClone(selected),
        id: uid("clip"),
        name: `${selected.name} • loop ${index + 2}`,
        timelineStart: selected.timelineStart + duration * (index + 1),
      }));
      return { ...current, clips: [...current.clips, ...copies] };
    });
  const updateMask = (
    mask: WatermarkMask,
    patch: Partial<WatermarkMask>,
    label = "Mask changed",
  ) => {
    const geometryChanged = ["x", "y", "width", "height"].some((key) => key in patch);
    let next =
      mask.keyframes.length && geometryChanged
        ? upsertWatermarkKeyframe(
            mask,
            playhead,
            patch as Record<string, number>,
          )
        : { ...mask, ...patch };
    // Moving/resizing a tracked AI region at the current playhead is an
    // explicit manual correction anchor. Preserve automatic points around it
    // and let interpolation recalculate the surrounding trajectory.
    if (geometryChanged && next.ai?.tracking?.length) {
      const resolvedNext = resolveWatermarkMask(next, playhead) as WatermarkMask;
      const correction = {
        time: playhead,
        x: resolvedNext.x,
        y: resolvedNext.y,
        width: resolvedNext.width,
        height: resolvedNext.height,
        confidence: 1,
        method: "manual" as const,
        manual: true,
      };
      const tracking = next.ai.tracking
        .filter((point: WatermarkTrackingPoint) => Math.abs(point.time - playhead) >= 0.001)
        .concat(correction)
        .sort((a: WatermarkTrackingPoint, b: WatermarkTrackingPoint) => a.time - b.time);
      next = { ...next, ai: { ...next.ai, tracking } };
    }
    change(label, {
      watermarkMasks: selected.watermarkMasks.map((entry) =>
        entry.id === mask.id ? next : entry,
      ),
    });
  };
  return (
    <aside className="vf-inspector">
      <div className="vf-panel-heading">
        <div>
          <span>INSPECTOR</span>
          <strong>{selected.name}</strong>
        </div>
        <SlidersHorizontal />
      </div>
      {locked && <p className="vf-locked-note"><LockKeyhole /> Track locked — inspector edits are disabled.</p>}
      <fieldset className="vf-inspector-scroll" disabled={locked}>
        <InspectorSection title="Timing">
          <NumberField
            label="Timeline start"
            value={selected.timelineStart}
            step={0.01}
            min={0}
            onChange={(value) => change("Clip moved", { timelineStart: value })}
          />
          <NumberField
            label="Source in"
            value={selected.sourceStart}
            step={0.01}
            min={0}
            onChange={(value) =>
              change("Trim changed", {
                sourceStart: Math.min(value, selected.sourceEnd - 0.05),
              })
            }
          />
          <NumberField
            label="Source out"
            value={selected.sourceEnd}
            step={0.01}
            min={selected.sourceStart + 0.05}
            onChange={(value) =>
              change("Trim changed", {
                sourceEnd: Math.max(value, selected.sourceStart + 0.05),
              })
            }
          />
          <label className="vf-range">
            <span>
              Speed <b>{selected.speed.toFixed(2)}×</b>
            </span>
            <Slider
              min={0.25}
              max={4}
              step={0.05}
              value={[selected.speed]}
              onValueChange={([value]) =>
                change("Speed changed", { speed: value })
              }
            />
          </label>
          <div className="vf-button-grid">
            <button onClick={() => loop(2)}>Loop 2×</button>
            <button onClick={() => loop(3)}>Loop 3×</button>
          </div>
        </InspectorSection>
        <InspectorSection title="Animation & fades">
          <NumberField
            label="Fade in (s)"
            value={selected.fadeIn}
            min={0}
            max={clipDuration(selected)}
            step={0.05}
            onChange={(fadeIn) => change("Fade changed", { fadeIn })}
          />
          <NumberField
            label="Fade out (s)"
            value={selected.fadeOut}
            min={0}
            max={clipDuration(selected)}
            step={0.05}
            onChange={(fadeOut) => change("Fade changed", { fadeOut })}
          />
          <p className="vf-note">
            Add a linear keyframe at {formatTime(playhead)}. Values interpolate
            in preview and final render.
          </p>
          <div className="vf-button-grid">
            {selected.kind !== "audio" && (
              <>
                <button onClick={() => addPropertyKeyframe("x", selected.transform.x)}>+ X</button>
                <button onClick={() => addPropertyKeyframe("y", selected.transform.y)}>+ Y</button>
                <button onClick={() => addPropertyKeyframe("scale", selected.transform.scale)}>+ Scale</button>
                <button onClick={() => addPropertyKeyframe("rotation", selected.transform.rotation)}>+ Rotation</button>
                <button onClick={() => addPropertyKeyframe("opacity", selected.opacity)}>+ Opacity</button>
              </>
            )}
            <button onClick={() => addPropertyKeyframe("volume", selected.gain)}>+ Volume</button>
          </div>
          {selected.keyframes.length > 0 && (
            <div className="vf-keyframe-list">
              {selected.keyframes.map((keyframe) => (
                <button key={keyframe.id} onClick={() => removePropertyKeyframe(keyframe.id)}>
                  <span>◆ {keyframe.property} · {formatTime(keyframe.time)}</span>
                  <b>{keyframe.value.toFixed(2)} ×</b>
                </button>
              ))}
            </div>
          )}
        </InspectorSection>
        {selected.kind !== "audio" && (
          <InspectorSection title="Transform">
            <NumberField
              label="Scale"
              value={selected.transform.scale}
              step={0.05}
              min={0.1}
              max={5}
              onChange={(value) =>
                changeAnimatedProperty("scale", value)
              }
            />
            <NumberField
              label="Rotation"
              value={selected.transform.rotation}
              min={-360}
              max={360}
              onChange={(value) =>
                changeAnimatedProperty("rotation", value)
              }
            />
            <label className="vf-range">
              <span>
                Opacity <b>{Math.round(selected.opacity * 100)}%</b>
              </span>
              <Slider
                min={0}
                max={1}
                step={0.01}
                value={[selected.opacity]}
                onValueChange={([value]) =>
                  changeAnimatedProperty("opacity", value)
                }
              />
            </label>
            <div className="vf-button-grid">
              <button
                onClick={() =>
                  change("Rotated", {
                    transform: {
                      ...selected.transform,
                      rotation: selected.transform.rotation - 90,
                    },
                  })
                }
              >
                <RotateCcw /> −90°
              </button>
              <button
                onClick={() =>
                  change("Rotated", {
                    transform: {
                      ...selected.transform,
                      rotation: selected.transform.rotation + 90,
                    },
                  })
                }
              >
                <RotateCw /> +90°
              </button>
              <button
                onClick={() =>
                  change("Flipped", {
                    transform: {
                      ...selected.transform,
                      flipX: !selected.transform.flipX,
                    },
                  })
                }
              >
                ↔ Flip H
              </button>
              <button
                onClick={() =>
                  change("Flipped", {
                    transform: {
                      ...selected.transform,
                      flipY: !selected.transform.flipY,
                    },
                  })
                }
              >
                ↕ Flip V
              </button>
            </div>
          </InspectorSection>
        )}
        {selected.kind === "video" && (
          <InspectorSection title="Crop & output">
            <NumberField
              label="Crop X %"
              value={selected.transform.crop.x * 100}
              min={0}
              max={(1 - selected.transform.crop.width) * 100}
              onChange={(value) => crop({ x: value / 100 })}
            />
            <NumberField
              label="Crop Y %"
              value={selected.transform.crop.y * 100}
              min={0}
              max={(1 - selected.transform.crop.height) * 100}
              onChange={(value) => crop({ y: value / 100 })}
            />
            <NumberField
              label="Width %"
              value={selected.transform.crop.width * 100}
              min={1}
              max={(1 - selected.transform.crop.x) * 100}
              onChange={(value) => crop({ width: value / 100 })}
            />
            <NumberField
              label="Height %"
              value={selected.transform.crop.height * 100}
              min={1}
              max={(1 - selected.transform.crop.y) * 100}
              onChange={(value) => crop({ height: value / 100 })}
            />
            <div className="vf-button-grid crop-presets">
              <button onClick={() => crop({ x: 0, y: 0, width: 1, height: 1 })}>Free / Reset</button>
              <button onClick={() => crop({ x: 0, y: 0.125, width: 1, height: 0.75 })}>16:9</button>
              <button onClick={() => crop({ x: 0.289, y: 0, width: 0.422, height: 1 })}>9:16</button>
              <button onClick={() => crop({ x: 0.125, y: 0, width: 0.75, height: 1 })}>4:3</button>
              <button onClick={() => crop({ x: 0.078, y: 0, width: 0.844, height: 1 })}>3:2</button>
              <button onClick={() => crop({ x: 0.219, y: 0, width: 0.562, height: 1 })}>1:1</button>
              <button onClick={() => crop({ x: 0.275, y: 0, width: 0.45, height: 1 })}>4:5</button>
              <button onClick={() => crop({ x: 0, y: 0.119, width: 1, height: 0.762 })}>21:9</button>
            </div>
            <div className="vf-button-grid">
              <button
                onClick={() =>
                  commit("Output resized", (current) => ({
                    ...current,
                    settings: {
                      ...current.settings,
                      width: 1920,
                      height: 1080,
                    },
                  }))
                }
              >
                1080p
              </button>
              <button
                onClick={() =>
                  commit("Output resized", (current) => ({
                    ...current,
                    settings: { ...current.settings, width: 720, height: 1280 },
                  }))
                }
              >
                9:16 vertical
              </button>
            </div>
          </InspectorSection>
        )}
        <InspectorSection title="Audio">
          <label className="vf-range">
            <span>
              Volume <b>{Math.round(selected.gain * 100)}%</b>
            </span>
            <Slider
              min={0}
              max={2}
              step={0.01}
              value={[selected.gain]}
              onValueChange={([value]) =>
                changeAnimatedProperty("volume", value)
              }
            />
          </label>
        </InspectorSection>
        {selected.kind === "text" && (
          <InspectorSection title="Text">
            <label className="vf-field full">
              <span>Content</span>
              <textarea
                value={selected.text}
                onChange={(event) =>
                  change("Text changed", {
                    text: event.target.value.replace(/[<>]/g, ""),
                  })
                }
              />
            </label>
            <NumberField
              label="Font size"
              value={selected.fontSize ?? 58}
              min={12}
              max={240}
              onChange={(value) =>
                change("Text size changed", { fontSize: value })
              }
            />
            <label className="vf-field">
              <span>Typeface</span>
              <select
                value={selected.textStyle?.fontFamily ?? "system-ui"}
                onChange={(event) =>
                  change("Typeface changed", {
                    textStyle: {
                      ...(selected.textStyle ?? defaultTextStyle()),
                      fontFamily: event.target.value as "system-ui" | "serif" | "monospace",
                    },
                  })
                }
              >
                <option value="system-ui">System sans</option>
                <option value="serif">Serif</option>
                <option value="monospace">Monospace</option>
              </select>
            </label>
            <label className="vf-field">
              <span>Text color</span>
              <input
                type="color"
                value={selected.color ?? "#ffffff"}
                onChange={(event) => change("Text color changed", { color: event.target.value })}
              />
            </label>
            <div className="vf-button-grid">
              <button
                onClick={() =>
                  change("Text style changed", {
                    textStyle: {
                      ...(selected.textStyle ?? defaultTextStyle()),
                      italic: !(selected.textStyle?.italic ?? false),
                    },
                  })
                }
              >
                Italic
              </button>
              <button
                onClick={() =>
                  change("Text style changed", {
                    textStyle: {
                      ...(selected.textStyle ?? defaultTextStyle()),
                      fontWeight: 800,
                      preset: "title",
                    },
                  })
                }
              >
                Title preset
              </button>
              <button
                onClick={() =>
                  change("Text style changed", {
                    fontSize: 34,
                    transform: { ...selected.transform, y: 0.86 },
                    textStyle: {
                      ...(selected.textStyle ?? defaultTextStyle()),
                      fontWeight: 600,
                      preset: "lower-third",
                    },
                  })
                }
              >
                Lower third
              </button>
            </div>
          </InspectorSection>
        )}
        {selected.kind === "video" && (
          <InspectorSection title="Watermark Studio">
            <p className="vf-note">
              Use only on media you own or are authorized to modify. Green
              handles mark the active regions in preview.
            </p>
            <Button variant="outline" size="sm" onClick={addMask}>
              <Plus /> Add region
            </Button>
            <div className="vf-note">
              <strong>AI Reconstruction:</strong>{" "}
              VideoFlow never relabels blur, pixelate, cover or clone as AI.
              Install the optional checksum-validated local model and ONNX
              runtime pack below; AI is reported ready only after genuine
              local neural inference succeeds.
            </div>
            {selected.watermarkMasks.map((mask, index) => {
              const resolved = resolveWatermarkMask(
                mask,
                playhead,
              ) as WatermarkMask;
              const hasCurrentKeyframe = mask.keyframes.some(
                (keyframe) => Math.abs(keyframe.time - playhead) < 0.001,
              );
              return (
                <div className="vf-mask-card" key={mask.id}>
                  <div>
                    <span>Region {index + 1}</span>
                    <select
                      aria-label={`Region ${index + 1} method`}
                      value={mask.method}
                      onChange={(event) =>
                        updateMask(
                          mask,
                          {
                            method: event.target
                              .value as WatermarkMask["method"],
                          },
                          "Mask method changed",
                        )
                      }
                    >
                      <option value="blur">Blur</option>
                      <option value="pixelate">Pixelate</option>
                      <option value="cover">Cover</option>
                      <option value="clone">Clone</option>
                      <option value="ai">AI Reconstruction</option>
                    </select>
                    <button
                      aria-label={`Delete region ${index + 1}`}
                      onClick={() =>
                        change("Mask removed", {
                          watermarkMasks: selected.watermarkMasks.filter(
                            (entry) => entry.id !== mask.id,
                          ),
                        })
                      }
                    >
                      <Trash2 />
                    </button>
                  </div>
                  <div className="vf-mask-meta">
                    <label>
                      <Switch
                        checked={mask.enabled}
                        onCheckedChange={(enabled) =>
                          updateMask(mask, { enabled })
                        }
                      />{" "}
                      Enabled
                    </label>
                    <select
                      aria-label={`Region ${index + 1} shape`}
                      value={mask.shape}
                      onChange={(event) =>
                        updateMask(mask, {
                          shape: event.target.value as WatermarkMask["shape"],
                        })
                      }
                    >
                      <option value="rectangle">Rectangle</option>
                      <option value="ellipse">Ellipse</option>
                    </select>
                    <button
                      onClick={() =>
                        change("Mask duplicated", {
                          watermarkMasks: [
                            ...selected.watermarkMasks,
                            { ...structuredClone(mask), id: uid("mask") },
                          ],
                        })
                      }
                    >
                      Duplicate
                    </button>
                  </div>
                  <div className="vf-mask-fields">
                    <NumberField
                      label="X %"
                      value={resolved.x * 100}
                      min={0}
                      max={100 - resolved.width * 100}
                      onChange={(value) =>
                        updateMask(mask, { x: value / 100 }, "Mask moved")
                      }
                    />
                    <NumberField
                      label="Y %"
                      value={resolved.y * 100}
                      min={0}
                      max={100 - resolved.height * 100}
                      onChange={(value) =>
                        updateMask(mask, { y: value / 100 }, "Mask moved")
                      }
                    />
                    <NumberField
                      label="W %"
                      value={resolved.width * 100}
                      min={1}
                      max={100 - resolved.x * 100}
                      onChange={(value) =>
                        updateMask(mask, { width: value / 100 }, "Mask resized")
                      }
                    />
                    <NumberField
                      label="H %"
                      value={resolved.height * 100}
                      min={1}
                      max={100 - resolved.y * 100}
                      onChange={(value) =>
                        updateMask(
                          mask,
                          { height: value / 100 },
                          "Mask resized",
                        )
                      }
                    />
                  </div>
                  <div className="vf-mask-fields">
                    <NumberField
                      label="Start (s)"
                      value={mask.start}
                      min={selected.timelineStart}
                      max={mask.end - 0.01}
                      step={0.01}
                      onChange={(start) => updateMask(mask, { start })}
                    />
                    <NumberField
                      label="End (s)"
                      value={mask.end}
                      min={mask.start + 0.01}
                      max={selected.timelineStart + clipDuration(selected)}
                      step={0.01}
                      onChange={(end) => updateMask(mask, { end })}
                    />
                    <NumberField
                      label="Feather"
                      value={mask.feather}
                      min={0}
                      max={50}
                      onChange={(feather) => updateMask(mask, { feather })}
                    />
                  </div>
                  <div className="vf-keyframe-row">
                    <button
                      onClick={() =>
                        updateMask(
                          mask,
                          upsertWatermarkKeyframe(mask, playhead),
                          hasCurrentKeyframe
                            ? "Mask keyframe updated"
                            : "Mask keyframe added",
                        )
                      }
                    >
                      <Plus /> {hasCurrentKeyframe ? "Update" : "Add"} keyframe
                      at {formatTime(playhead)}
                    </button>
                    {hasCurrentKeyframe && (
                      <button
                        onClick={() =>
                          updateMask(
                            mask,
                            {
                              keyframes: mask.keyframes.filter(
                                (keyframe) =>
                                  Math.abs(keyframe.time - playhead) >= 0.001,
                              ),
                            },
                            "Mask keyframe removed",
                          )
                        }
                      >
                        <Trash2 /> Remove
                      </button>
                    )}
                    <span>
                      {mask.keyframes.length} linear keyframe
                      {mask.keyframes.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              );
            })}
            {selected.watermarkMasks[0] && (
              <AIWatermarkControls
                clip={selected}
                mask={selected.watermarkMasks[0]}
                asset={asset}
                playhead={playhead}
                onReviewTime={setPlayhead}
                updateMask={(patch, label) => updateMask(selected.watermarkMasks[0], patch, label)}
              />
            )}
          </InspectorSection>
        )}
      </fieldset>
    </aside>
  );
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="vf-inspector-section">
      <button className="vf-section-title" onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <ChevronDown className={open ? "open" : ""} />
      </button>
      {open && <div className="vf-section-body">{children}</div>}
    </section>
  );
}
function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="vf-field">
      <span>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(3))}
        step={step}
        min={min}
        max={max}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

function WorkspaceView({
  view,
  project,
  assets,
  recent,
  snapshots,
  exportJobs,
  onRestoreSnapshot,
  onRenameSnapshot,
  onDeleteSnapshot,
  onView,
  onImport,
  onRecorded,
  onQuickTool,
  onOpen,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
  onNew,
  onExport,
  onProxy,
  onCancelExport,
  onRetryExport,
  onRemoveExport,
  onClearExports,
  onDownloadExport,
}: {
  view: View;
  project: VideoFlowProject;
  assets: RuntimeAsset[];
  recent: VideoFlowProject[];
  snapshots: SnapshotRecord[];
  exportJobs: import("@/lib/videoflow/types").ExportJob[];
  onRestoreSnapshot: (snapshot: SnapshotRecord) => void;
  onRenameSnapshot: (snapshot: SnapshotRecord) => void;
  onDeleteSnapshot: (snapshot: SnapshotRecord) => void;
  onView: (view: View) => void;
  onImport: () => void;
  onRecorded: (file: File) => void;
  onQuickTool: (label: string) => void;
  onOpen: (id: string) => void;
  onRenameProject: (id: string) => void;
  onDuplicateProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onNew: () => void;
  onExport: () => void;
  onProxy: (assetId: string, proxy: Blob | null) => Promise<void>;
  onCancelExport: (id: string) => void;
  onRetryExport: (id: string) => void;
  onRemoveExport: (id: string) => void;
  onClearExports: () => void;
  onDownloadExport: (id: string) => void;
}) {
  const { setTheme } = useTheme();
  const title =
    NAV_ITEMS.find((item) => item.id === view)?.label ?? "VideoFlow";
  return (
    <section className="vf-view">
      <header>
        <div>
          <span>VIDEOFLOW PROFESSIONAL CORE</span>
          <h1>{title}</h1>
          <p>
            Your media stays on your device. Core workflows run locally in this
            browser.
          </p>
        </div>
        <Button onClick={onImport}>
          <Import /> Import media
        </Button>
      </header>
      {view === "dashboard" && (
        <>
          <div className="vf-action-grid">
            <button onClick={onNew}>
              <Plus />
              <strong>New project</strong>
              <span>Start with an empty timeline</span>
            </button>
            <button onClick={onImport}>
              <Import />
              <strong>Import media</strong>
              <span>Add local files</span>
            </button>
            <button onClick={() => onView("editor")}>
              <Film />
              <strong>Open editor</strong>
              <span>Continue {project.name}</span>
            </button>
          </div>
          <h2>Quick tools</h2>
          <ToolGrid onRun={onQuickTool} />
          <h2>Recent projects</h2>
          <ProjectGrid
            projects={recent}
            onOpen={onOpen}
            onRename={onRenameProject}
            onDuplicate={onDuplicateProject}
            onDelete={onDeleteProject}
          />
        </>
      )}
      {view === "tools" && (
        <MediaTools assets={assets} onImport={onImport} onProxy={onProxy} />
      )}
      {view === "audio" && (
        <AudioWorkspace assets={assets} onImport={onImport} />
      )}
      {view === "recorder" && <RecorderPanel onRecorded={onRecorded} />}
      {view === "projects" && (
        <>
          <ProjectGrid
            projects={recent}
            onOpen={onOpen}
            onRename={onRenameProject}
            onDuplicate={onDuplicateProject}
            onDelete={onDeleteProject}
          />
          <h2>Snapshots</h2>
          {snapshots.length ? (
            <div className="vf-snapshot-list">
              {snapshots.map((snapshot) => (
                <article key={snapshot.id} className="vf-snapshot-item">
                  <button onClick={() => onRestoreSnapshot(snapshot)}>
                    <Save />
                    <span>
                      <strong>{snapshot.name}</strong>
                      <small>
                        {new Date(snapshot.createdAt).toLocaleString()} • revision{" "}
                        {snapshot.revision}
                      </small>
                    </span>
                    <b>Restore</b>
                  </button>
                  <div>
                    <button onClick={() => onRenameSnapshot(snapshot)}>Rename</button>
                    <button onClick={() => onDeleteSnapshot(snapshot)}>Delete</button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="vf-empty-view compact">
              <Save />
              <h2>No snapshots</h2>
              <p>Create one from the Project menu before a major edit.</p>
            </div>
          )}
        </>
      )}
      {view === "exports" && (
        <ExportQueueView
          jobs={exportJobs}
          onAdd={onExport}
          onCancel={onCancelExport}
          onRetry={onRetryExport}
          onRemove={onRemoveExport}
          onClear={onClearExports}
          onDownload={onDownloadExport}
        />
      )}
      {view === "diagnostics" && <DiagnosticsPanel />}
      {view === "settings" && (
        <div className="vf-settings-grid">
          <section>
            <h2>Appearance</h2>
            <p>Theme follows your preference.</p>
            <div className="vf-segmented">
              <button onClick={() => setTheme("system")}>System</button>
              <button onClick={() => setTheme("light")}>
                <Sun /> Light
              </button>
              <button onClick={() => setTheme("dark")}>
                <Moon /> Dark
              </button>
            </div>
          </section>
          <section>
            <h2>Privacy</h2>
            <p>Telemetry Off • Cloud processing Off • Files uploaded 0</p>
          </section>
          <section>
            <h2>Performance</h2>
            <p>
              Exports are serialized to one worker job. Use Low, Balanced or High
              proxies for demanding media; final quality still resolves the original.
            </p>
          </section>
          <AISettingsPanel />
          <StorageStatus project={project} onReload={() => onOpen(project.id)} />
          <section>
            <h2>About</h2>
            <p>
              VideoFlow Professional Core 1.0.0
              <br />
              PWA build pwa7 • bundled local FFmpeg
            </p>
          </section>
        </div>
      )}
    </section>
  );
}

function QuickWorkflowDialog({
  tool,
  assets,
  onOpenChange,
  onImport,
  onQueue,
  onOpenInEditor,
}: {
  tool: string | null;
  assets: RuntimeAsset[];
  onOpenChange: (open: boolean) => void;
  onImport: () => void;
  onQueue: (project: VideoFlowProject, settings: ExportSettings) => void;
  onOpenInEditor: (project: VideoFlowProject) => void;
}) {
  const usable = assets.filter((asset) => asset.kind !== "subtitle");
  const usableKey = usable.map((asset) => asset.id).join("|");
  const [sourceId, setSourceId] = useState("");
  const [secondaryId, setSecondaryId] = useState("");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [gain, setGain] = useState(1);
  const [rotation, setRotation] = useState(90);
  const [flipX, setFlipX] = useState(false);
  const [cropX, setCropX] = useState(0.05);
  const [cropY, setCropY] = useState(0.05);
  const [cropWidth, setCropWidth] = useState(0.9);
  const [cropHeight, setCropHeight] = useState(0.9);
  const [outputWidth, setOutputWidth] = useState(1920);
  const [outputHeight, setOutputHeight] = useState(1080);
  const [text, setText] = useState("VideoFlow title");
  const [maskMethod, setMaskMethod] = useState<WatermarkMask["method"]>("blur");
  const [bitrate, setBitrate] = useState(4_000_000);
  const source = usable.find((asset) => asset.id === sourceId) ?? usable[0];
  const secondaryCandidates = usable.filter((asset) => {
    if (asset.id === source?.id) return false;
    if (tool === "Merge clips") return asset.kind === source?.kind || (source?.kind === "video" && asset.kind === "video");
    if (tool === "Add audio") return asset.kind === "audio" || asset.kind === "video";
    if (tool === "Add image") return asset.kind === "image";
    return true;
  });
  const secondary = secondaryCandidates.find((asset) => asset.id === secondaryId);

  useEffect(() => {
    if (!tool) return;
    const nextId = usable[0]?.id ?? "";
    const timer = window.setTimeout(() => {
      setSourceId((current) => usable.some((asset) => asset.id === current) ? current : nextId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tool, usableKey, usable]);
  useEffect(() => {
    if (!source) return;
    const nextEnd = Math.max(0.1, source.duration || (source.kind === "image" ? 5 : 0.1));
    const nextWidth = source.width;
    const nextHeight = source.height;
    const timer = window.setTimeout(() => {
      setStart(0);
      setEnd(nextEnd);
      if (nextWidth && nextHeight) {
        setOutputWidth(nextWidth);
        setOutputHeight(nextHeight);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [source]);
  useEffect(() => {
    if (!secondaryId || secondaryCandidates.some((asset) => asset.id === secondaryId)) return;
    const timer = window.setTimeout(() => setSecondaryId(""), 0);
    return () => window.clearTimeout(timer);
  }, [secondaryId, secondaryCandidates]);

  if (!tool) return null;
  const needsSecondary = ["Merge clips", "Add audio", "Add image"].includes(tool);
  const visualOnly = ["Crop & resize", "Rotate & flip", "Remove logo", "Add image", "Text & subtitles"].includes(tool);
  const audioOnly = tool === "Extract audio";
  const effectiveSourceOk = Boolean(source && (!visualOnly || source.kind !== "audio"));

  const buildProject = () => {
    if (!source) throw new Error("Choose source media first.");
    if (visualOnly && source.kind === "audio") throw new Error("This workflow requires video or image media.");
    if (needsSecondary && !secondary) throw new Error("Choose the second media item for this workflow.");
    const quick = blankProject(`Quick ${tool}`);
    quick.settings.width = outputWidth || source.width || 1280;
    quick.settings.height = outputHeight || source.height || 720;
    quick.settings.fps = 30;
    const trackId = source.kind === "audio" ? "a1" : "v1";
    const base = makeClip(source, trackId, 0);
    base.sourceStart = Math.max(0, Math.min(start, source.duration || start));
    base.sourceEnd = Math.max(base.sourceStart + 0.05, Math.min(end || source.duration, source.duration || end || 5));

    if (tool === "Speed") base.speed = Math.max(0.25, Math.min(4, speed));
    if (tool === "Volume & audio") base.gain = Math.max(0, Math.min(2, gain));
    if (tool === "Crop & resize") {
      base.transform.crop = {
        x: Math.max(0, Math.min(0.99, cropX)),
        y: Math.max(0, Math.min(0.99, cropY)),
        width: Math.max(0.01, Math.min(1 - cropX, cropWidth)),
        height: Math.max(0.01, Math.min(1 - cropY, cropHeight)),
      };
    }
    if (tool === "Rotate & flip") {
      base.transform.rotation = rotation;
      base.transform.flipX = flipX;
    }
    if (tool === "Remove logo") {
      base.watermarkMasks = [{
        id: uid("quick-mask"),
        shape: "rectangle",
        method: maskMethod,
        x: Math.max(0, Math.min(0.9, cropX)),
        y: Math.max(0, Math.min(0.9, cropY)),
        width: Math.max(0.02, Math.min(1 - cropX, cropWidth)),
        height: Math.max(0.02, Math.min(1 - cropY, cropHeight)),
        start: 0,
        end: clipDuration(base),
        feather: 10,
        enabled: true,
        keyframes: [],
      }];
    }
    quick.clips.push(base);

    if (tool === "Merge clips" && secondary) {
      const second = makeClip(secondary, secondary.kind === "audio" ? "a1" : "v1", clipDuration(base));
      quick.clips.push(second);
    }
    if (tool === "Add audio" && secondary) {
      const audio = makeClip(secondary, "a2", 0);
      audio.sourceEnd = Math.min(audio.sourceEnd, clipDuration(base));
      quick.clips.push(audio);
    }
    if (tool === "Add image" && secondary) {
      const image = makeClip(secondary, "v2", 0);
      image.sourceEnd = clipDuration(base);
      image.opacity = 1;
      image.transform = { ...image.transform, x: 0.68, y: 0.65, scale: 0.3 };
      quick.clips.push(image);
    }
    if (tool === "Text & subtitles") {
      quick.clips.push({
        id: uid("quick-text"), trackId: "t1", kind: "text", name: "Quick title",
        timelineStart: 0, sourceStart: 0, sourceEnd: clipDuration(base), speed: 1,
        gain: 1, opacity: 1,
        transform: { ...structuredClone(DEFAULT_TRANSFORM), x: 0.5, y: 0.82 },
        text, fontSize: 58, color: "#ffffff", background: "rgba(0,0,0,.6)",
        textStyle: defaultTextStyle(), fadeIn: 0, fadeOut: 0, keyframes: [], watermarkMasks: [],
      });
    }
    return quick;
  };

  const makeSettings = (quick: VideoFlowProject): ExportSettings => ({
    preset: "custom",
    format: audioOnly ? "wav" : "mp4",
    width: quick.settings.width,
    height: quick.settings.height,
    fps: quick.settings.fps,
    videoBitrate: tool === "Compress" ? bitrate : 7_500_000,
    audioBitrate: 160_000,
    audioSampleRate: 48000,
    videoCodec: audioOnly ? "none" : "h264",
    audioCodec: audioOnly ? "pcm" : "aac",
    includeAudio: tool !== "Remove audio",
    gifFps: 12,
    gifWidth: Math.min(640, quick.settings.width),
    aspectStrategy: "fit",
    rangeStart: 0,
    rangeEnd: projectDuration(quick),
  });

  const run = (openEditor: boolean) => {
    try {
      const quick = buildProject();
      if (openEditor) onOpenInEditor(quick);
      else onQueue(quick, makeSettings(quick));
      onOpenChange(false);
    } catch (error) {
      toast.error("Quick workflow is not ready", { description: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <Dialog open={Boolean(tool)} onOpenChange={onOpenChange}>
      <DialogContent className="vf-quick-workflow-dialog">
        <DialogHeader>
          <DialogTitle>{tool}</DialogTitle>
          <DialogDescription>
            Simplified local workflow: choose media, set the operation, preview the source, then export or continue in the full editor.
          </DialogDescription>
        </DialogHeader>
        {!usable.length ? (
          <div className="vf-empty-view compact">
            <Film />
            <h3>Choose source media</h3>
            <p>Import a file to begin. Large originals remain reference-based when appropriate.</p>
            <Button onClick={onImport}><Import /> Import media</Button>
          </div>
        ) : (
          <div className="vf-quick-workflow">
            <div className="vf-quick-preview">
              {source?.kind === "audio" ? (
                <audio controls src={source.proxyUrl ?? source.url} />
              ) : source?.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={source.proxyUrl ?? source.url} alt="Quick workflow source preview" />
              ) : (
                <video controls preload="metadata" src={source?.proxyUrl ?? source?.url} />
              )}
              <span>{tool} preview source • final export uses the deterministic render engine</span>
            </div>
            <div className="vf-quick-fields">
              <label><span>Source</span><select value={source?.id ?? ""} onChange={(e) => setSourceId(e.target.value)}>{usable.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
              {needsSecondary && (
                <label><span>{tool === "Merge clips" ? "Second clip" : tool === "Add audio" ? "Audio overlay" : "Image overlay"}</span><select value={secondaryId} onChange={(e) => setSecondaryId(e.target.value)}><option value="">Choose…</option>{secondaryCandidates.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
              )}
              {["Trim & split", "Speed", "Volume & audio", "Crop & resize", "Rotate & flip", "Remove logo", "Compress", "Extract audio", "Remove audio", "Text & subtitles", "Add audio", "Add image"].includes(tool) && (
                <><NumberField label="Start (s)" value={start} min={0} max={Math.max(0, source?.duration ?? 0)} step={0.01} onChange={setStart} /><NumberField label="End (s)" value={end} min={start + 0.01} max={Math.max(start + 0.01, source?.duration ?? end)} step={0.01} onChange={setEnd} /></>
              )}
              {tool === "Speed" && <NumberField label="Speed ×" value={speed} min={0.25} max={4} step={0.05} onChange={setSpeed} />}
              {tool === "Volume & audio" && <NumberField label="Volume" value={gain} min={0} max={2} step={0.05} onChange={setGain} />}
              {tool === "Rotate & flip" && <><NumberField label="Rotation °" value={rotation} min={-360} max={360} step={1} onChange={setRotation} /><label className="vf-check"><Switch checked={flipX} onCheckedChange={setFlipX} /> Flip horizontally</label></>}
              {["Crop & resize", "Remove logo"].includes(tool) && <><NumberField label="X (0–1)" value={cropX} min={0} max={0.99} step={0.01} onChange={setCropX} /><NumberField label="Y (0–1)" value={cropY} min={0} max={0.99} step={0.01} onChange={setCropY} /><NumberField label="Width (0–1)" value={cropWidth} min={0.01} max={1} step={0.01} onChange={setCropWidth} /><NumberField label="Height (0–1)" value={cropHeight} min={0.01} max={1} step={0.01} onChange={setCropHeight} /></>}
              {tool === "Crop & resize" && <><NumberField label="Output width" value={outputWidth} min={160} max={7680} step={2} onChange={setOutputWidth} /><NumberField label="Output height" value={outputHeight} min={90} max={4320} step={2} onChange={setOutputHeight} /></>}
              {tool === "Remove logo" && <label><span>Method</span><select value={maskMethod} onChange={(e) => setMaskMethod(e.target.value as WatermarkMask["method"])}><option value="blur">Blur</option><option value="pixelate">Pixelate</option><option value="cover">Cover</option><option value="clone">Clone</option></select></label>}
              {tool === "Text & subtitles" && <label className="vf-wide"><span>Text</span><textarea value={text} onChange={(e) => setText(e.target.value)} /></label>}
              {tool === "Compress" && <label><span>Target bitrate</span><select value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))}><option value={1_800_000}>Small • 1.8 Mbps</option><option value={4_000_000}>Balanced • 4 Mbps</option><option value={7_500_000}>High • 7.5 Mbps</option></select></label>}
            </div>
            {!effectiveSourceOk && <p className="vf-error-copy">Choose visual media for this operation.</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => run(true)} disabled={!effectiveSourceOk}><Film /> Open in Editor</Button>
          <Button onClick={() => run(false)} disabled={!effectiveSourceOk}><Download /> Export</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


const QUICK_TOOLS = [
  [Scissors, "Trim & split"],
  [Layers3, "Merge clips"],
  [Crop, "Crop & resize"],
  [RotateCw, "Rotate & flip"],
  [Gauge, "Speed"],
  [AudioLines, "Volume & audio"],
  [AudioLines, "Add audio"],
  [ImageIcon, "Add image"],
  [Type, "Text & subtitles"],
  [WandSparkles, "Remove logo"],
  [Download, "Compress"],
  [AudioLines, "Extract audio"],
  [AudioLines, "Remove audio"],
] as const;
function ToolGrid({ onRun }: { onRun: (label: string) => void }) {
  return (
    <div className="vf-tool-grid">
      {QUICK_TOOLS.map(([Icon, label]) => (
        <button key={label} onClick={() => onRun(label)}>
          <Icon />
          <strong>{label}</strong>
          <span>Run quick action</span>
        </button>
      ))}
    </div>
  );
}
function ProjectGrid({
  projects,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: {
  projects: VideoFlowProject[];
  onOpen: (id: string) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return projects.length ? (
    <div className="vf-project-grid">
      {projects.map((item) => (
        <article key={item.id} className="vf-project-card">
          <button className="vf-project-open" onClick={() => onOpen(item.id)}>
            <span className="vf-project-art"><Film /></span>
            <strong>{item.name}</strong>
            <small>{item.clips.length} clips • revision {item.revision}</small>
            <span>{new Date(item.updatedAt).toLocaleString()}</span>
          </button>
          <div>
            <button onClick={() => onRename(item.id)}>Rename</button>
            <button onClick={() => onDuplicate(item.id)}>Duplicate</button>
            <button onClick={() => onDelete(item.id)}>Delete</button>
          </div>
        </article>
      ))}
    </div>
  ) : (
    <div className="vf-empty-view compact">
      <FolderOpen />
      <h2>No saved projects yet</h2>
      <p>Projects are stored locally in this browser.</p>
    </div>
  );
}

function StorageStatus({
  project,
  onReload,
}: {
  project: VideoFlowProject;
  onReload: () => Promise<void> | void;
}) {
  const [status, setStatus] = useState("Checking browser storage…");
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!navigator.storage) {
      setStatus("Storage estimates are unavailable in this browser.");
      return;
    }
    const [estimate, persisted, categories] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted?.() ?? false,
      storageBreakdown().catch(() => null),
    ]);
    setStatus(
      `${prettySize(estimate.usage ?? 0)} used of ${prettySize(estimate.quota ?? 0)} • ${persisted ? "persistent" : "best effort"}`,
    );
    setBreakdown(categories);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const mutate = async (label: string, action: () => Promise<number | void>, reload = false) => {
    setBusy(true);
    try {
      const result = await action();
      if (reload) await onReload();
      await refresh();
      toast.success(label, {
        description: typeof result === "number" ? `${result} item${result === 1 ? "" : "s"} changed.` : undefined,
      });
    } catch (error) {
      toast.error(`${label} failed`, { description: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const usedAssetIds = new Set(
    project.clips.map((clip) => clip.assetId).filter((value): value is string => Boolean(value)),
  );

  return (
    <section className="vf-storage-manager">
      <h2>Local storage</h2>
      <p>{status}</p>
      {breakdown && (
        <dl className="vf-storage-breakdown">
          <div><dt>Projects</dt><dd>{prettySize(breakdown.projects)}</dd></div>
          <div><dt>Persisted media</dt><dd>{prettySize(breakdown.persistedMedia)}</dd></div>
          <div><dt>Proxies</dt><dd>{prettySize(breakdown.proxies)}</dd></div>
          <div><dt>Snapshots</dt><dd>{prettySize(breakdown.snapshots)}</dd></div>
          <div><dt>Recovery</dt><dd>{prettySize(breakdown.recovery)}</dd></div>
        </dl>
      )}
      <div className="vf-storage-actions">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void navigator.storage?.persist?.().then(() => refresh())}
        >
          Keep project data offline
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void mutate("Temporary recovery data cleared", clearTemporaryData)}
        >
          Clear temporary data
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void mutate(
              "Project proxies deleted",
              () => deleteProjectProxies(project.id),
              true,
            )
          }
        >
          Delete project proxies
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void mutate(
              "Unused project media removed",
              () => removeUnusedMedia(project.id, usedAssetIds),
              true,
            )
          }
        >
          Remove unused media
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => {
            if (!window.confirm("Reset VideoFlow local data? This deletes projects, media, snapshots and recovery data stored by this browser.")) return;
            void mutate("VideoFlow local data reset", resetDatabase).then(() => window.location.reload());
          }}
        >
          Reset VideoFlow
        </Button>
      </div>
    </section>
  );
}

function AudioWorkspace({
  assets,
  onImport,
}: {
  assets: RuntimeAsset[];
  onImport: () => void;
}) {
  const audioAssets = assets.filter(
    (asset) => asset.kind === "audio" || asset.kind === "video",
  );
  const [selectedId, setSelectedId] = useState(audioAssets[0]?.id ?? "");
  const selected =
    audioAssets.find((asset) => asset.id === selectedId) ?? audioAssets[0];
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(selected?.duration ?? 0);
  const [speed, setSpeed] = useState(1);
  const [pitch, setPitch] = useState(0);
  const [gain, setGain] = useState(1);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const [waveZoom, setWaveZoom] = useState<120 | 480 | 1920>(480);
  const [reverse, setReverse] = useState(false);
  const [normalize, setNormalize] = useState(true);
  const [preservePitch, setPreservePitch] = useState(true);
  const [eq, setEq] = useState<number[]>(Array(10).fill(0));
  const [waveLevels, setWaveLevels] = useState<Record<number, number[]>>({});
  const bars = waveLevels[waveZoom] ?? waveLevels[480] ?? [];
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!selected) return;
    // Prefer the persisted editing proxy for waveform generation so a multi-GB
    // original is never decoded into one browser AudioBuffer just to draw UI.
    const previewBlob = selected.proxyBlob ?? selected.blob;
    if (!previewBlob) {
      const timer = window.setTimeout(() => setWaveLevels({}), 0);
      return () => window.clearTimeout(timer);
    }
    void waveformPyramid(previewBlob, [120, 480, 1920])
      .then(setWaveLevels)
      .catch(() => setWaveLevels({}));
  }, [selected]);
  const selectAudio = (asset: RuntimeAsset) => {
    setSelectedId(asset.id);
    setStart(0);
    setEnd(asset.duration);
    setWaveLevels({});
    setFadeIn(0);
    setFadeOut(0);
  };
  if (!audioAssets.length)
    return (
      <div className="vf-empty-view">
        <AudioLines />
        <h2>No audio media</h2>
        <p>
          Import an audio file, video, or voice recording to use the local WAV
          workstation.
        </p>
        <Button onClick={onImport}>
          <Import /> Import media
        </Button>
      </div>
    );
  const trimEnd =
    end > start ? Math.min(end, selected.duration) : selected.duration;
  const run = async () => {
    if (!selected) return;
    const sourceBlob = selected.blob ?? selected.proxyBlob;
    if (!sourceBlob) {
      toast.error("Original media is offline", {
        description: "Relink the original or generate a persisted proxy first.",
      });
      return;
    }
    const controller = new AbortController();
    audioControllerRef.current = controller;
    setProcessing(true);
    setProgress(0);
    try {
      const options = {
        start,
        end: trimEnd,
        speed,
        pitchSemitones: pitch,
        gain,
        reverse,
        normalize,
        equalizer: eq,
        fadeIn,
        fadeOut,
      };
      const blob = preservePitch
        ? await processAudioWithFfmpeg(
            sourceBlob,
            selected.name,
            options,
            controller.signal,
            (value) => setProgress(value * 100),
          )
        : await processAudio(
            sourceBlob,
            options,
            controller.signal,
            (value) => setProgress(value * 100),
          );
      downloadBlob(
        blob,
        `${selected.name.replace(/\.[^.]+$/, "")}-processed.wav`,
      );
      toast.success("Processed WAV downloaded", {
        description: prettySize(blob.size),
      });
    } catch (error) {
      if (!controller.signal.aborted)
        toast.error("Audio processing failed", { description: String(error) });
    } finally {
      audioControllerRef.current = null;
      setProcessing(false);
    }
  };
  const join = async () => {
    setProcessing(true);
    try {
      const controller = new AbortController();
      const joinSources = audioAssets
        .map((asset) => asset.blob ?? asset.proxyBlob)
        .filter((blob): blob is Blob => Boolean(blob));
      if (!joinSources.length) throw new Error("No online audio sources are available.");
      const blob = await joinAudio(
        joinSources,
        normalize,
        controller.signal,
        (value) => setProgress(value * 100),
      );
      downloadBlob(blob, "videoflow-audio-join.wav");
      toast.success("Joined WAV downloaded");
    } catch (error) {
      toast.error("Audio join failed", { description: String(error) });
    } finally {
      setProcessing(false);
    }
  };
  return (
    <div className="vf-audio-workspace">
      <aside>
        <strong>Audio media</strong>
        {audioAssets.map((asset) => (
          <button
            className={selected?.id === asset.id ? "active" : ""}
            key={asset.id}
            onClick={() => selectAudio(asset)}
          >
            <AudioLines />
            <span>
              {asset.name}
              <small>{formatTime(asset.duration)}</small>
            </span>
          </button>
        ))}
        <Button variant="outline" onClick={onImport}>
          <Plus /> Add audio
        </Button>
      </aside>
      <section>
        {(selected.proxyUrl ?? selected.url) && (
          <div className="vf-audio-preview">
            <audio
              controls
              preload="metadata"
              src={selected.proxyUrl ?? selected.url}
              aria-label={`Preview ${selected.name}`}
            />
            <label>
              Waveform detail
              <select
                value={waveZoom}
                onChange={(event) => setWaveZoom(Number(event.target.value) as 120 | 480 | 1920)}
              >
                <option value={120}>Overview</option>
                <option value={480}>Medium</option>
                <option value={1920}>Detailed</option>
              </select>
            </label>
          </div>
        )}
        <div className="vf-waveform" aria-label="Audio waveform">
          {bars.map((value, index) => (
            <i key={index} style={{ height: `${Math.max(4, value * 100)}%` }} />
          ))}
        </div>
        <div className="vf-audio-fields">
          <NumberField
            label="Trim start (s)"
            value={start}
            min={0}
            max={Math.max(0, trimEnd - 0.01)}
            step={0.01}
            onChange={setStart}
          />
          <NumberField
            label="Trim end (s)"
            value={trimEnd}
            min={start + 0.01}
            max={selected?.duration}
            step={0.01}
            onChange={setEnd}
          />
          <label className="vf-range">
            <span>
              Speed <b>{speed.toFixed(2)}×</b>
            </span>
            <Slider
              value={[speed]}
              min={0.25}
              max={4}
              step={0.05}
              onValueChange={([value]) => setSpeed(value)}
            />
          </label>
          <label className="vf-range">
            <span>
              Pitch <b>{pitch} semitones</b>
            </span>
            <Slider
              value={[pitch]}
              min={-12}
              max={12}
              step={1}
              onValueChange={([value]) => setPitch(value)}
            />
          </label>
          <label className="vf-range">
            <span>
              Gain <b>{Math.round(gain * 100)}%</b>
            </span>
            <Slider
              value={[gain]}
              min={0}
              max={2}
              step={0.01}
              onValueChange={([value]) => setGain(value)}
            />
          </label>
          <NumberField
            label="Fade in (s)"
            value={fadeIn}
            min={0}
            max={Math.max(0, (trimEnd - start) / speed)}
            step={0.05}
            onChange={setFadeIn}
          />
          <NumberField
            label="Fade out (s)"
            value={fadeOut}
            min={0}
            max={Math.max(0, (trimEnd - start) / speed)}
            step={0.05}
            onChange={setFadeOut}
          />
          <label className="vf-check">
            <Switch
              checked={preservePitch}
              onCheckedChange={setPreservePitch}
            />{" "}
            Preserve pitch while changing speed
          </label>
          <label className="vf-check">
            <Switch checked={reverse} onCheckedChange={setReverse} /> Reverse
            audio
          </label>
          <label className="vf-check">
            <Switch checked={normalize} onCheckedChange={setNormalize} />{" "}
            Dynamic normalize
          </label>
        </div>
        <div className="vf-eq">
          <div>
            <strong>10-band equalizer</strong>
            <button onClick={() => setEq(Array(10).fill(0))}>Reset</button>
          </div>
          <div>
            {[60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000].map(
              (frequency, index) => (
                <label key={frequency}>
                  <span>
                    {frequency >= 1000 ? `${frequency / 1000}k` : frequency}
                  </span>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={1}
                    value={eq[index]}
                    onChange={(event) =>
                      setEq((values) =>
                        values.map((value, valueIndex) =>
                          valueIndex === index
                            ? Number(event.target.value)
                            : value,
                        ),
                      )
                    }
                  />
                  <b>{eq[index]} dB</b>
                </label>
              ),
            )}
          </div>
        </div>
        {processing && (
          <div className="vf-export-progress">
            <div>
              <span>Processing audio</span>
              <b>{Math.round(progress)}%</b>
            </div>
            <Progress value={progress} />
            <Button
              variant="destructive"
              size="sm"
              onClick={() => audioControllerRef.current?.abort()}
            >
              <Square /> Cancel
            </Button>
          </div>
        )}
        <div className="vf-audio-actions">
          <Button
            variant="outline"
            disabled={processing || audioAssets.length < 2}
            onClick={() => void join()}
          >
            <Layers3 /> Join all audio
          </Button>
          <Button disabled={processing} onClick={() => void run()}>
            <Download /> Process & download WAV
          </Button>
        </div>
        <p className="vf-disclosure">
          Preserve Pitch uses the bundled FFmpeg worker to keep duration and
          semitone pitch independently controlled. Turn it off to use faster
          browser-native resampling, where pitch and duration move together.
        </p>
      </section>
    </div>
  );
}

function RecorderPanel({ onRecorded }: { onRecorded: (file: File) => void }) {
  type RecorderType = "screen" | "camera" | "voice";
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [elapsed, setElapsed] = useState(0);
  const [countdown, setCountdown] = useState(3);
  const [fps, setFps] = useState(30);
  const [quality, setQuality] = useState<"standard" | "high" | "maximum">("high");
  const [cameraId, setCameraId] = useState("");
  const [microphoneId, setMicrophoneId] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [lastType, setLastType] = useState<RecorderType>("screen");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const meterContextRef = useRef<AudioContext | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setDevices([]);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshDevices(); }, 0);
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      window.clearTimeout(timer);
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

  const cleanupMeter = () => {
    if (meterFrameRef.current !== null) cancelAnimationFrame(meterFrameRef.current);
    meterFrameRef.current = null;
    void meterContextRef.current?.close();
    meterContextRef.current = null;
    setLevel(0);
  };
  const cleanupTimer = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => () => {
    cleanupTimer();
    cleanupMeter();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const startMeter = (stream: MediaStream) => {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length || typeof AudioContext === "undefined") return;
    cleanupMeter();
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const source = context.createMediaStreamSource(new MediaStream(audioTracks));
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const sample of data) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
      }
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3.2));
      meterFrameRef.current = requestAnimationFrame(tick);
    };
    meterContextRef.current = context;
    tick();
  };

  const waitCountdown = async () => {
    for (let remaining = countdown; remaining > 0; remaining -= 1) {
      setStatus(`Starting in ${remaining}…`);
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  };

  const microphoneConstraint = microphoneId
    ? { deviceId: { exact: microphoneId }, echoCancellation: true, noiseSuppression: true }
    : { echoCancellation: true, noiseSuppression: true };

  const start = async (type: RecorderType) => {
    try {
      setLastType(type);
      setLastFile(null);
      await waitCountdown();
      let stream: MediaStream;
      if (type === "screen") {
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: fps, max: fps } },
          audio: true,
        });
        // When a microphone is selected, mix it with system/tab audio locally so
        // MediaRecorder receives one deterministic audio track.
        const microphone = await navigator.mediaDevices
          .getUserMedia({ audio: microphoneConstraint, video: false })
          .catch(() => null);
        const audioSources = [
          ...display.getAudioTracks(),
          ...(microphone?.getAudioTracks() ?? []),
        ];
        if (audioSources.length > 1 && typeof AudioContext !== "undefined") {
          const context = new AudioContext();
          const destination = context.createMediaStreamDestination();
          for (const track of audioSources) {
            context.createMediaStreamSource(new MediaStream([track])).connect(destination);
          }
          stream = new MediaStream([
            ...display.getVideoTracks(),
            ...destination.stream.getAudioTracks(),
          ]);
          for (const track of [...display.getTracks(), ...(microphone?.getTracks() ?? [])]) {
            track.addEventListener("ended", () => {
              if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
              void context.close();
            }, { once: true });
          }
        } else {
          stream = new MediaStream([
            ...display.getVideoTracks(),
            ...(audioSources.length ? [audioSources[0]] : []),
          ]);
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video:
            type === "camera"
              ? {
                  deviceId: cameraId ? { exact: cameraId } : undefined,
                  width: { ideal: quality === "maximum" ? 3840 : quality === "high" ? 1920 : 1280 },
                  height: { ideal: quality === "maximum" ? 2160 : quality === "high" ? 1080 : 720 },
                  frameRate: { ideal: fps, max: fps },
                }
              : false,
          audio: microphoneConstraint,
        });
      }
      await refreshDevices();
      const isAudioOnly = type === "voice";
      const mimeCandidates = isAudioOnly
        ? ["audio/webm;codecs=opus", "audio/webm"]
        : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
      const mime = mimeCandidates.find((value) => MediaRecorder.isTypeSupported(value));
      const videoBits = quality === "maximum" ? 12_000_000 : quality === "high" ? 6_000_000 : 2_500_000;
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: quality === "maximum" ? 256_000 : quality === "high" ? 192_000 : 128_000,
        ...(isAudioOnly ? {} : { videoBitsPerSecond: videoBits }),
      });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const file = new File(
          [blob],
          `videoflow-${type}-${new Date().toISOString().replaceAll(":", "-")}.webm`,
          { type: recorder.mimeType || (isAudioOnly ? "audio/webm" : "video/webm") },
        );
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (previewRef.current) previewRef.current.srcObject = null;
        cleanupTimer();
        cleanupMeter();
        setRecording(false);
        setPaused(false);
        setLastFile(file);
        setStatus("Recording complete");
      };
      const stopWhenShareEnds = () => {
        if (recorder.state !== "inactive") recorder.stop();
      };
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", stopWhenShareEnds, { once: true }));
      recorder.start(1000);
      recorderRef.current = recorder;
      streamRef.current = stream;
      setRecording(true);
      setPaused(false);
      setElapsed(0);
      setStatus(`Recording ${type}…`);
      startMeter(stream);
      if (previewRef.current && !isAudioOnly) {
        previewRef.current.srcObject = stream;
        previewRef.current.muted = true;
        void previewRef.current.play().catch(() => undefined);
      }
      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
    } catch (error) {
      cleanupTimer();
      cleanupMeter();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setRecording(false);
      setPaused(false);
      setStatus("Ready");
      toast.error("Recorder could not start", { description: String(error) });
    }
  };

  const stop = () => {
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
  };
  const togglePause = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setPaused(true);
      setStatus("Recording paused");
    } else if (recorder.state === "paused") {
      recorder.resume();
      setPaused(false);
      setStatus(`Recording ${lastType}…`);
    }
  };
  const openRecording = () => {
    if (!lastFile) return;
    onRecorded(lastFile);
    toast.success("Recording opened in the editor");
    setStatus("Recording added to editor");
  };
  const saveRecording = () => {
    if (!lastFile) return;
    downloadBlob(lastFile, lastFile.name);
  };

  const cameras = devices.filter((device) => device.kind === "videoinput");
  const microphones = devices.filter((device) => device.kind === "audioinput");
  return (
    <div className="vf-recorder-workspace">
      <div className="vf-recorder-settings">
        <label>
          <span>Microphone</span>
          <select value={microphoneId} onChange={(event) => setMicrophoneId(event.target.value)} disabled={recording}>
            <option value="">Default microphone</option>
            {microphones.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Camera</span>
          <select value={cameraId} onChange={(event) => setCameraId(event.target.value)} disabled={recording}>
            <option value="">Default camera</option>
            {cameras.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>
            ))}
          </select>
        </label>
        <label>
          <span>FPS</span>
          <select value={fps} onChange={(event) => setFps(Number(event.target.value))} disabled={recording}>
            <option value={24}>24</option><option value={30}>30</option><option value={60}>60</option>
          </select>
        </label>
        <label>
          <span>Quality</span>
          <select value={quality} onChange={(event) => setQuality(event.target.value as typeof quality)} disabled={recording}>
            <option value="standard">Standard</option><option value="high">High</option><option value="maximum">Maximum / 4K when camera supports it</option>
          </select>
        </label>
        <label>
          <span>Countdown</span>
          <select value={countdown} onChange={(event) => setCountdown(Number(event.target.value))} disabled={recording}>
            <option value={0}>Off</option><option value={3}>3 seconds</option><option value={5}>5 seconds</option>
          </select>
        </label>
      </div>
      <div className="vf-recorder-grid">
        <button disabled={recording} onClick={() => void start("screen")}>
          <Video /><strong>Screen recorder</strong><span>Screen, window or tab • system/tab audio where browser permits</span>
        </button>
        <button disabled={recording} onClick={() => void start("camera")}>
          <Camera /><strong>Camera recorder</strong><span>Selected camera with microphone</span>
        </button>
        <button disabled={recording} onClick={() => void start("voice")}>
          <Mic /><strong>Voice recorder</strong><span>Selected microphone only</span>
        </button>
      </div>
      <div className="vf-recorder-preview">
        <video ref={previewRef} playsInline muted className={lastType === "voice" ? "hidden" : ""} />
        <div className="vf-audio-meter" aria-label="Recording audio level">
          <i style={{ width: `${Math.max(2, level * 100)}%` }} />
        </div>
      </div>
      <div className={`vf-recording-status ${recording ? "live" : ""}`}>
        <span className="vf-dot" />
        <strong>{status}</strong>
        {recording && <span>{formatTime(elapsed)}</span>}
        {recording && (
          <>
            <Button variant="outline" onClick={togglePause}>
              {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
            </Button>
            <Button variant="destructive" onClick={stop}><Square /> Stop</Button>
          </>
        )}
      </div>
      {lastFile && !recording && (
        <div className="vf-recording-complete">
          <strong>Recording Complete</strong>
          <span>{lastFile.name} • {prettySize(lastFile.size)}</span>
          <div>
            <Button onClick={openRecording}><Film /> Open in Editor</Button>
            <Button variant="outline" onClick={saveRecording}><Download /> Save Recording</Button>
            <Button variant="outline" onClick={() => { setLastFile(null); setStatus("Ready"); }}><RotateCcw /> Record Again</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SubtitleDialog({
  open,
  setOpen,
  project,
  commit,
}: {
  open: boolean;
  setOpen: (value: boolean) => void;
  project: VideoFlowProject;
  commit: (
    label: string,
    mutate: (current: VideoFlowProject) => VideoFlowProject,
  ) => void;
}) {
  const add = () =>
    commit("Subtitle added", (current) => ({
      ...current,
      subtitles: [
        ...current.subtitles,
        { id: uid("cue"), start: 0, end: 2, text: "New subtitle" },
      ],
    }));
  const change = (
    id: string,
    patch: Partial<{ start: number; end: number; text: string }>,
  ) =>
    commit("Subtitle changed", (current) => ({
      ...current,
      subtitles: current.subtitles.map((cue) =>
        cue.id === id ? { ...cue, ...patch } : cue,
      ),
    }));
  const remove = (id: string) =>
    commit("Subtitle removed", (current) => ({
      ...current,
      subtitles: current.subtitles.filter((cue) => cue.id !== id),
    }));
  const exportSrt = () =>
    downloadBlob(
      new Blob([cuesToSrt(project.subtitles)], {
        type: "text/plain;charset=utf-8",
      }),
      `${project.name.replace(/[^a-z0-9-_]+/gi, "-")}.srt`,
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="vf-subtitle-dialog">
        <DialogHeader>
          <DialogTitle>Subtitle editor</DialogTitle>
          <DialogDescription>
            Imported SRT/WebVTT cues are sanitized, editable, exported as SRT,
            and burned into video exports.
          </DialogDescription>
        </DialogHeader>
        <div className="vf-subtitle-list">
          {project.subtitles.length ? (
            project.subtitles.map((cue, index) => (
              <div key={cue.id}>
                <b>{index + 1}</b>
                <label>
                  <span>Start</span>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={cue.start}
                    onChange={(event) =>
                      change(cue.id, { start: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>End</span>
                  <input
                    type="number"
                    min={cue.start + 0.01}
                    step={0.01}
                    value={cue.end}
                    onChange={(event) =>
                      change(cue.id, { end: Number(event.target.value) })
                    }
                  />
                </label>
                <textarea
                  value={cue.text}
                  onChange={(event) =>
                    change(cue.id, {
                      text: event.target.value.replace(/[<>]/g, ""),
                    })
                  }
                />
                <button
                  onClick={() => remove(cue.id)}
                  aria-label={`Delete subtitle ${index + 1}`}
                >
                  <Trash2 />
                </button>
              </div>
            ))
          ) : (
            <div className="vf-small-empty">
              <Type />
              <span>No subtitle cues. Import SRT/VTT or add one manually.</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={add}>
            <Plus /> Add cue
          </Button>
          <Button
            variant="outline"
            disabled={!project.subtitles.length}
            onClick={exportSrt}
          >
            <Download /> Export SRT
          </Button>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
