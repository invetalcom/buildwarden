import type { RemoteAccessSession } from "@buildwarden/shared";

export interface HostedConnection {
  hostOrigin: string;
  token: string;
  session: RemoteAccessSession;
}

const DATABASE_NAME = "buildwarden-remote";
const STORE_NAME = "connection";
const ACTIVE_KEY = "active";

const openDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not open browser storage."));
});

const withStore = async <Result>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<Result>,
): Promise<Result> => {
  const database = await openDatabase();
  try {
    return await new Promise<Result>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      let result!: Result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error("Browser storage failed."));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Browser storage transaction failed."));
    });
  } finally {
    database.close();
  }
};

export const readHostedConnection = async (): Promise<HostedConnection | null> => {
  if (typeof indexedDB === "undefined") return null;
  return await withStore<HostedConnection | undefined>("readonly", (store) => store.get(ACTIVE_KEY)) ?? null;
};

export const saveHostedConnection = async (connection: HostedConnection): Promise<void> => {
  await withStore<IDBValidKey>("readwrite", (store) => store.put(connection, ACTIVE_KEY));
};

export const clearHostedConnection = async (): Promise<void> => {
  if (typeof indexedDB === "undefined") return;
  await withStore<undefined>("readwrite", (store) => store.delete(ACTIVE_KEY));
};
