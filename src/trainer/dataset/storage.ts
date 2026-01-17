import {
  createEmptyDataset,
  DATASET_VERSION,
  migrateDataset,
  TrainerDataset
} from "./schema";

const DB_NAME = "visopti-trainer-dataset-v1";
const STORE_NAME = "datasets";
const DATASET_KEY = "active";
const LOCAL_STORAGE_KEY = "visopti-trainer-dataset-v1";
const DEFAULT_AUTOSAVE_DELAY_MS = 300;

type DatasetRecord = { key: string; value: TrainerDataset; updatedAt: number };

let dbPromise: Promise<IDBDatabase | null> | null = null;

export interface TrainerDatasetStore {
  getSnapshot(): TrainerDataset;
  update(mutator: (draft: TrainerDataset) => void): void;
  replace(next: TrainerDataset): void;
  subscribe(listener: (dataset: TrainerDataset) => void): () => void;
  flush(): Promise<void>;
  reset(): Promise<void>;
}

export async function loadDataset(): Promise<TrainerDataset> {
  const db = await openDatasetDb();
  if (db) {
    const fromDb = await readDatasetFromIndexedDb(db);
    if (fromDb) {
      const migrated = migrateDataset(fromDb);
      if (fromDb.version !== DATASET_VERSION) {
        await saveDataset(migrated);
      }
      return migrated;
    }
  }

  const fromLocal = readDatasetFromLocalStorage();
  if (fromLocal) {
    const migrated = migrateDataset(fromLocal);
    await saveDataset(migrated);
    return migrated;
  }

  const empty = createEmptyDataset();
  await saveDataset(empty);
  return empty;
}

export async function saveDataset(dataset: TrainerDataset): Promise<void> {
  const db = await openDatasetDb();
  if (db) {
    const success = await writeDatasetToIndexedDb(db, dataset);
    if (success) {
      return;
    }
  }

  const storage = resolveLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(dataset));
  } catch {
    // Ignore persistence failures.
  }
}

export async function resetDataset(): Promise<void> {
  const db = await openDatasetDb();
  if (db) {
    await deleteDatasetFromIndexedDb(db);
  }
  const storage = resolveLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(LOCAL_STORAGE_KEY);
  } catch {
    // Ignore persistence failures.
  }
}

export async function createDatasetStore(
  options?: { autosaveDelayMs?: number }
): Promise<TrainerDatasetStore> {
  const autosaveDelayMs = Math.max(0, options?.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS);
  let dataset = await loadDataset();
  const listeners = new Set<(dataset: TrainerDataset) => void>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave = false;

  const notify = () => {
    listeners.forEach((listener) => listener(dataset));
  };

  const queueSave = () => {
    pendingSave = true;
    if (autosaveDelayMs === 0) {
      pendingSave = false;
      void saveDataset(dataset);
      return;
    }
    if (saveTimer) {
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!pendingSave) {
        return;
      }
      pendingSave = false;
      void saveDataset(dataset);
    }, autosaveDelayMs);
  };

  const flush = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    pendingSave = false;
    await saveDataset(dataset);
  };

  const reset = async () => {
    await resetDataset();
    dataset = createEmptyDataset();
    await saveDataset(dataset);
    notify();
  };

  return {
    getSnapshot: () => dataset,
    update: (mutator) => {
      mutator(dataset);
      queueSave();
      notify();
    },
    replace: (next) => {
      dataset = next;
      queueSave();
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush,
    reset
  };
}

function openDatasetDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
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
  return dbPromise;
}

function readDatasetFromIndexedDb(db: IDBDatabase): Promise<TrainerDataset | null> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(DATASET_KEY);
    request.onsuccess = () => {
      const result = request.result as DatasetRecord | undefined;
      resolve(result?.value ?? null);
    };
    request.onerror = () => {
      resolve(null);
    };
    tx.onabort = () => resolve(null);
    tx.onerror = () => resolve(null);
  });
}

function writeDatasetToIndexedDb(db: IDBDatabase, dataset: TrainerDataset): Promise<boolean> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ key: DATASET_KEY, value: dataset, updatedAt: Date.now() });
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => resolve(false);
    tx.onerror = () => resolve(false);
  });
}

function deleteDatasetFromIndexedDb(db: IDBDatabase): Promise<boolean> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(DATASET_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => resolve(false);
    tx.onerror = () => resolve(false);
  });
}

function resolveLocalStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

function readDatasetFromLocalStorage(): TrainerDataset | null {
  const storage = resolveLocalStorage();
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as TrainerDataset;
  } catch {
    return null;
  }
}
