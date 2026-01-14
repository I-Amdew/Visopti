type CacheEntry = { key: string; value: number };

type PersistenceMode = "indexeddb" | "localstorage" | null;

type PersistedEntry = { key: string; value: number; updatedAt: number };

export interface TopographyCacheOptions {
  maxEntries?: number;
  persistenceKey?: string;
  enablePersistence?: boolean;
  persistDelayMs?: number;
}

const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_PERSIST_KEY = "visopti-elevation-cache-v1";
const DEFAULT_PERSIST_DELAY_MS = 200;
const DEFAULT_DB_NAME = "visopti-elevation-cache-v1";
const DEFAULT_DB_STORE = "entries";

export function buildElevationCacheKey(provider: string, lat: number, lon: number): string {
  return `${provider}:${roundCoord(lat)}:${roundCoord(lon)}`;
}

export function roundCoord(value: number, decimals = 5): string {
  if (!Number.isFinite(value)) {
    return "NaN";
  }
  return value.toFixed(decimals);
}

export class TopographyCache {
  private maxEntries: number;
  private persistenceKey: string;
  private enablePersistence: boolean;
  private persistDelayMs: number;
  private entries: Map<string, number>;
  private lru: string[];
  private persistTimer: ReturnType<typeof setTimeout> | null;
  private persistenceMode: PersistenceMode;
  private storage: Storage | null;
  private dbName: string;
  private storeName: string;
  private indexedDbPromise: Promise<IDBDatabase | null> | null;
  private pendingEntries: Map<string, PersistedEntry>;
  private pendingDeletes: Set<string>;
  private persistInFlight: Promise<void> | null;

