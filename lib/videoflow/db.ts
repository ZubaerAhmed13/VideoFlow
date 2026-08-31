import type { MediaAssetRecord, RuntimeAsset, SnapshotRecord, VideoFlowProject } from "./types";

const DB_NAME = "videoflow-professional-core";
const DB_VERSION = 2;

export interface StoredAsset extends MediaAssetRecord {
  blob?: Blob;
  proxyBlob?: Blob;
  fileHandle?: FileSystemFileHandle;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("assets")) {
        const store = db.createObjectStore("assets", { keyPath: "id" });
        store.createIndex("projectId", "projectId");
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        const store = db.createObjectStore("snapshots", { keyPath: "id" });
        store.createIndex("projectId", "projectId");
      }
      if (!db.objectStoreNames.contains("preferences")) db.createObjectStore("preferences", { keyPath: "key" });
      if (!db.objectStoreNames.contains("recovery")) db.createObjectStore("recovery", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("VideoFlow could not open local storage."));
  });
}

async function transaction<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await requestToPromise(action(db.transaction(storeName, mode).objectStore(storeName)));
  } finally {
    db.close();
  }
}

export const saveProject = (project: VideoFlowProject) => transaction("projects", "readwrite", (store) => store.put(project));
export const loadProject = (id: string) => transaction<VideoFlowProject | undefined>("projects", "readonly", (store) => store.get(id));
export const deleteProject = (id: string) => transaction("projects", "readwrite", (store) => store.delete(id));
export const saveAsset = (asset: StoredAsset | RuntimeAsset) => {
  const stored = { ...asset } as StoredAsset & { url?: string; proxyUrl?: string };
  delete stored.url;
  delete stored.proxyUrl;
  stored.storageMode =
    stored.storageMode === ("persistent" as never) ? "persisted" : stored.storageMode;
  if (stored.storageMode !== "persisted") delete stored.blob;
  return transaction("assets", "readwrite", (store) => store.put(stored));
};
export const deleteAsset = (id: string) => transaction("assets", "readwrite", (store) => store.delete(id));
export const saveSnapshot = (snapshot: SnapshotRecord) => transaction("snapshots", "readwrite", (store) => store.put(snapshot));
export const deleteSnapshot = (id: string) => transaction("snapshots", "readwrite", (store) => store.delete(id));
export const saveRecovery = (project: VideoFlowProject) => transaction("recovery", "readwrite", (store) => store.put({ id: "active", savedAt: new Date().toISOString(), project }));
export const loadRecovery = () => transaction<{ id: string; savedAt: string; project: VideoFlowProject } | undefined>("recovery", "readonly", (store) => store.get("active"));
export const clearRecovery = () => transaction("recovery", "readwrite", (store) => store.delete("active"));

export async function listProjects(): Promise<VideoFlowProject[]> {
  const db = await openDatabase();
  try {
    return await requestToPromise(db.transaction("projects").objectStore("projects").getAll());
  } finally {
    db.close();
  }
}

export async function loadAssets(projectId: string): Promise<StoredAsset[]> {
  const db = await openDatabase();
  try {
    const index = db.transaction("assets").objectStore("assets").index("projectId");
    return await requestToPromise(index.getAll(projectId));
  } finally {
    db.close();
  }
}

export async function listSnapshots(projectId: string): Promise<SnapshotRecord[]> {
  const db = await openDatabase();
  try {
    const index = db.transaction("snapshots").objectStore("snapshots").index("projectId");
    return await requestToPromise(index.getAll(projectId));
  } finally {
    db.close();
  }
}

export interface StorageBreakdown {
  projects: number;
  persistedMedia: number;
  proxies: number;
  snapshots: number;
  recovery: number;
}

function approximateJsonBytes(value: unknown): number {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

export async function storageBreakdown(): Promise<StorageBreakdown> {
  const db = await openDatabase();
  try {
    const projectStore = db.transaction("projects").objectStore("projects");
    const assetStore = db.transaction("assets").objectStore("assets");
    const snapshotStore = db.transaction("snapshots").objectStore("snapshots");
    const recoveryStore = db.transaction("recovery").objectStore("recovery");
    const [projects, assets, snapshots, recovery] = await Promise.all([
      requestToPromise(projectStore.getAll()),
      requestToPromise(assetStore.getAll()) as Promise<StoredAsset[]>,
      requestToPromise(snapshotStore.getAll()),
      requestToPromise(recoveryStore.getAll()),
    ]);
    return {
      projects: approximateJsonBytes(projects),
      persistedMedia: assets.reduce((sum, asset) => sum + (asset.blob?.size ?? 0), 0),
      proxies: assets.reduce((sum, asset) => sum + (asset.proxyBlob?.size ?? 0), 0),
      snapshots: approximateJsonBytes(snapshots),
      recovery: approximateJsonBytes(recovery),
    };
  } finally {
    db.close();
  }
}

export async function clearTemporaryData(): Promise<void> {
  const db = await openDatabase();
  try {
    await requestToPromise(db.transaction("recovery", "readwrite").objectStore("recovery").clear());
  } finally {
    db.close();
  }
}

export async function deleteProjectProxies(projectId?: string): Promise<number> {
  const db = await openDatabase();
  let changed = 0;
  try {
    const transaction = db.transaction("assets", "readwrite");
    const store = transaction.objectStore("assets");
    const assets = (projectId
      ? await requestToPromise(store.index("projectId").getAll(projectId))
      : await requestToPromise(store.getAll())) as StoredAsset[];
    for (const asset of assets) {
      if (!asset.proxyBlob && !asset.proxy) continue;
      const next = { ...asset } as StoredAsset;
      delete next.proxyBlob;
      delete next.proxy;
      store.put(next);
      changed += 1;
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete proxies."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Proxy cleanup was aborted."));
    });
    return changed;
  } finally {
    db.close();
  }
}

export async function removeUnusedMedia(projectId: string, usedAssetIds: Iterable<string>): Promise<number> {
  const used = new Set(usedAssetIds);
  const db = await openDatabase();
  let removed = 0;
  try {
    const transaction = db.transaction("assets", "readwrite");
    const store = transaction.objectStore("assets");
    const assets = (await requestToPromise(store.index("projectId").getAll(projectId))) as StoredAsset[];
    for (const asset of assets) {
      if (used.has(asset.id)) continue;
      store.delete(asset.id);
      removed += 1;
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove unused media."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Media cleanup was aborted."));
    });
    return removed;
  } finally {
    db.close();
  }
}

export async function resetDatabase(): Promise<void> {
  const db = await openDatabase();
  db.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not reset local storage."));
    request.onblocked = () => reject(new Error("Close other VideoFlow tabs before resetting storage."));
  });
}
