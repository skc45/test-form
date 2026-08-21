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
  recents: [],
  selectedIds: [],
  postPhoto: null,
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
  recentTabs: document.getElementById("recentTabs"),
  topbar: document.getElementById("topbar"),
  catalogHint: document.getElementById("catalogHint"),
  downloadBar: document.getElementById("downloadBar"),
  downloadCopy: document.getElementById("downloadCopy"),
  downloadFill: document.getElementById("downloadFill"),
  postForm: document.getElementById("postForm"),
  postCard: document.getElementById("postCard"),
  postPreview: document.getElementById("postPreview"),
  postCaption: document.getElementById("postCaption"),
  postStatus: document.getElementById("postStatus"),
  postTrack: document.getElementById("postTrack"),
  postFill: document.getElementById("postFill"),
  postSend: document.getElementById("postSend"),
  app: document.getElementById("app"),
  brandKicker: document.querySelector(".brand-kicker"),
};

let slideTimer = 0;
let chromeTimer = 0;
let downloadTimer = 0;
let downloadBusy = false;
let postBusy = false;
let longPress = { timer: 0, fired: false, x: 0, y: 0 };
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

function currentRecentId() {
  return cache.recentId({
    id: state.folderPath || state.folderName,
    path: state.folderPath,
    name: state.folderName,
  });
}

function isSelectedRecent(item) {
  return state.selectedIds[0] === item.id;
}

function recentPlateMarkup(item, index, className) {
  const cover = plateCover(item, index);
  const count = item.photoCount
    ? `${item.photoCount} plate${item.photoCount === 1 ? "" : "s"}`
    : "Folder";
  const selected = isSelectedRecent(item);
  const selectedClass = selected ? " is-selected" : "";
  return `
      <button class="${className}${selectedClass}" type="button" role="tab" data-recent="${index}" data-id="${escapeHtml(item.id)}" aria-selected="${selected}" aria-pressed="${selected}" title="${escapeHtml(item.name)} · ${escapeHtml(count)}">
        ${cover ? `<img alt="" src="${escapeHtml(cover)}" />` : `<span class="recent-plate-fill"></span>`}
        <span class="recent-plate-index">${plateNumber(index)}</span>
        <span class="recent-plate-meta"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(count)}</span></span>
      </button>`;
}

