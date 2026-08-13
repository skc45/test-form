const DB_NAME = "aperture-cache";
const DB_VERSION = 1;
const STORE = "kv";
const SESSION_KEY = "aperture.session";

function idbAvailable() {
  return typeof indexedDB !== "undefined";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbOp(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const request = fn(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

export function emptySession() {
  return {
    source: "demo",
    folderName: "",
    folderPath: "",
    photoCount: 0,
    layout: "masonry",
    filter: "all",
    openedAt: "",
  };
}

export function readLocalSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return emptySession();
    return { ...emptySession(), ...JSON.parse(raw) };
  } catch {
    return emptySession();
  }
}

export function writeLocalSession(session) {
  const next = { ...emptySession(), ...session, updatedAt: new Date().toISOString() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  return next;
}

export async function saveSession(session) {
  const next = writeLocalSession(session);
  if (!idbAvailable()) return next;
  try {
    await idbOp("readwrite", (store) => store.put(next, "session"));
  } catch {
    /* localStorage already holds the session */
  }
  return next;
}

export async function loadSession() {
  if (idbAvailable()) {
    try {
      const stored = await idbOp("readonly", (store) => store.get("session"));
      if (stored) return { ...emptySession(), ...stored };
    } catch {
      /* fall through to localStorage */
    }
  }
  return readLocalSession();
}

export async function saveFolderHandle(handle, meta = {}) {
  if (!handle || !idbAvailable()) return;
  await idbOp("readwrite", (store) => store.put({ handle, ...meta, savedAt: Date.now() }, "folderHandle"));
}

export async function loadFolderHandle() {
  if (!idbAvailable()) return null;
  try {
    const record = await idbOp("readonly", (store) => store.get("folderHandle"));
    return record?.handle || null;
  } catch {
    return null;
  }
}

export async function saveCatalogIndex(photos) {
  if (!idbAvailable()) return;
  const index = photos.map((photo) => ({
    id: photo.id,
    title: photo.title,
    location: photo.location,
    category: photo.category,
    year: photo.year,
  }));
  try {
    await idbOp("readwrite", (store) => store.put(index, "catalogIndex"));
  } catch {
    /* ignore quota errors */
  }
}

export async function loadCatalogIndex() {
  if (!idbAvailable()) return [];
  try {
    return (await idbOp("readonly", (store) => store.get("catalogIndex"))) || [];
  } catch {
    return [];
  }
}

export async function clearCache() {
  localStorage.removeItem(SESSION_KEY);
  if (!idbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* already cleared locally */
  }
}

export async function queryHandlePermission(handle) {
  if (!handle?.queryPermission) return "prompt";
  try {
    return await handle.queryPermission({ mode: "read" });
  } catch {
    return "prompt";
  }
}

export async function requestHandlePermission(handle) {
  if (!handle?.requestPermission) return "denied";
  try {
    return await handle.requestPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}
