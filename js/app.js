import { CATEGORIES as DEMO_CATEGORIES, PHOTOS as DEMO_PHOTOS, fallbackSrc, plateNumber } from "./catalog.js";
import * as cache from "./data.js";

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?|avif|svg)$/i;

const state = {
  photos: [...DEMO_PHOTOS],
  categories: DEMO_CATEGORIES,
  source: "demo",
  folderName: "",
  folderPath: "",
  folderHandle: null,
  filter: "all",
  query: "",
  layout: "masonry",
  activeIndex: 0,
  open: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  cover: false,
  slideshow: false,
  dragging: false,
  pointer: { x: 0, y: 0 },
  blobUrls: [],
};

const els = {
  filters: document.getElementById("filters"),
  catalog: document.getElementById("catalog"),
  empty: document.getElementById("empty"),
  count: document.getElementById("resultCount"),
  search: document.getElementById("search"),
  layoutBtn: document.getElementById("layoutBtn"),
  fileInput: document.getElementById("fileInput"),
  folderInput: document.getElementById("folderInput"),
  folderBtn: document.getElementById("folderBtn"),
  hero: document.getElementById("hero"),
  heroBtn: document.getElementById("heroBtn"),
  heroImg: document.getElementById("heroImg"),
  heroTitle: document.getElementById("heroTitle"),
  heroMeta: document.getElementById("heroMeta"),
  heroIndex: document.getElementById("heroIndex"),
  viewer: document.getElementById("viewer"),
  viewerImage: document.getElementById("viewerImage"),
  viewerTitle: document.getElementById("viewerTitle"),
  viewerMeta: document.getElementById("viewerMeta"),
  viewerKicker: document.getElementById("viewerKicker"),
  counter: document.getElementById("counter"),
  filmstrip: document.getElementById("filmstrip"),
  help: document.getElementById("help"),
  opener: document.getElementById("opener"),
  cacheCard: document.getElementById("cacheCard"),
  recentRow: document.getElementById("recentRow"),
  catalogHint: document.getElementById("catalogHint"),
  app: document.getElementById("app"),
  brandKicker: document.querySelector(".brand-kicker"),
};

let slideTimer = 0;
let chromeTimer = 0;
let swipe = { x: 0, t: 0 };

function slug(value) {
  return String(value || "folder")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "folder";
}