function bindRecentPlateMedia(root) {
  [...root.querySelectorAll("[data-recent] img")].forEach((img) => {
    if (img.complete && img.naturalWidth) img.classList.add("is-ready");
    img.addEventListener("load", () => img.classList.add("is-ready"), { once: true });
    img.addEventListener("error", () => img.classList.add("is-missing"), { once: true });
  });
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

function ensureSelectedRecents() {
  const valid = state.selectedIds.filter((id) => state.recents.some((item) => item.id === id));
  state.selectedIds = valid.slice(0, 1);
  if (state.selectedIds.length || state.source !== "folder") return;
  const current = currentRecentId();
  const match = state.recents.find((item) => item.id === current || item.path === state.folderPath || item.name === state.folderName);
  if (match) state.selectedIds = [match.id];
}

function renderRecentRow() {
  const row = els.recentRow;
  if (!row) return;
  if (!state.recents.length) {
    row.innerHTML = "";
    return;
  }
  row.innerHTML = state.recents.map((item, index) => recentPlateMarkup(item, index, "recent-plate")).join("");
  bindRecentPlateMedia(row);
}

function renderRecentTabs() {
  const layer = els.recentTabs;
  if (!layer) return;
  ensureSelectedRecents();
  if (!state.recents.length) {
    layer.hidden = true;
    layer.innerHTML = "";
    els.topbar?.classList.remove("has-recent-tabs");
    return;
  }
  layer.hidden = false;
  els.topbar?.classList.toggle("has-recent-tabs", true);
  layer.innerHTML = `
    <p class="recent-tabs-kicker">Recent folders</p>
    <div class="recent-tab-track" role="tablist" aria-label="Recent folders">
      ${state.recents.map((item, index) => recentPlateMarkup(item, index, "header-plate recent-tab")).join("")}
    </div>`;
  bindRecentPlateMedia(layer);
}

function renderRecentSelection() {
  renderRecentTabs();
  renderRecentRow();
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
  els.heroBtn.onclick = () => {
    if (longPressConsumed()) return;
    openViewer(featured.id);
  };
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
    card.addEventListener("click", () => {
      if (longPressConsumed()) return;
      openViewer(photo.id);
    });
    attachLongPress(card, () => openPostForm(photo));
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
    thumb.addEventListener("click", () => {
      if (longPressConsumed()) return;
      showIndex(i);
    });
    attachLongPress(thumb, () => openPostForm(photos[i]));
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
  resetDownloadBar();
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
  renderRecentTabs();
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
    if (state.folderHandle) {
      cache.saveFolderHandle(state.folderHandle, entry);
    }
    if (entry.id) state.selectedIds = [entry.id];
    cache.saveSession({
      source: "folder",
      folderName: state.folderName,
      folderPath: state.folderPath,
      photoCount: state.photos.length,
      layout: state.layout,
      filter: state.filter,
      openedAt: new Date().toISOString(),
      selectedIds: state.selectedIds,
      recents,
    });
    cache.saveCatalogIndex(state.photos);
    paintCacheCard({ ...session, recents, folderName: state.folderName, folderPath: state.folderPath, source: "folder", selectedIds: state.selectedIds });
    return;
  }
  if (hint) {
    hint.innerHTML = "Open a folder · click a plate · long-press to send · <kbd>O</kbd> folder · <kbd>?</kbd> shortcuts";
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
  state.selectedIds = [handle.name];
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
  const nextId = id || state.recents[index]?.id;
  if (!nextId) return;
  const already = state.source === "folder" && state.selectedIds[0] === nextId;
  state.selectedIds = [nextId];
  renderRecentSelection();
  if (already) return;
  await loadSelectedRecents();
}

function selectedRecentItems() {
  const id = state.selectedIds[0];
  const match = id ? state.recents.find((item) => item.id === id) : null;
  return match ? [match] : [];
}

function selectedLabel(items) {
  if (items.length === 1) return items[0].name;
  return items.map((item) => item.name).join(" + ");
}

async function loadSelectedRecents() {
  const items = selectedRecentItems();
  if (!items.length) return;
  const indices = items.map((item) => state.recents.findIndex((entry) => entry.id === item.id));

  if (window.ApertureAndroid?.openRecents) {
    window.ApertureAndroid.openRecents(JSON.stringify(indices));
    return;
  }
  if (items.length === 1 && window.ApertureAndroid?.openRecent) {
    window.ApertureAndroid.openRecent(indices[0]);
    return;
  }

  const handles = await cache.loadRecentHandles();
  const loaded = [];
  for (const item of items) {
    const handle = handles[item.id];
    if (!handle) continue;
    const permission = await cache.requestHandlePermission(handle);
    if (permission === "granted") loaded.push({ item, handle });
  }
  if (loaded.length === items.length && loaded.length) {
    revokeBlobs();
    const photos = [];
    for (const { handle } of loaded) {
      await walkDirectoryHandle(handle, photos, handle.name);
    }
    if (photos.length) photos[0].featured = true;
    state.folderHandle = loaded[0].handle;
    setCatalog(photos, {
      folderName: selectedLabel(loaded.map((entry) => entry.item)),
      folderPath: loaded[0].item.path || loaded[0].handle.name,
      source: "folder",
      handle: loaded[0].handle,
    });
    return;
  }

  const paths = items.map((item) => item.path).filter(Boolean);
  if (paths.length) {
    try {
      const response = await fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(paths.length === 1 ? { path: paths[0] } : { paths }),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.photos) && data.photos.length) {
          setCatalog(data.photos, {
            folderName: data.folder || selectedLabel(items),
            folderPath: data.path || paths[0],
            source: "folder",
          });
          return;
        }
      }
    } catch {
      /* static hosts have no open API */
    }
  }
  if (items.length === 1) await openFolderPicker();
}

