"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { exportFilename, renderExport } from "@/lib/videoflow/export";
import { downloadBlob } from "@/lib/videoflow/media";
import { uid } from "@/lib/videoflow/core.mjs";
import type {
  ExportJob,
  ExportSettings,
  RuntimeAsset,
  VideoFlowProject,
} from "@/lib/videoflow/types";

interface Payload {
  project: VideoFlowProject;
  assets: RuntimeAsset[];
  settings: ExportSettings;
  targetHandle?: FileSystemFileHandle;
}

export function useExportQueue() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const jobsRef = useRef<ExportJob[]>([]);
  const payloads = useRef(new Map<string, Payload>());
  const activeController = useRef<{
    id: string;
    controller: AbortController;
  } | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (running.current) return;
    const waiting = jobs.find((job) => job.status === "waiting");
    if (!waiting) return;
    const payload = payloads.current.get(waiting.id);
    if (!payload) {
      setJobs((items) =>
        items.map((job) =>
          job.id === waiting.id
            ? {
                ...job,
                status: "failed",
                phase: "Failed",
                error: "Queued project data is unavailable.",
              }
            : job,
        ),
      );
      return;
    }
    running.current = true;
    const controller = new AbortController();
    const startedAt = Date.now();
    activeController.current = { id: waiting.id, controller };
    setJobs((items) =>
      items.map((job) =>
        job.id === waiting.id
          ? {
              ...job,
              status: "preparing",
              phase: "Preparing",
              startedAt,
              progress: 1,
            }
          : job,
      ),
    );
    void renderExport(
      payload.project,
      payload.assets,
      payload.settings,
      controller.signal,
      (progress, phase) => {
        setJobs((items) =>
          items.map((job) =>
            job.id === waiting.id
              ? {
                  ...job,
                  status: phase.toLowerCase().includes("validat")
                    ? "validating"
                    : phase.toLowerCase().includes("mux") || phase.toLowerCase().includes("concat")
                      ? "muxing"
                      : phase.toLowerCase().includes("ai")
                        ? "ai-processing"
                        : progress > 0.04
                          ? "rendering"
                          : "preparing",
                  phase,
                  progress: Math.round(progress * 1000) / 10,
                }
              : job,
          ),
        );
      },
      payload.targetHandle,
    )
      .then(({ blob, validation, filename, diskBacked, fileSize, segmentCount }) => {
        const url = blob ? URL.createObjectURL(blob) : undefined;
        running.current = false;
        activeController.current = null;
        setJobs((items) =>
          items.map((job) =>
            job.id === waiting.id
              ? {
                  ...job,
                  filename,
                  blob,
                  url,
                  diskBacked,
                  fileSize,
                  segmentCount,
                  validation,
                  status: "complete",
                  phase: "Complete",
                  progress: 100,
                  elapsed: Date.now() - startedAt,
                }
              : job,
          ),
        );
      })
      .catch((error) => {
        running.current = false;
        activeController.current = null;
        const cancelled =
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        setJobs((items) =>
          items.map((job) =>
            job.id === waiting.id
              ? {
                  ...job,
                  status: cancelled ? "cancelled" : "failed",
                  phase: cancelled ? "Cancelled" : "Failed",
                  error: cancelled
                    ? undefined
                    : error instanceof Error
                      ? error.message
                      : String(error),
                  elapsed: Date.now() - startedAt,
                }
              : job,
          ),
        );
      });
  }, [jobs]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(
    () => () => {
      activeController.current?.controller.abort();
      for (const job of jobsRef.current)
        if (job.url) URL.revokeObjectURL(job.url);
    },
    [],
  );

  const enqueue = useCallback(
    (
      project: VideoFlowProject,
      assets: RuntimeAsset[],
      settings: ExportSettings,
      targetHandle?: FileSystemFileHandle,
    ) => {
      const id = uid("export");
      payloads.current.set(id, {
        project: structuredClone(project),
        assets: [...assets],
        settings: { ...settings },
        targetHandle,
      });
      const job: ExportJob = {
        id,
        name: `${project.name} • ${settings.format.toUpperCase()}`,
        filename: exportFilename(project.name, settings),
        format: settings.format,
        diskBacked: Boolean(targetHandle),
        status: "waiting",
        phase: "Waiting",
        progress: 0,
        createdAt: Date.now(),
      };
      setJobs((items) => [...items, job]);
      return id;
    },
    [],
  );

  const cancel = useCallback((id: string) => {
    if (activeController.current?.id === id)
      activeController.current.controller.abort();
    else
      setJobs((items) =>
        items.map((job) =>
          job.id === id && job.status === "waiting"
            ? { ...job, status: "cancelled", phase: "Cancelled" }
            : job,
        ),
      );
  }, []);

  const retry = useCallback(
    (id: string) =>
      setJobs((items) =>
        items.map((job) =>
          job.id === id && ["failed", "cancelled"].includes(job.status)
            ? {
                ...job,
                status: "waiting",
                phase: "Waiting",
                progress: 0,
                error: undefined,
                elapsed: undefined,
                startedAt: undefined,
              }
            : job,
        ),
      ),
    [],
  );

  const remove = useCallback((id: string) => {
    setJobs((items) => {
      const job = items.find((entry) => entry.id === id);
      if (!job || ["preparing", "rendering", "ai-processing", "muxing", "validating"].includes(job.status))
        return items;
      if (job.url) URL.revokeObjectURL(job.url);
      payloads.current.delete(id);
      return items.filter((entry) => entry.id !== id);
    });
  }, []);

  const clearCompleted = useCallback(
    () =>
      setJobs((items) =>
        items.filter((job) => {
          if (!["complete", "failed", "cancelled"].includes(job.status))
            return true;
          if (job.url) URL.revokeObjectURL(job.url);
          payloads.current.delete(job.id);
          return false;
        }),
      ),
    [],
  );

  const download = useCallback(
    (id: string) => {
      const job = jobs.find((entry) => entry.id === id);
      if (job?.blob) downloadBlob(job.blob, job.filename);
    },
    [jobs],
  );

  return { jobs, enqueue, cancel, retry, remove, clearCompleted, download };
}