function labelize(value) {
  return String(value || "Folder")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function photoMeta(photo) {
  return [photo.photographer, photo.location, photo.year].filter(Boolean).join(" · ");
}

function isImageName(name) {
  return IMAGE_RE.test(name || "");
}

function categoriesFrom(photos) {
  const seen = [];
  for (const photo of photos) {
    if (!seen.some((cat) => cat.id === photo.category)) {
      seen.push({ id: photo.category, label: labelize(photo.category) });
    }
  }
  return [{ id: "all", label: "All plates" }, ...seen];
}

function revokeBlobs() {
  for (const url of state.blobUrls) URL.revokeObjectURL(url);
  state.blobUrls = [];
}

function visiblePhotos() {
  const q = state.query.trim().toLowerCase();
  return state.photos.filter((photo) => {
    const catOk = state.filter === "all" || photo.category === state.filter;
    if (!catOk) return false;
    if (!q) return true;
    return [photo.title, photo.location, photo.photographer, photo.category]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

function bindImage(img, photo, size = "thumb") {
  const src = size === "hero" ? photo.hero || photo.src : size === "full" ? photo.src : photo.thumb;
  img.src = src;
  img.alt = `${photo.title}${photo.location ? ` — ${photo.location}` : ""}`;
  img.addEventListener(
    "error",
    () => {
      if (!photo.local) img.src = fallbackSrc(photo.id);
    },
    { once: true }
  );
  if (img.complete && img.naturalWidth) img.classList.add("is-ready");
  else img.addEventListener("load", () => img.classList.add("is-ready"), { once: true });
}

function renderFilters() {
  els.filters.innerHTML = state.categories
    .map(
      (cat) => `
      <button class="filter" type="button" data-filter="${cat.id}" aria-pressed="${
        state.filter === cat.id
      }">${cat.label}</button>`
    )
    .join("");
}

function renderHero() {
  const featured = state.photos.find((p) => p.featured) || state.photos[0];
  if (!featured) {
    els.hero.hidden = true;
    return;
  }
  els.hero.hidden = false;
  bindImage(els.heroImg, featured, "hero");
  els.heroTitle.textContent = featured.title;
  els.heroMeta.textContent = photoMeta(featured);
  els.heroIndex.textContent = `Plate ${plateNumber(featured.index)}`;
  els.heroBtn.onclick = () => openViewer(featured.id);
}

function renderCatalog() {
  const photos = visiblePhotos();
  const noun = photos.length === 1 ? "plate" : "plates";
  els.count.textContent = state.folderName
    ? `${photos.length} ${noun} · ${state.folderName}`
    : `${photos.length} ${noun}`;
  els.empty.hidden = photos.length > 0;
  els.empty.textContent = state.query
    ? "No plates match that search."
    : "No images in this folder.";
  els.catalog.classList.toggle("grid", state.layout === "grid");
  els.catalog.classList.toggle("masonry", state.layout === "masonry");
  els.catalog.innerHTML = photos
    .map(
      (photo) => `
      <button class="card" type="button" role="listitem" data-id="${photo.id}">
        <span class="card-index">${plateNumber(photo.index)}</span>
        <img alt="" />
        <span class="card-meta">
          <strong>${photo.title}</strong>
          <span>${photo.location || photo.category}</span>
        </span>
      </button>`
    )
    .join("");

  [...els.catalog.querySelectorAll(".card")].forEach((card, i) => {
    const photo = photos[i];
    bindImage(card.querySelector("img"), photo);
    card.addEventListener("click", () => openViewer(photo.id));
  });
}

function renderFilmstrip(photos) {
  els.filmstrip.innerHTML = photos
    .map(
      (photo) => `
      <button class="thumb" type="button" role="option" data-id="${photo.id}" aria-selected="${
        photos[state.activeIndex]?.id === photo.id
      }">
        <img alt="${photo.title}" />
      </button>`
    )
    .join("");
  [...els.filmstrip.querySelectorAll(".thumb")].forEach((thumb, i) => {
    bindImage(thumb.querySelector("img"), photos[i]);
    thumb.addEventListener("click", () => showIndex(i));
  });
  const selected = els.filmstrip.querySelector('[aria-selected="true"]');
  selected?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
}

function applyTransform() {
  const { zoom, panX, panY } = state;
  els.viewerImage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

function resetView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyTransform();
}

function showIndex(index) {
  const photos = visiblePhotos();
  if (!photos.length) return;
  state.activeIndex = (index + photos.length) % photos.length;
  const photo = photos[state.activeIndex];
  els.viewer.classList.add("is-loading", "show-chrome");
  resetView();
  els.viewerTitle.textContent = photo.title;
  els.viewerMeta.textContent = photoMeta(photo);
  els.viewerKicker.textContent = `Plate ${plateNumber(photo.index)} · ${photo.category}`;
  els.counter.textContent = `${state.activeIndex + 1} / ${photos.length}`;
  els.viewerImage.classList.remove("is-ready");
  bindImage(els.viewerImage, photo, "full");
  els.viewerImage.addEventListener(
    "load",
    () => els.viewer.classList.remove("is-loading"),
    { once: true }
  );
  if (els.viewerImage.complete) els.viewer.classList.remove("is-loading");
  history.replaceState(null, "", `#photo/${encodeURIComponent(photo.id)}`);
  renderFilmstrip(photos);
  pulseChrome();
}

function openViewer(id) {
  const photos = visiblePhotos();
  const index = photos.findIndex((p) => p.id === id);
  state.open = true;
  els.viewer.hidden = false;
  requestAnimationFrame(() => els.viewer.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  showIndex(index >= 0 ? index : 0);
}

function closeViewer() {
  state.open = false;
  stopSlideshow();
  els.viewer.classList.remove("is-open");
  document.body.style.overflow = "";
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  setTimeout(() => {
    if (!state.open) els.viewer.hidden = true;
  }, 280);
}

function next(delta = 1) {
  showIndex(state.activeIndex + delta);
}

function startSlideshow() {
  state.slideshow = true;
  document.getElementById("slideBtn").setAttribute("aria-pressed", "true");
  slideTimer = window.setInterval(() => next(1), 3200);
}

function stopSlideshow() {
  state.slideshow = false;
  document.getElementById("slideBtn").setAttribute("aria-pressed", "false");
  window.clearInterval(slideTimer);
}

function toggleSlideshow() {
  state.slideshow ? stopSlideshow() : startSlideshow();
}

function pulseChrome() {
  els.viewer.classList.add("show-chrome");
  window.clearTimeout(chromeTimer);
  chromeTimer = window.setTimeout(() => els.viewer.classList.remove("show-chrome"), 2200);
}

function setCatalog(photos, { folderName = "", folderPath = "", source = "folder", handle = null } = {}) {
  if (state.open) closeViewer();
  state.photos = photos.map((photo, index) => ({ ...photo, index }));
  state.categories = source === "demo" ? DEMO_CATEGORIES : categoriesFrom(state.photos);
  state.source = source;
  state.folderName = folderName;
  state.folderPath = folderPath;
  if (handle) state.folderHandle = handle;
  if (source !== "folder") state.folderHandle = null;
  state.filter = "all";
  state.query = "";
  els.search.value = "";
  els.brandKicker.textContent = folderName || "Vol. I · Photographica";
  hideOpener();
  renderFilters();
  renderHero();
  renderCatalog();
  persistCatalog();
}

function persistCatalog() {
  void persistCatalogAsync();
}

async function persistCatalogAsync() {
  const hint = els.catalogHint;
  if (state.source === "folder" && state.folderName) {
    if (hint) {
      hint.innerHTML = `Cached folder · ${escapeHtml(state.folderName)} · <kbd>O</kbd> change · <kbd>?</kbd> shortcuts`;
    }
    const session = await cache.loadSession();
    const cover = await coverFromPhoto(state.photos[0]);
    const entry = {
      id: state.folderPath || state.folderName,
      name: state.folderName,
      path: state.folderPath,
      photoCount: state.photos.length,
      openedAt: new Date().toISOString(),
      cover,
    };
    const recents = cache.upsertRecent(session.recents, entry);
    cache.saveSession({
      source: "folder",
      folderName: state.folderName,
      folderPath: state.folderPath,
      photoCount: state.photos.length,
      layout: state.layout,
      filter: state.filter,
      openedAt: entry.openedAt,
      recents,
    });
    cache.saveCatalogIndex(state.photos);
    if (state.folderHandle) {
      cache.saveFolderHandle(state.folderHandle, entry);
    }
    return;
  }
  if (hint) {
    hint.innerHTML = "Open a folder · click a plate · <kbd>O</kbd> folder · <kbd>?</kbd> shortcuts";
  }
}

async function coverFromPhoto(photo) {
  if (!photo) return "";
  const src = photo.thumb || photo.src || "";
  if (!src || src.startsWith("/media/") || src.startsWith("/api/")) return "";
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const width = 320;
      const height = 400;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve("");
        return;
      }
      const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch {
        resolve("");
      }
    };
    img.onerror = () => resolve("");
    img.src = src;
  });
}

function plateCover(item, index) {
  if (item.cover && item.cover.startsWith("data:")) return item.cover;
  const path = item.path || "";
  if (path.startsWith("/") || path.includes(":\\") || path.startsWith("content:") || path.startsWith("file:")) {
    return `/api/recent-cover?i=${index}`;
  }
  return item.cover || "";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function photoFromFile(file, relPath, folderName) {
  const url = URL.createObjectURL(file);
  state.blobUrls.push(url);
  const parts = (relPath || file.name).split("/").filter(Boolean);
  const parent = parts.length > 1 ? parts[parts.length - 2] : folderName || "folder";
  const location = parts.length > 1 ? parts.slice(0, -1).join("/") : folderName || "Local file";
  return {
    id: `local-${state.blobUrls.length}-${file.name}`,
    title: file.name.replace(/\.[^.]+$/, ""),
    photographer: folderName || "Folder",
    location,
    year: file.lastModified ? new Date(file.lastModified).getFullYear() : new Date().getFullYear(),
    category: slug(parent),
    src: url,
    thumb: url,
    hero: url,
    local: true,
  };
}

function loadFiles(files, { append = false, folderName = "" } = {}) {
  const images = [...files].filter((file) => isImageName(file.name) || file.type.startsWith("image/"));
  if (!images.length) {
    els.empty.hidden = false;
    els.empty.textContent = "No images in this folder.";
    return;
  }
  if (!append) revokeBlobs();
  const photos = images.map((file) => photoFromFile(file, file.webkitRelativePath, folderName));
  const name = folderName || guessFolderName(images) || "Folder";
  if (append) {
    setCatalog([...photos, ...state.photos], { folderName: name, source: "folder" });
  } else {
    photos[0].featured = true;
    setCatalog(photos, { folderName: name, source: "folder" });
  }
}

function guessFolderName(files) {
  const rel = files.find((file) => file.webkitRelativePath)?.webkitRelativePath;
  if (!rel) return "";
  return rel.split("/")[0] || "";
}

function addFiles(files) {
  loadFiles(files, { append: true, folderName: state.folderName || "Yours" });
}

async function walkDirectoryHandle(handle, photos, folderName, prefix = "") {
  for await (const [name, child] of handle.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.kind === "directory") {
      await walkDirectoryHandle(child, photos, folderName, rel);
    } else if (isImageName(name)) {
      const file = await child.getFile();
      photos.push(photoFromFile(file, rel, folderName));
    }
  }
}

async function walkEntry(entry, photos, folderName, prefix = "") {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    if (isImageName(entry.name) || file.type.startsWith("image/")) {
      photos.push(photoFromFile(file, prefix ? `${prefix}/${entry.name}` : entry.name, folderName));
    }
    return;
  }
  const reader = entry.createReader();
  const readBatch = () =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  let batch = await readBatch();
  while (batch.length) {
    for (const child of batch) {
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      await walkEntry(child, photos, folderName, nextPrefix);
    }
    batch = await readBatch();
  }
}

