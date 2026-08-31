import type { TrackingPoint } from "../types";
import { trackTemplateStream, trackingIssuesFromPoints, type TrackingProgress, type TrackingResult } from "./TemplateTracker";

type Reply = { id: number; ok: boolean; error?: string; point?: TrackingPoint; lost?: boolean };

export async function trackTemplateWithWorker(
  times: number[],
  initial: TrackingPoint,
  frameProvider: (time: number, index: number) => Promise<ImageBitmap>,
  options: { searchRadius?: number; signal?: AbortSignal; onProgress?: (progress: TrackingProgress) => void } = {},
): Promise<TrackingResult> {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return trackTemplateStream(times, initial, frameProvider, { ...options, stopOnLost: true });
  }
  let worker: Worker | null = new Worker(new URL("../../../../workers/tracking.worker.ts", import.meta.url), { type: "module", name: "videoflow-tracking" });
  let sequence = 0;
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: unknown) => void }>();
  const request = (payload: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Reply>((resolve, reject) => {
    if (!worker) return reject(new Error("Tracking worker is unavailable."));
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...payload }, transfer);
  });
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const active = pending.get(event.data.id);
    if (!active) return;
    pending.delete(event.data.id);
    if (event.data.ok) active.resolve(event.data);
    else active.reject(new Error(event.data.error || "Tracking worker failed."));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "Tracking worker crashed.");
    for (const active of pending.values()) active.reject(error);
    pending.clear();
  };
  const abort = () => {
    worker?.terminate();
    worker = null;
    const error = new DOMException("Tracking cancelled.", "AbortError");
    for (const active of pending.values()) active.reject(error);
    pending.clear();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const points: TrackingPoint[] = [];
  try {
    if (!times.length) return { points, issues: [], completed: true };
    const first = await frameProvider(times[0], 0);
    const initialized = await request({ type: "init", frame: first, initial: { ...initial, time: times[0] }, searchRadius: options.searchRadius ?? 28 }, [first]);
    if (!initialized.point) throw new Error("Tracking worker returned no anchor.");
    points.push(initialized.point);
    options.onProgress?.({ completed: 1, total: times.length, time: times[0], confidence: 1 });
    let completed = true;
    for (let index = 1; index < times.length; index += 1) {
      if (options.signal?.aborted) throw new DOMException("Tracking cancelled.", "AbortError");
      const frame = await frameProvider(times[index], index);
      const reply = await request({ type: "step", frame, time: times[index] }, [frame]);
      if (!reply.point) throw new Error("Tracking worker returned no point.");
      points.push(reply.point);
      options.onProgress?.({ completed: index + 1, total: times.length, time: times[index], confidence: reply.point.confidence ?? 0 });
      if (reply.lost) { completed = false; break; }
    }
    return { points, issues: trackingIssuesFromPoints(points, !completed), completed };
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    worker?.terminate();
    worker = null;
    return trackTemplateStream(times, initial, frameProvider, { ...options, stopOnLost: true });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    worker?.terminate();
    pending.clear();
  }
}
