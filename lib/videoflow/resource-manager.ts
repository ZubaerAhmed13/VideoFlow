export type ResourceLane = "ffmpeg" | "proxy" | "thumbnail" | "waveform" | "ai";

interface QueueEntry<T> {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class ResourceManager {
  private active = new Map<ResourceLane, number>();
  private queues = new Map<ResourceLane, Array<QueueEntry<unknown>>>();
  private limits: Record<ResourceLane, number> = {
    ffmpeg: 1,
    proxy: 1,
    thumbnail: 2,
    waveform: 1,
    ai: 1,
  };

  setLimit(lane: ResourceLane, value: number): void {
    this.limits[lane] = Math.max(1, Math.floor(value));
    this.pump(lane);
  }

  run<T>(lane: ResourceLane, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(lane) ?? [];
      queue.push({ run: task, resolve, reject } as QueueEntry<unknown>);
      this.queues.set(lane, queue);
      this.pump(lane);
    });
  }

  status(): Record<ResourceLane, { active: number; waiting: number; limit: number }> {
    return Object.fromEntries(
      (Object.keys(this.limits) as ResourceLane[]).map((lane) => [
        lane,
        {
          active: this.active.get(lane) ?? 0,
          waiting: this.queues.get(lane)?.length ?? 0,
          limit: this.limits[lane],
        },
      ]),
    ) as Record<ResourceLane, { active: number; waiting: number; limit: number }>;
  }

  private pump(lane: ResourceLane): void {
    const active = this.active.get(lane) ?? 0;
    if (active >= this.limits[lane]) return;
    const queue = this.queues.get(lane);
    const entry = queue?.shift();
    if (!entry) return;
    this.active.set(lane, active + 1);
    void entry
      .run()
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.active.set(lane, Math.max(0, (this.active.get(lane) ?? 1) - 1));
        this.pump(lane);
      });
    if ((this.active.get(lane) ?? 0) < this.limits[lane]) this.pump(lane);
  }
}

export const videoFlowResources = new ResourceManager();