async function openDirectoryHandle(handle) {
  revokeBlobs();
  const photos = [];
  await walkDirectoryHandle(handle, photos, handle.name);
  if (photos.length) photos[0].featured = true;
  state.folderHandle = handle;
  setCatalog(photos, { folderName: handle.name, folderPath: handle.name, source: "folder", handle });
  return photos.length;
}

async function openFolderOrRecents() {
  const session = await loadMergedSession();
  const recents = cache.recentsFromSession(session);
  if (recents.length) {
    paintCacheCard(session);
    showOpener();
    return;
  }
  await openFolderPicker();
}

async function openFolderPicker() {
  if (window.ApertureAndroid?.openFolder) {
    window.ApertureAndroid.openFolder();
    return;
  }
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ mode: "read" });
      await openDirectoryHandle(dir);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  els.folderInput.click();
}

async function openRecent(index, id) {
  if (window.ApertureAndroid?.openRecent) {
    window.ApertureAndroid.openRecent(index);
    return;
  }
  const handles = await cache.loadRecentHandles();
  const handle = handles[id];
  if (handle) {
    const permission = await cache.requestHandlePermission(handle);
    if (permission === "granted") {
      await openDirectoryHandle(handle);
      return;
    }
  }
  const session = await loadMergedSession();
  const recents = cache.recentsFromSession(session);
  const item = recents[index] || recents.find((entry) => entry.id === id);
  if (item?.path) {
    try {
      const response = await fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ path: item.path }),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.photos) && data.photos.length) {
          setCatalog(data.photos, {
            folderName: data.folder || item.name,
            folderPath: data.path || item.path,
            source: "folder",
          });
          return;
        }
      }
    } catch {
      /* static hosts have no open API */
    }
  }
  await openFolderPicker();
}