  constructor(options: TopographyCacheOptions = {}) {
    this.maxEntries = Math.max(100, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.persistenceKey = options.persistenceKey ?? DEFAULT_PERSIST_KEY;
    this.enablePersistence = options.enablePersistence ?? true;
    this.persistDelayMs = Math.max(0, options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS);
    this.entries = new Map();
    this.lru = [];
    this.persistTimer = null;
    this.persistenceMode = null;
    this.storage = null;
    this.dbName = options.persistenceKey ?? DEFAULT_DB_NAME;
    this.storeName = DEFAULT_DB_STORE;
    this.indexedDbPromise = null;
    this.pendingEntries = new Map();
    this.pendingDeletes = new Set();
    this.persistInFlight = null;
    this.initPersistence();
  }

  get(key: string): number | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.touchKey(key);
    }
    return value;
  }

  set(key: string, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    if (this.entries.has(key)) {
      this.entries.set(key, value);
      this.touchKey(key);
    } else {
      this.entries.set(key, value);
      this.lru.push(key);
      this.trimToSize();
    }
    this.queuePersistEntry(key, value);
  }

  getMany(keys: string[]): Map<string, number> {
    const hits = new Map<string, number>();
    for (const key of keys) {
      const value = this.entries.get(key);
      if (value !== undefined) {
        hits.set(key, value);
        this.touchKey(key);
      }
    }
    if (hits.size > 0 && this.persistenceMode === "localstorage") {
      this.schedulePersist();
    }
    return hits;
  }

  setMany(entries: CacheEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      if (!Number.isFinite(entry.value)) {
        continue;
      }
      if (this.entries.has(entry.key)) {
        this.entries.set(entry.key, entry.value);
        this.touchKey(entry.key);
      } else {
        this.entries.set(entry.key, entry.value);
        this.lru.push(entry.key);
        changed = true;
      }
      this.queuePersistEntry(entry.key, entry.value);
    }
    if (changed) {
      this.trimToSize();
    }
  }

  private initPersistence(): void {
    if (!this.enablePersistence) {
      return;
    }

    const idbSupported = typeof indexedDB !== "undefined";
    if (idbSupported) {
      this.persistenceMode = "indexeddb";
      this.indexedDbPromise = openIndexedDb(this.dbName, this.storeName);
      this.indexedDbPromise.then((db) => {
        if (!db) {
          this.fallbackToLocalStorage();
          return;
        }
        this.loadPersistedFromIndexedDb(db);
      });
      return;
    }

    this.fallbackToLocalStorage();
  }

  private fallbackToLocalStorage(): void {
    this.storage = this.resolveLocalStorage();
    if (!this.storage) {
      this.persistenceMode = null;
      return;
    }
    this.persistenceMode = "localstorage";
    this.loadPersistedFromLocalStorage();
  }

  private resolveLocalStorage(): Storage | null {
    if (!this.enablePersistence) {
      return null;
    }
    try {
      if (typeof localStorage !== "undefined") {
        return localStorage;
      }
    } catch {
      return null;
    }
    return null;
  }

  private loadPersistedFromLocalStorage(): void {
    if (!this.storage) {
      return;
    }
    try {
      const raw = this.storage.getItem(this.persistenceKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as { entries?: Record<string, number>; lru?: string[] };
      if (parsed.entries && typeof parsed.entries === "object") {
        for (const [key, value] of Object.entries(parsed.entries)) {
          if (Number.isFinite(value)) {
            this.entries.set(key, value);
          }
        }
      }
      if (Array.isArray(parsed.lru)) {
        this.lru = parsed.lru.filter((key) => this.entries.has(key));
      } else {
        this.lru = Array.from(this.entries.keys());
      }
      this.trimToSize();
    } catch {
      this.entries.clear();
      this.lru = [];
    }
  }

  private async loadPersistedFromIndexedDb(db: IDBDatabase): Promise<void> {
    try {
      const persistedEntries = await readAllEntries(db, this.storeName);
      if (!persistedEntries.length) {
        return;
      }
      const sorted = persistedEntries
        .filter((entry) => Number.isFinite(entry.value))
        .sort((a, b) => a.updatedAt - b.updatedAt);
      for (const entry of sorted) {
        if (this.entries.has(entry.key)) {
          continue;
        }
        this.entries.set(entry.key, entry.value);
        this.lru.push(entry.key);
      }
      this.trimToSize();
    } catch {
      // Ignore persistence failures.
    }
  }

  private queuePersistEntry(key: string, value: number): void {
    if (!this.enablePersistence) {
      return;
    }
    if (this.persistenceMode === "indexeddb") {
      this.pendingEntries.set(key, { key, value, updatedAt: Date.now() });
      this.pendingDeletes.delete(key);
    }
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (!this.enablePersistence || !this.persistenceMode) {
      return;
    }
    if (this.persistDelayMs === 0) {
      this.flushPersist();
      return;
    }
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPersist();
    }, this.persistDelayMs);
  }

  private flushPersist(): void {
    if (!this.persistenceMode) {
      return;
    }
    if (this.persistenceMode === "localstorage") {
      this.persistToLocalStorage();
      return;
    }
    void this.persistToIndexedDb();
  }

  private persistToLocalStorage(): void {
    if (!this.storage) {
      return;
    }
    try {
      const payload = JSON.stringify({
        entries: Object.fromEntries(this.entries),
        lru: this.lru
      });
      this.storage.setItem(this.persistenceKey, payload);
    } catch {
      // Ignore persistence failures (e.g., quota exceeded).
    }
  }

  private async persistToIndexedDb(): Promise<void> {
    if (this.persistenceMode !== "indexeddb") {
      return;
    }
    if (this.persistInFlight) {
      return;
    }
    const db = await this.indexedDbPromise;
    if (!db) {
      return;
    }
    if (this.pendingEntries.size === 0 && this.pendingDeletes.size === 0) {
      return;
    }

    const entries = Array.from(this.pendingEntries.values());
    const deletes = Array.from(this.pendingDeletes.values());
    this.pendingEntries.clear();
    this.pendingDeletes.clear();

    this.persistInFlight = new Promise<void>((resolve) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      for (const entry of entries) {
        store.put(entry);
      }
      for (const key of deletes) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
    });

    try {
      await this.persistInFlight;
    } catch {
      // Ignore persistence failures.
    } finally {
      this.persistInFlight = null;
      if (this.pendingEntries.size > 0 || this.pendingDeletes.size > 0) {
        this.schedulePersist();
      }
    }
  }

  private trimToSize(): void {
    let evicted = false;
    while (this.lru.length > this.maxEntries) {
      const key = this.lru.shift();
      if (key) {
        this.entries.delete(key);
        if (this.persistenceMode === "indexeddb") {
          this.pendingDeletes.add(key);
        }
        evicted = true;
      }
    }
    if (evicted) {
      this.schedulePersist();
    }
  }

  private touchKey(key: string): void {
    const index = this.lru.indexOf(key);
    if (index >= 0) {
      this.lru.splice(index, 1);
    }
    this.lru.push(key);
  }
}

function openIndexedDb(dbName: string, storeName: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        const store = db.createObjectStore(storeName, { keyPath: "key" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      resolve(null);
    };
    request.onblocked = () => {
      resolve(null);
    };
  });
}

function readAllEntries(db: IDBDatabase, storeName: string): Promise<PersistedEntry[]> {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);

    const handleError = () => {
      resolve([]);
    };

    const storeWithGetAll = store as IDBObjectStore & { getAll?: () => IDBRequest };
    if (storeWithGetAll.getAll) {
      const request = storeWithGetAll.getAll();
      request.onsuccess = () => {
        resolve(request.result as PersistedEntry[]);
      };
      request.onerror = handleError;
      return;
    }

    const entries: PersistedEntry[] = [];
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const result = cursor.result;
      if (!result) {
        resolve(entries);
        return;
      }
      entries.push(result.value as PersistedEntry);
      result.continue();
    };
    cursor.onerror = handleError;
  });
}

export const topographyCache = new TopographyCache();
