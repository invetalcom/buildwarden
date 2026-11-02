/** Browser-owned blobs, separate from the small synchronous draft metadata. */
export interface DraftAttachmentStorage {
  keys?(): Promise<string[]>;
  get(id: string): Promise<Blob | undefined>;
  put(id: string, blob: Blob): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createDraftAttachmentStorage(): DraftAttachmentStorage {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => database ??= Promise.resolve().then(() => new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open("buildwarden-composer-attachments", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("attachments");
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { blocked = true; reject(new Error("Draft attachment storage is blocked by another window.")); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  })).catch((error: unknown) => { database = undefined; throw error; });
  const transact = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("attachments", mode);
      const request = action(transaction.objectStore("attachments"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error("Draft attachment storage failed."));
    });
  };
  return {
    keys: async () => (await transact("readonly", (store) => store.getAllKeys())).filter((key): key is string => typeof key === "string"),
    get: (id) => transact<Blob | undefined>("readonly", (store) => store.get(id)),
    put: async (id, blob) => { await transact("readwrite", (store) => store.put(blob, id)); },
    remove: async (id) => { await transact("readwrite", (store) => store.delete(id)); },
  };
}