function paintCacheCard(session) {
  const recents = cache.recentsFromSession(session);
  const row = els.recentRow;
  els.cacheCard.hidden = recents.length === 0;
  if (!recents.length) {
    document.getElementById("openerFolderBtn").classList.add("opener-primary");
    if (row) row.innerHTML = "";
    return;
  }
  document.getElementById("openerFolderBtn").classList.remove("opener-primary");
  if (!row) return;
  row.innerHTML = recents
    .map((item, index) => {
      const cover = plateCover(item, index);
      const count = item.photoCount
        ? `${item.photoCount} plate${item.photoCount === 1 ? "" : "s"}`
        : "Folder";
      return `
      <button class="recent-plate" type="button" data-index="${index}" data-id="${escapeHtml(item.id)}">
        ${cover ? `<img alt="" src="${escapeHtml(cover)}" />` : `<span class="recent-plate-fill"></span>`}
        <span class="recent-plate-index">${plateNumber(index)}</span>
        <span class="recent-plate-meta"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(count)}</span></span>
      </button>`;
    })
    .join("");
  [...row.querySelectorAll(".recent-plate")].forEach((btn) => {
    const img = btn.querySelector("img");
    if (img) {
      if (img.complete && img.naturalWidth) img.classList.add("is-ready");
      img.addEventListener("load", () => img.classList.add("is-ready"), { once: true });
      img.addEventListener("error", () => img.classList.add("is-missing"), { once: true });
    }
    btn.addEventListener("click", () => openRecent(Number(btn.dataset.index), btn.dataset.id));
  });
}