function paintCacheCard(session) {
  const recents = cache.recentsFromSession(session);
  state.recents = recents;
  if (Array.isArray(session?.selectedIds) && session.selectedIds.length && !state.selectedIds.length) {
    state.selectedIds = session.selectedIds.slice(0, 1);
  }
  els.cacheCard.hidden = recents.length === 0;
  if (!recents.length) {
    document.getElementById("openerFolderBtn").classList.add("opener-primary");
    state.selectedIds = [];
    renderFilters();
    renderRecentSelection();
    return;
  }
  document.getElementById("openerFolderBtn").classList.remove("opener-primary");
  renderFilters();
  renderRecentSelection();
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
  state.selectedIds = [];
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
        selectedIds: (session.selectedIds || disk.selectedIds || []).slice(0, 1),
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
  state.selectedIds = [];
  setCatalog(DEMO_PHOTOS.map((photo) => ({ ...photo })), { source: "demo" });
}

async function loadFromApi() {
  try {
    const response = await fetch("/api/catalog", { headers: { Accept: "application/json" } });
    if (!response.ok) return false;
    const data = await response.json();
    if (!data || !Array.isArray(data.photos)) return false;
    if (!data.photos.length) return false;
    const paths = Array.isArray(data.paths) ? data.paths.filter(Boolean) : data.path ? [data.path] : [];
    if (paths.length) state.selectedIds = [paths[0]];
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
  if (els.postForm && !els.postForm.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePostForm();
    }
    return;
  }
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
  if (event.key === "d" || event.key === "D") {
    event.preventDefault();
    downloadCurrent();
    return;
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

function downloadFilename(photo) {
  const base = slug(photo.title || photo.id || "plate");
  const src = String(photo.src || "");
  const match = src.split("?")[0].match(/\.(jpe?g|png|gif|webp|bmp|tiff?|avif|svg)$/i);
  return `${base}${match ? match[0].toLowerCase() : ".jpg"}`;
}

function resetDownloadBar() {
  window.clearTimeout(downloadTimer);
  downloadBusy = false;
  els.downloadBar?.classList.remove("is-busy", "is-done", "is-error");
  els.downloadBar?.removeAttribute("disabled");
  if (els.downloadFill) els.downloadFill.style.width = "0%";
  if (els.downloadCopy) els.downloadCopy.textContent = "Tap to download";
}

function setDownloadProgress(pct, label) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  els.downloadBar?.classList.toggle("is-busy", clamped > 0 && clamped < 100);
  els.downloadBar?.classList.toggle("is-done", clamped >= 100);
  els.downloadBar?.classList.remove("is-error");
  if (els.downloadFill) els.downloadFill.style.width = `${clamped}%`;
  if (els.downloadCopy) els.downloadCopy.textContent = label;
}

function finishDownload(ok, label) {
  downloadBusy = false;
  els.downloadBar?.removeAttribute("disabled");
  if (ok) {
    setDownloadProgress(100, label || "Saved");
  } else {
    els.downloadBar?.classList.remove("is-busy", "is-done");
    els.downloadBar?.classList.add("is-error");
    if (els.downloadFill) els.downloadFill.style.width = "100%";
    if (els.downloadCopy) els.downloadCopy.textContent = label || "Could not download";
  }
  downloadTimer = window.setTimeout(() => {
    if (!downloadBusy) resetDownloadBar();
  }, 1600);
}

async function fetchBlobWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("fetch failed");
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !total) {
    onProgress(55);
    return response.blob();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.round((received / total) * 100));
  }
  return new Blob(chunks);
}

function blobFromViewer() {
  const img = els.viewerImage;
  if (!img?.naturalWidth) return Promise.reject(new Error("no image"));
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("no canvas"));
  ctx.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/jpeg", 0.92);
  });
}

function triggerSave(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1500);
}

function nativeDownload(src, filename) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("timeout")), 45000);
    window.apertureDownloadProgress = (pct) => {
      if (pct < 0) {
        window.clearTimeout(timer);
        reject(new Error("native download failed"));
        return;
      }
      setDownloadProgress(pct, pct >= 100 ? "Saved" : `Downloading… ${pct}%`);
      if (pct >= 100) {
        window.clearTimeout(timer);
        resolve();
      }
    };
    window.ApertureAndroid.download(src, filename);
  });
}

