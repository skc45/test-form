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

export const MAX_RECENTS = 3;

export function emptySession() {
  return {
    source: "demo",
    folderName: "",
    folderPath: "",
    photoCount: 0,
    layout: "masonry",
    filter: "all",
    openedAt: "",
    recents: [],
  };
}

export function recentId(entry) {
  return String(entry?.id || entry?.path || entry?.name || "").trim();
}

export function normalizeRecents(raw) {
  const out = [];
  const seen = new Set();
  for (const item of raw || []) {
    const entry =
      typeof item === "string"
        ? { id: item, path: item, name: item.split(/[\\/]/).filter(Boolean).pop() || item, photoCount: 0, cover: "" }
        : {
            id: recentId(item),
            name: item.name || item.lastFolderName || "Folder",
            path: item.path || item.lastFolder || "",
            photoCount: item.photoCount || 0,
            cover: item.cover || "",
            openedAt: item.openedAt || item.updatedAt || "",
          };
    if (!entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
    if (out.length === MAX_RECENTS) break;
  }
  return out;
}

export function upsertRecent(recents, entry) {
  const next = {
    id: recentId(entry),
    name: entry.name || "Folder",
    path: entry.path || "",
    photoCount: entry.photoCount || 0,
    cover: entry.cover || "",
    openedAt: entry.openedAt || new Date().toISOString(),
  };
  if (!next.id) return normalizeRecents(recents);
  return normalizeRecents([next, ...(recents || [])]);
}

export function recentsFromSession(session) {
  const extras = [];
  const path = session?.lastFolder || session?.folderPath || "";
  const name = session?.lastFolderName || session?.folderName || "";
  if (path || name) {
    extras.push({
      id: path || name,
      path,
      name: name || "Folder",
      photoCount: session.photoCount || 0,
      cover: session.cover || "",
      openedAt: session.openedAt || session.updatedAt || "",
    });
  }
  return normalizeRecents([...(session?.recents || []), ...extras]);
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
  const id = recentId(meta);
  if (id) {
    const handles = (await loadRecentHandles()) || {};
    handles[id] = handle;
    await idbOp("readwrite", (store) => store.put(handles, "recentHandles"));
  }
}

export async function loadRecentHandles() {
  if (!idbAvailable()) return {};
  try {
    return (await idbOp("readonly", (store) => store.get("recentHandles"))) || {};
  } catch {
    return {};
  }
}

export async function loadRecentHandle(id) {
  if (!id) return loadFolderHandle();
  const handles = await loadRecentHandles();
  return handles[id] || loadFolderHandle();
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