async function forgetFolder() {
  await cache.clearCache();
  try {
    await fetch("/api/cache", { method: "DELETE" });
  } catch {
    /* static hosts have no cache API */
  }
  state.folderHandle = null;
  state.folderPath = "";
  paintCacheCard(cache.emptySession());
  restoreDemo();
}

async function loadMergedSession() {
  let session = await cache.loadSession();
  try {
    const response = await fetch("/api/cache", { headers: { Accept: "application/json" } });
    if (response.ok) {
      const disk = await response.json();
      session = {
        ...session,
        source: disk.lastFolder || session.folderName ? "folder" : session.source,
        folderName: session.folderName || disk.lastFolderName || "",
        folderPath: session.folderPath || disk.lastFolder || "",
        photoCount: session.photoCount || disk.photoCount || 0,
        openedAt: session.openedAt || disk.updatedAt || "",
        recents: cache.normalizeRecents([
          ...(disk.recents || []),
          ...(session.recents || []),
          disk.lastFolder
            ? {
                id: disk.lastFolder,
                path: disk.lastFolder,
                name: disk.lastFolderName || "",
                photoCount: disk.photoCount || 0,
                openedAt: disk.updatedAt || "",
              }
            : null,
        ].filter(Boolean)),
      };
    }
  } catch {
    /* static hosts have no cache API */
  }
  return session;
}

async function restoreCachedFolder() {
  const session = await loadMergedSession();
  if (session.layout === "grid" || session.layout === "masonry") {
    state.layout = session.layout;
  }
  const handle = await cache.loadFolderHandle();
  if (handle) {
    state.folderHandle = handle;
    const permission = await cache.queryHandlePermission(handle);
    if (permission === "granted") {
      await openDirectoryHandle(handle);
      return true;
    }
  }
  paintCacheCard(session);
  return false;
}