async function downloadCurrent() {
  if (!state.open || downloadBusy || longPressConsumed()) return;
  const photo = visiblePhotos()[state.activeIndex];
  if (!photo) return;
  downloadBusy = true;
  els.downloadBar?.setAttribute("disabled", "true");
  const filename = downloadFilename(photo);
  setDownloadProgress(6, "Downloading…");
  try {
    if (window.ApertureAndroid?.download) {
      await nativeDownload(photo.src, filename);
      finishDownload(true, "Saved");
      return;
    }
    let blob;
    try {
      blob = await fetchBlobWithProgress(photo.src, (pct) => {
        setDownloadProgress(Math.max(8, pct), `Downloading… ${pct}%`);
      });
    } catch {
      setDownloadProgress(70, "Downloading…");
      blob = await blobFromViewer();
    }
    triggerSave(blob, filename);
    finishDownload(true, "Saved");
  } catch {
    finishDownload(false, "Could not download");
  }
}

function longPressConsumed() {
  return Date.now() < (longPress.suppressUntil || 0);
}

function markLongPress() {
  longPress.fired = true;
  longPress.suppressUntil = Date.now() + 700;
}

function attachLongPress(el, onLong) {
  if (!el) return;
  const start = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    longPress.fired = false;
    longPress.x = event.clientX;
    longPress.y = event.clientY;
    window.clearTimeout(longPress.timer);
    longPress.timer = window.setTimeout(() => {
      markLongPress();
      onLong();
    }, 480);
  };
  const move = (event) => {
    if (Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > 14) {
      window.clearTimeout(longPress.timer);
    }
  };
  const end = () => window.clearTimeout(longPress.timer);
  el.addEventListener("pointerdown", start);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("contextmenu", (event) => {
    if (longPressConsumed()) event.preventDefault();
  });
  el.addEventListener(
    "click",
    (event) => {
      if (!longPressConsumed()) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
}

function openPostForm(photo) {
  if (!photo || !els.postForm) return;
  window.clearTimeout(longPress.timer);
  state.postPhoto = photo;
  postBusy = false;
  const src = photo.hero || photo.src || photo.thumb;
  els.postPreview.src = src;
  els.postPreview.alt = photo.title || "Plate";
  els.postCaption.value = [photo.title, photo.location].filter(Boolean).join(" · ");
  els.postStatus.hidden = true;
  els.postTrack.hidden = true;
  els.postFill.style.width = "0%";
  els.postSend.disabled = false;
  els.postForm.hidden = false;
  els.postCaption.focus();
  els.postCaption.select();
}

function closePostForm() {
  if (!els.postForm) return;
  els.postForm.hidden = true;
  state.postPhoto = null;
  postBusy = false;
}

function setPostProgress(pct, label) {
  if (els.postTrack) els.postTrack.hidden = false;
  if (els.postFill) els.postFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (label && els.postStatus) {
    els.postStatus.hidden = false;
    els.postStatus.textContent = label;
  }
}

async function plateBlob(photo, onProgress) {
  try {
    return await fetchBlobWithProgress(photo.src, onProgress);
  } catch {
    if (state.open && visiblePhotos()[state.activeIndex]?.id === photo.id) {
      onProgress(75);
      return blobFromViewer();
    }
    throw new Error("no blob");
  }
}

function nativeShare(src, filename, caption) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("timeout")), 45000);
    window.aperturePostProgress = (pct) => {
      if (pct < 0) {
        window.clearTimeout(timer);
        reject(new Error("share failed"));
        return;
      }
      setPostProgress(pct, pct >= 100 ? "Opening send…" : `Preparing… ${pct}%`);
      if (pct >= 100) {
        window.clearTimeout(timer);
        resolve();
      }
    };
    window.ApertureAndroid.share(src, filename, caption);
  });
}

function postViaShareApi(file, caption, title) {
  if (!navigator.share) return Promise.reject(new Error("no share"));
  const payload = { title, text: caption };
  if (navigator.canShare?.({ files: [file] })) payload.files = [file];
  return navigator.share(payload);
}

function postViaHttp(file, caption, title, onProgress) {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("title", title);
    body.append("caption", caption);
    body.append("plate", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/post");
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText || "{}"));
        } catch {
          resolve({ ok: true });
        }
        return;
      }
      reject(new Error("post failed"));
    };
    xhr.onerror = () => reject(new Error("post failed"));
    xhr.send(body);
  });
}

