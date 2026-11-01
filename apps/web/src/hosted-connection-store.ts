import type { RemoteAccessSession } from "@buildwarden/shared";

export interface HostedConnection {
  hostOrigin: string;
  token: string;
  session: RemoteAccessSession;
}

/** Browser-owned identity. A rename never changes entity or navigation keys. */
export interface InstanceConnection extends HostedConnection {
  id: string;
  name: string;
  /** Host-served entry uses its HttpOnly session cookie; token is empty. */
  cookieSession?: true;
}

const INSTANCE_PREFIX = "instance:";

export const defaultInstanceName = (hostOrigin: string): string => new URL(hostOrigin).hostname;

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
      transaction.onabort = () => reject(transaction.error ?? new Error("Browser storage transaction aborted."));
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

/** Migrate the old single connection atomically without revoking its session. */
export const readInstanceConnections = async (): Promise<InstanceConnection[]> => {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const result: InstanceConnection[] = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) {
          for (const connection of result) store.put(connection, INSTANCE_PREFIX + connection.id);
          return;
        }
        if (String(row.key).startsWith(INSTANCE_PREFIX)) result.push(row.value as InstanceConnection);
        if (row.key === ACTIVE_KEY) {
          const legacy = row.value as HostedConnection;
          const migrated = { ...legacy, id: crypto.randomUUID(), name: defaultInstanceName(legacy.hostOrigin) };
          // Write after the cursor finishes, so the migrated record is not visited twice.
          result.push(migrated);
          row.delete();
        }
        row.continue();
      };
      cursor.onerror = () => reject(cursor.error);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not read saved instances."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not migrate saved instances."));
    });
  } finally { database.close(); }
};

export const saveInstanceConnection = async (connection: InstanceConnection): Promise<void> => {
  await withStore("readwrite", (store) => store.put(connection, INSTANCE_PREFIX + connection.id));
};

export const removeInstanceConnection = async (id: string): Promise<void> => {
  await withStore("readwrite", (store) => store.delete(INSTANCE_PREFIX + id));
};