function showOpener() {
  els.opener.hidden = false;
}

function hideOpener() {
  els.opener.hidden = true;
}

function restoreDemo() {
  revokeBlobs();
  setCatalog(DEMO_PHOTOS.map((photo) => ({ ...photo })), { source: "demo" });
}

async function loadFromApi() {
  try {
    const response = await fetch("/api/catalog", { headers: { Accept: "application/json" } });
    if (!response.ok) return false;
    const data = await response.json();
    if (!data || !Array.isArray(data.photos)) return false;
    if (!data.photos.length) return false;
    setCatalog(data.photos, {
      folderName: data.folder || "",
      folderPath: data.path || "",
      source: "folder",
    });
    return true;
  } catch {
    return false;
  }
}

function onHash() {
  const match = location.hash.match(/^#photo\/(.+)$/);
  if (match) openViewer(decodeURIComponent(match[1]));
}

function onKey(event) {
  if (event.key === "o" || event.key === "O") {
    if (event.target.matches("input, textarea")) return;
    event.preventDefault();
    openFolderOrRecents();
    return;
  }
  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    els.help.hidden = !els.help.hidden;
    return;
  }
  if (event.key === "Escape") {
    if (!els.help.hidden) {
      els.help.hidden = true;
      return;
    }
    if (!els.opener.hidden && state.photos.length) {
      hideOpener();
      return;
    }
    if (state.open) closeViewer();
    return;
  }
  if (!state.open) return;
  if (event.key === "ArrowRight") next(1);
  if (event.key === "ArrowLeft") next(-1);
  if (event.key === " ") {
    event.preventDefault();
    toggleSlideshow();
  }
  if (event.key === "f" || event.key === "F") toggleFullscreen();
  if (event.key === "c" || event.key === "C") toggleCover();
  if (event.key === "z" || event.key === "Z" || event.key === "+") setZoom(state.zoom + 0.25);
  if (event.key === "-" || event.key === "_") setZoom(state.zoom - 0.25);
  if (event.key === "0") resetView();
}

function setZoom(value) {
  state.zoom = Math.min(4, Math.max(1, value));
  if (state.zoom === 1) {
    state.panX = 0;
    state.panY = 0;
  }
  applyTransform();
}

function toggleCover() {
  state.cover = !state.cover;
  els.viewer.classList.toggle("is-cover", state.cover);
  resetView();
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) await els.viewer.requestFullscreen?.();
  else await document.exitFullscreen?.();
}

async function ingestDataTransfer(transfer) {
  const items = [...(transfer.items || [])];
  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    revokeBlobs();
    const photos = [];
    const rootName = entries.length === 1 ? entries[0].name : "Folder";
    for (const entry of entries) await walkEntry(entry, photos, rootName);
    if (!photos.length) return;
    photos[0].featured = true;
    setCatalog(photos, { folderName: rootName, source: "folder" });
    return;
  }
  if (transfer.files?.length) loadFiles(transfer.files, { folderName: guessFolderName(transfer.files) });
}

