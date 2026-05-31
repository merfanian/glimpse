// Shared IndexedDB helpers for transferring local PDFs from popup to viewer.
// Both are extension pages with the same origin, so they share IndexedDB.
// This avoids routing through the service worker (which can restart and lose state).
const DB_NAME = "glimpse-transfers";
const STORE = "pdfs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store raw PDF bytes under a freshly-generated key. Returns the key. */
export async function idbPutPdf(data: Uint8Array, name: string): Promise<string> {
  const key = Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ data, name }, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
  return key;
}

/** Retrieve and delete the PDF entry for the given key. Returns null if not found. */
export async function idbPopPdf(key: string): Promise<{ data: Uint8Array; name: string } | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    let value: { data: Uint8Array; name: string } | undefined;
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      value = req.result as typeof value;
      if (value) tx.objectStore(STORE).delete(key);
    };
    tx.oncomplete = () => { db.close(); resolve(value ?? null); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
