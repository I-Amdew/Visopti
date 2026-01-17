export interface StoredAsset {
  id: string;
  name: string;
  mime: string;
  data: ArrayBuffer;
}

const DB_NAME = "visopti-assets-v1";
const STORE_NAME = "assets";
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openIndexedDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
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

async function getDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = openIndexedDb();
  }
  return dbPromise;
}

export async function putAsset(asset: StoredAsset): Promise<void> {
  const db = await getDb();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(asset);
    const finish = () => resolve();
    tx.oncomplete = finish;
    tx.onabort = finish;
    tx.onerror = finish;
  });
}

export async function getAsset(id: string): Promise<StoredAsset | null> {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      resolve((request.result as StoredAsset) ?? null);
    };
    request.onerror = () => {
      resolve(null);
    };
  });
}

export async function deleteAsset(id: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    const finish = () => resolve();
    tx.oncomplete = finish;
    tx.onabort = finish;
    tx.onerror = finish;
  });
}