async function wire() {
  if (window.ApertureAndroid) {
    document.documentElement.classList.add("is-native-app");
  }
  const params = new URLSearchParams(location.search);
  const appMode = params.get("mode") === "app";
  const fromApi = await loadFromApi();
  const fromCache = fromApi ? false : await restoreCachedFolder();

  if (!fromApi && !fromCache) {
    renderFilters();
    renderHero();
    renderCatalog();
    paintCacheCard(await loadMergedSession());
  }
  if (appMode && !fromApi && !fromCache) showOpener();
  else if (!fromApi && !fromCache && (await loadMergedSession()).source === "folder") showOpener();

  els.filters.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-filter]");
    if (!btn) return;
    state.filter = btn.dataset.filter;
    renderFilters();
    renderCatalog();
    persistCatalog();
  });

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    renderCatalog();
  });

  els.layoutBtn.addEventListener("click", () => {
    state.layout = state.layout === "masonry" ? "grid" : "masonry";
    renderCatalog();
    persistCatalog();
  });

  els.folderBtn.addEventListener("click", openFolderOrRecents);
  document.getElementById("openerFolderBtn").addEventListener("click", openFolderPicker);
  document.getElementById("forgetBtn").addEventListener("click", forgetFolder);
  document.getElementById("demoBtn").addEventListener("click", restoreDemo);
  els.folderInput.addEventListener("change", () => {
    loadFiles(els.folderInput.files, { folderName: guessFolderName(els.folderInput.files) });
    els.folderInput.value = "";
  });
  els.fileInput.addEventListener("change", () => addFiles(els.fileInput.files));
  document.getElementById("closeBtn").addEventListener("click", closeViewer);
  document.getElementById("prevBtn").addEventListener("click", () => next(-1));
  document.getElementById("nextBtn").addEventListener("click", () => next(1));
  document.getElementById("slideBtn").addEventListener("click", toggleSlideshow);
  document.getElementById("fitBtn").addEventListener("click", toggleCover);
  document.getElementById("zoomInBtn").addEventListener("click", () => setZoom(state.zoom + 0.25));
  document.getElementById("zoomOutBtn").addEventListener("click", () => setZoom(state.zoom - 0.25));
  document.getElementById("fullBtn").addEventListener("click", toggleFullscreen);
  document.getElementById("helpClose").addEventListener("click", () => {
    els.help.hidden = true;
  });
  els.help.addEventListener("click", (event) => {
    if (event.target === els.help) els.help.hidden = true;
  });

  els.viewer.addEventListener("mousemove", pulseChrome);
  els.viewerImage.addEventListener(
    "wheel",
    (event) => {
      if (!state.open) return;
      event.preventDefault();
      setZoom(state.zoom + (event.deltaY < 0 ? 0.12 : -0.12));
    },
    { passive: false }
  );

  els.viewerImage.addEventListener("pointerdown", (event) => {
    if (state.zoom === 1) {
      swipe = { x: event.clientX, t: Date.now() };
      return;
    }
    state.dragging = true;
    state.pointer = { x: event.clientX - state.panX, y: event.clientY - state.panY };
    els.viewerImage.setPointerCapture(event.pointerId);
  });

  els.viewerImage.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    state.panX = event.clientX - state.pointer.x;
    state.panY = event.clientY - state.pointer.y;
    applyTransform();
  });

  els.viewerImage.addEventListener("pointerup", (event) => {
    if (state.dragging) {
      state.dragging = false;
      return;
    }
    const dx = event.clientX - swipe.x;
    if (Math.abs(dx) > 60 && Date.now() - swipe.t < 600) next(dx < 0 ? 1 : -1);
  });

  ["dragenter", "dragover"].forEach((type) => {
    window.addEventListener(type, (event) => {
      event.preventDefault();
      els.app.classList.add("is-drag");
      els.opener.classList.add("is-drag");
    });
  });
  window.addEventListener("dragleave", (event) => {
    if (event.relatedTarget) return;
    els.app.classList.remove("is-drag");
    els.opener.classList.remove("is-drag");
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    els.app.classList.remove("is-drag");
    els.opener.classList.remove("is-drag");
    ingestDataTransfer(event.dataTransfer);
  });

  window.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", onHash);
  window.addEventListener("aperture-native-catalog", async () => {
    const loaded = await loadFromApi();
    if (!loaded) {
      paintCacheCard(await loadMergedSession());
      showOpener();
    }
  });
  onHash();
}

function apertureHandleBack() {
  if (!els.help.hidden) {
    els.help.hidden = true;
    return true;
  }
  if (state.open) {
    closeViewer();
    return true;
  }
  if (!els.opener.hidden && state.photos.length) {
    hideOpener();
    return true;
  }
  return false;
}

window.apertureHandleBack = apertureHandleBack;

wire();
