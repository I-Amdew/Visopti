const DB_NAME = "visopti-trainer-samples-v1";
const STORE_NAME = "samples";

let dbPromise: Promise<IDBDatabase | null> | null = null;

export async function putSampleImage(sampleId: string, blobPng: Blob): Promise<void> {
  const db = await openSampleDb();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ id: sampleId, blob: blobPng });
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function getSampleImage(sampleId: string): Promise<Blob | null> {
  const db = await openSampleDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(sampleId);
    request.onsuccess = () => {
      const result = request.result as { id: string; blob: Blob } | undefined;
      resolve(result?.blob ?? null);
    };
    request.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
    tx.onerror = () => resolve(null);
  });
}

export async function deleteSample(sampleId: string): Promise<void> {
  const db = await openSampleDb();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(sampleId);
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function listSampleIds(): Promise<string[]> {
  const db = await openSampleDb();
  if (!db) {
    return [];
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      resolve(request.result.map((value) => String(value)));
    };
    request.onerror = () => resolve([]);
    tx.onabort = () => resolve([]);
    tx.onerror = () => resolve([]);
  });
}

function openSampleDb(): Promise<IDBDatabase | null> {
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
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}