async function sendPost(event) {
  event?.preventDefault();
  const photo = state.postPhoto;
  if (!photo || postBusy) return;
  postBusy = true;
  els.postSend.disabled = true;
  const caption = els.postCaption.value.trim();
  const filename = downloadFilename(photo);
  setPostProgress(6, "Preparing plate…");
  try {
    if (window.ApertureAndroid?.share) {
      await nativeShare(photo.src, filename, caption);
      setPostProgress(100, "Sent");
      window.setTimeout(closePostForm, 500);
      return;
    }
    const blob = await plateBlob(photo, (pct) => setPostProgress(Math.max(8, pct), "Preparing plate…"));
    const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
    try {
      const result = await postViaHttp(file, caption, photo.title || filename, (pct) => {
        setPostProgress(Math.max(12, pct), `Sending… ${pct}%`);
      });
      if (result?.ok !== false) {
        setPostProgress(100, "Sent");
        window.setTimeout(closePostForm, 700);
        return;
      }
    } catch {
      /* fall through to share sheet */
    }
    await postViaShareApi(file, caption, photo.title || "Aperture");
    setPostProgress(100, "Sent");
    window.setTimeout(closePostForm, 400);
  } catch {
    postBusy = false;
    els.postSend.disabled = false;
    setPostProgress(0, "Could not send");
    if (els.postTrack) els.postTrack.hidden = true;
  }
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
  }
  paintCacheCard(await loadMergedSession());
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
  els.recentRow?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-recent]");
    if (!btn) return;
    openRecent(Number(btn.dataset.recent), btn.dataset.id);
  });
  els.recentTabs?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-recent]");
    if (!btn) return;
    openRecent(Number(btn.dataset.recent), btn.dataset.id);
  });
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
  document.getElementById("downloadBtn").addEventListener("click", downloadCurrent);
  els.downloadBar?.addEventListener("click", downloadCurrent);
  attachLongPress(els.downloadBar, () => {
    const photo = visiblePhotos()[state.activeIndex];
    if (photo) openPostForm(photo);
  });
  attachLongPress(els.heroBtn, () => {
    const featured = state.photos.find((p) => p.featured) || state.photos[0];
    if (featured) openPostForm(featured);
  });
  els.postCard?.addEventListener("submit", sendPost);
  document.getElementById("postCancel")?.addEventListener("click", closePostForm);
  els.postForm?.addEventListener("click", (event) => {
    if (event.target === els.postForm) closePostForm();
  });
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
    longPress.fired = false;
    longPress.x = event.clientX;
    longPress.y = event.clientY;
    window.clearTimeout(longPress.timer);
    longPress.timer = window.setTimeout(() => {
      const photo = visiblePhotos()[state.activeIndex];
      if (!photo) return;
      markLongPress();
      openPostForm(photo);
    }, 480);
    if (state.zoom === 1) {
      swipe = { x: event.clientX, t: Date.now() };
      return;
    }
    state.dragging = true;
    state.pointer = { x: event.clientX - state.panX, y: event.clientY - state.panY };
    els.viewerImage.setPointerCapture(event.pointerId);
  });

  els.viewerImage.addEventListener("pointermove", (event) => {
    if (Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > 14) {
      window.clearTimeout(longPress.timer);
    }
    if (!state.dragging) return;
    state.panX = event.clientX - state.pointer.x;
    state.panY = event.clientY - state.pointer.y;
    applyTransform();
  });

  els.viewerImage.addEventListener("pointerup", (event) => {
    window.clearTimeout(longPress.timer);
    if (longPressConsumed()) {
      state.dragging = false;
      return;
    }
    if (state.dragging) {
      state.dragging = false;
      return;
    }
    const dx = event.clientX - swipe.x;
    if (Math.abs(dx) > 60 && Date.now() - swipe.t < 600) next(dx < 0 ? 1 : -1);
  });
  els.viewerImage.addEventListener("pointercancel", () => window.clearTimeout(longPress.timer));
  els.viewerImage.addEventListener("contextmenu", (event) => event.preventDefault());

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
  if (els.postForm && !els.postForm.hidden) {
    closePostForm();
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
