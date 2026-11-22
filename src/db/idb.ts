// Minimal IndexedDB key-value store for the database file (localStorage is too small for it).

const DB_NAME = "dpp-trace";
const STORE = "files";
/** The central record's snapshots (Cycle 4), keyed by [model, batch, version]. Added in database version 2. */
const SNAPSHOTS = "snapshots";
/** The execution log (Cycle 5), keyed by its own sequence number. Added in database version 3. */
const LOG = "log";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    // Version 1 had only `files`, version 2 added `snapshots`; each upgrade keeps what exists and adds what is missing.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS);
      if (!db.objectStoreNames.contains(LOG)) db.createObjectStore(LOG, { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

export const idbGet = (key: string) => run<Uint8Array | undefined>("readonly", (s) => s.get(key));
export const idbSet = (key: string, value: Uint8Array) => run("readwrite", (s) => s.put(value, key));

const inStore = <T>(name: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(name, mode);
        const req = fn(tx.objectStore(name));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );

/** Adds a snapshot. `add` fails if the key exists, so a stored version can never be overwritten. */
export const idbSnapshotAdd = (model: string, batch: string, version: number, value: unknown) =>
  inStore(SNAPSHOTS, "readwrite", (s) => s.add(value, [model, batch, version]));

export const idbSnapshotRange = (model: string, batch: string) =>
  inStore<unknown[]>(SNAPSHOTS, "readonly", (s) => s.getAll(IDBKeyRange.bound([model, batch, 0], [model, batch, Number.MAX_SAFE_INTEGER])));

export const idbSnapshotKeys = () => inStore<IDBValidKey[]>(SNAPSHOTS, "readonly", (s) => s.getAllKeys());

/** Appends a log entry and returns the sequence number the store gave it. Entries are never updated or removed. */
export const idbLogAdd = (entry: unknown) => inStore<IDBValidKey>(LOG, "readwrite", (s) => s.add(entry)).then((key) => Number(key));

export const idbLogAll = () => inStore<unknown[]>(LOG, "readonly", (s) => s.getAll());
