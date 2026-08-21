import { CATEGORIES as DEMO_CATEGORIES, PHOTOS as DEMO_PHOTOS, fallbackSrc, plateNumber } from "./catalog.js";
import * as cache from "./data.js";
import * as chain from "./chain.js";

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
  vaultHandle: null,
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
  chainLedger: document.getElementById("chainLedger"),
  chainList: document.getElementById("chainList"),
  chainFiles: document.getElementById("chainFiles"),
  chainStatus: document.getElementById("chainStatus"),
  chainVaultStatus: document.getElementById("chainVaultStatus"),
  chainBtn: document.getElementById("chainBtn"),
  chainUnlock: document.getElementById("chainUnlock"),
  vaultInput: document.getElementById("vaultInput"),
  vaultFolderInput: document.getElementById("vaultFolderInput"),
  app: document.getElementById("app"),
  brandKicker: document.querySelector(".brand-kicker"),
};

let slideTimer = 0;
let chromeTimer = 0;
let downloadTimer = 0;
let recentSlideTimer = 0;
let downloadBusy = false;
let postBusy = false;
let chainMonitorTimer = 0;
let encodeTimer = 0;
let encodeGeneration = 0;
const localVault = [];
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
  return state.selectedIds.includes(item.id);
}

function uniquePhotoSrcs(photos) {
  const srcs = [];
  const seen = new Set();
  for (const photo of photos || []) {
    const src = photo.thumb || photo.src || photo.hero || "";
    if (!src || seen.has(src)) continue;
    seen.add(src);
    srcs.push(src);
    if (srcs.length === cache.MAX_RECENT_SLIDES) break;
  }
  return srcs;
}

function slidesFromCatalog(item) {
  if (state.source !== "folder" || !state.photos.length) return [];
  const selected = selectedRecentItems();
  if (selected.length > 1) {
    const mergeIndex = selected.findIndex((entry) => entry.id === item.id);
    if (mergeIndex < 0) return [];
    const prefix = `${mergeIndex}/`;
    return uniquePhotoSrcs(state.photos.filter((photo) => String(photo.id).startsWith(prefix)));
  }
  const current = selected[0];
  const isCurrent =
    (current && current.id === item.id) ||
    item.id === currentRecentId() ||
    (state.folderPath && item.path === state.folderPath) ||
    (state.folderName && item.name === state.folderName && !item.path);
  if (!isCurrent) return [];
  return uniquePhotoSrcs(state.photos);
}

function plateSlides(item, index) {
  const fromCatalog = slidesFromCatalog(item);
  if (fromCatalog.length > 1) return fromCatalog;
  const stored = Array.isArray(item.covers)
    ? item.covers.filter((src) => src && !String(src).startsWith("blob:"))
    : [];
  if (stored.length > 1) return stored.slice(0, cache.MAX_RECENT_SLIDES);
  if (fromCatalog.length) return fromCatalog;
  if (stored.length) return stored;
  const path = item.path || "";
  const api =
    Boolean(window.ApertureAndroid) ||
    path.startsWith("/") ||
    path.includes(":\\") ||
    path.startsWith("content:") ||
    path.startsWith("file:");
  if (api) {
    const n = Math.min(cache.MAX_RECENT_SLIDES, Math.max(Number(item.photoCount) || cache.MAX_RECENT_SLIDES, 1));
    return Array.from({ length: n }, (_, plate) => `/api/recent-cover?i=${index}&p=${plate}`);
  }
  const cover = plateCover(item, index);
  return cover ? [cover] : [];
}

function recentPlateMarkup(item, index, className) {
  const slides = plateSlides(item, index);
  const count = item.photoCount
    ? `${item.photoCount} plate${item.photoCount === 1 ? "" : "s"}`
    : "Folder";
  const selected = isSelectedRecent(item);
  const selectedClass = selected ? " is-selected" : "";
  const media = slides.length
    ? `<span class="recent-slideshow">${slides
        .map((src, plate) => `<img alt="" src="${escapeHtml(src)}"${plate === 0 ? ' class="is-active"' : ""} />`)
        .join("")}</span>`
    : `<span class="recent-plate-fill"></span>`;
  return `
      <button class="${className}${selectedClass}" type="button" role="tab" data-recent="${index}" data-id="${escapeHtml(item.id)}" aria-selected="${selected}" aria-pressed="${selected}" title="${escapeHtml(item.name)} · ${escapeHtml(count)}">
        ${media}
        <span class="recent-plate-index">${plateNumber(index)}</span>
        <span class="recent-plate-meta"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(count)}</span></span>
      </button>`;
}

function bindRecentPlateMedia(root) {
  [...root.querySelectorAll("[data-recent] img")].forEach((img) => {
    const onReady = () => {
      img.classList.add("is-ready");
      const plate = img.closest("[data-recent]");
      if (plate && !plate.querySelector(".recent-slideshow img.is-active.is-ready")) {
        plate.querySelectorAll(".recent-slideshow img.is-active").forEach((other) => other.classList.remove("is-active"));
        img.classList.add("is-active");
      }
    };
    if (img.complete && img.naturalWidth) onReady();
    else img.addEventListener("load", onReady, { once: true });
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
  state.selectedIds = valid;
  if (state.selectedIds.length || state.source !== "folder") return;
  const current = currentRecentId();
  const match = state.recents.find((item) => item.id === current || item.path === state.folderPath || item.name === state.folderName);
  if (match) state.selectedIds = [match.id];
}

function recentSlidePlates() {
  return [
    ...(els.recentRow?.querySelectorAll("[data-recent]") || []),
    ...(els.recentTabs?.querySelectorAll("[data-recent]") || []),
  ];
}

function stopRecentSlideshow() {
  window.clearInterval(recentSlideTimer);
  recentSlideTimer = 0;
}

function readySlides(plate) {
  return [...plate.querySelectorAll(".recent-slideshow img")].filter(
    (img) => img.classList.contains("is-ready") && !img.classList.contains("is-missing")
  );
}

function startRecentSlideshow() {
  stopRecentSlideshow();
  if (!recentSlidePlates().length) return;
  recentSlideTimer = window.setInterval(() => {
    const plates = recentSlidePlates();
    if (!plates.length) {
      stopRecentSlideshow();
      return;
    }
    plates.forEach((plate) => {
      const slides = readySlides(plate);
      if (slides.length < 2) return;
      const current = slides.findIndex((img) => img.classList.contains("is-active"));
      const next = ((current < 0 ? 0 : current) + 1) % slides.length;
      slides.forEach((img, i) => img.classList.toggle("is-active", i === next));
    });
  }, 1800);
}

function renderRecentRow() {
  const row = els.recentRow;
  if (!row) return;
  if (!state.recents.length) {
    row.innerHTML = "";
    stopRecentSlideshow();
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
    els.topbar?.classList.remove("has-recent-tabs", "is-together");
    return;
  }
  const together = state.selectedIds.length > 1;
  layer.hidden = false;
  layer.classList.toggle("is-together", together);
  els.topbar?.classList.toggle("has-recent-tabs", true);
  els.topbar?.classList.toggle("is-together", together);
  layer.innerHTML = `
    <p class="recent-tabs-kicker">${together ? "Selected together" : "Recent folders"}</p>
    <div class="recent-tab-track" role="tablist" aria-label="Recent folders" aria-multiselectable="true">
      ${state.recents.map((item, index) => recentPlateMarkup(item, index, "header-plate recent-tab")).join("")}
    </div>`;
  bindRecentPlateMedia(layer);
}

function renderRecentSelection() {
  renderRecentTabs();
  renderRecentRow();
  startRecentSlideshow();
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
  renderRecentSelection();
  persistCatalog();
  if (source === "folder") queueAutoEncode();
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
    const combined = state.selectedIds.length > 1;
    let recents = cache.normalizeRecents(session.recents);
    if (!combined) {
      const covers = coversFromPhotos(state.photos);
      const entry = {
        id: state.folderPath || state.folderName,
        name: state.folderName,
        path: state.folderPath,
        photoCount: state.photos.length,
        openedAt: new Date().toISOString(),
        cover: covers[0] || "",
        covers,
      };
      recents = cache.upsertRecent(session.recents, entry);
      if (state.folderHandle) {
        cache.saveFolderHandle(state.folderHandle, entry);
      }
      if (entry.id && state.selectedIds.length <= 1) state.selectedIds = [entry.id];
    }
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
    state.recents = recents;
    if (els.cacheCard) els.cacheCard.hidden = recents.length === 0;
    const rendered = [...(els.recentTabs?.querySelectorAll("[data-recent]") || [])].map((el) => el.dataset.id);
    const nextIds = recents.map((item) => item.id);
    if (rendered.join("\0") !== nextIds.join("\0")) renderRecentSelection();
    return;
  }
  if (state.source === "blockchain") {
    if (hint) {
      hint.innerHTML = `Unlocked vault · ${escapeHtml(state.folderName || "blockchain")} · <kbd>B</kbd> monitor`;
    }
    return;
  }
  if (hint) {
    hint.innerHTML = "Open a folder · click a plate · long-press to send · <kbd>O</kbd> folder · <kbd>?</kbd> shortcuts";
  }
}

function coversFromPhotos(photos) {
  return uniquePhotoSrcs(photos).filter((src) => !src.startsWith("blob:"));
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
      if (name.toLowerCase() === "blockchain") continue;
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
  if (entry.isDirectory && entry.name.toLowerCase() === "blockchain") return;
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
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      await openDirectoryHandle(dir);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  els.folderInput.click();
}

async function openRecent(index, id, { exclusive = false } = {}) {
  const nextId = id || state.recents[index]?.id;
  if (!nextId) return;
  const before = state.selectedIds.join("\0");
  toggleRecentSelection(nextId, { exclusive });
  renderRecentSelection();
  if (before === state.selectedIds.join("\0") && state.source === "folder") return;
  await loadSelectedRecents();
}

function toggleRecentSelection(id, { exclusive = false } = {}) {
  if (!id) return;
  if (exclusive) {
    state.selectedIds = [id];
    return;
  }
  if (state.selectedIds.includes(id)) {
    if (state.selectedIds.length > 1) {
      state.selectedIds = state.selectedIds.filter((item) => item !== id);
    }
    return;
  }
  state.selectedIds = [...state.selectedIds, id];
}

function selectedRecentItems() {
  return state.recents.filter((item) => state.selectedIds.includes(item.id));
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
    state.selectedIds = session.selectedIds;
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
        selectedIds: session.selectedIds || disk.selectedIds || [],
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
  startRecentSlideshow();
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
    if (paths.length) state.selectedIds = paths;
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
  if (els.chainLedger && !els.chainLedger.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeChainLedger();
    }
    return;
  }
  if (event.key === "b" || event.key === "B") {
    if (event.target.matches("input, textarea")) return;
    event.preventDefault();
    if (els.chainLedger?.hidden === false) closeChainLedger();
    else openChainLedger();
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

async function hashBytes(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadChainBlocks() {
  try {
    const response = await fetch("/api/chain", { headers: { Accept: "application/json" } });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.blocks) && data.blocks.length) return data.blocks;
    }
  } catch {
    /* static hosts have no chain API */
  }
  try {
    const raw = localStorage.getItem(chain.CHAIN_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.blocks) && data.blocks.length) return data.blocks;
    }
  } catch {
    /* ignore broken cache */
  }
  return [await chain.genesisBlock()];
}

function cacheChainBlocks(blocks) {
  try {
    localStorage.setItem(chain.CHAIN_KEY, JSON.stringify({ blocks }));
  } catch {
    /* quota */
  }
}

function photoFromUnlocked(name, header, bytes) {
  const mime = header.mime || "image/jpeg";
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  state.blobUrls.push(url);
  return {
    id: `vault-${name}`,
    title: header.title || String(header.file || name).replace(/\.[^.]+$/, ""),
    photographer: "Aperture chain",
    location: header.caption || "Unlocked plate",
    year: new Date().getFullYear(),
    category: "blockchain",
    src: url,
    thumb: url,
    hero: url,
    local: true,
    height: Number(header.height || 0),
  };
}

async function listingFromPacked(items, blocks) {
  const files = [];
  for (const item of items) {
    const parsed = chain.parseEnvelope(item.bytes);
    const header = parsed?.header || { file: item.name, title: item.name.replace(/\.[^.]+$/, "") };
    const unlocked = await chain.unlockBytes(item.bytes, blocks);
    files.push({
      name: item.name,
      height: Number(header.height || 0),
      title: header.title || String(header.file || item.name).replace(/\.[^.]+$/, ""),
      caption: header.caption || "",
      file: header.file || item.name,
      unlocked: Boolean(unlocked),
      src: "",
      error: unlocked ? "" : parsed ? "locked" : "undecodable",
      header: unlocked?.header || header,
      bytes: unlocked?.bytes || null,
    });
  }
  return { files, photos: [] };
}

async function fetchVault() {
  const blocks = await loadChainBlocks();
  const valid = await chain.verifyChain(blocks);
  try {
    const response = await fetch("/api/vault", { headers: { Accept: "application/json" } });
    if (response.ok) {
      const data = await response.json();
      if (data && data.ok !== false) {
        return {
          ...data,
          valid: data.valid !== false && valid,
          blocks: Array.isArray(data.blocks) && data.blocks.length ? data.blocks : blocks,
        };
      }
    }
  } catch {
    /* static hosts have no vault API */
  }
  const local = await listingFromPacked(localVault, blocks);
  return {
    ok: true,
    valid,
    folder: "blockchain",
    path: "",
    height: Number(blocks[blocks.length - 1]?.height || 0),
    files: local.files,
    photos: local.photos,
    blocks,
  };
}

function rememberLocalVault(name, bytes) {
  const packed = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const index = localVault.findIndex((item) => item.name === name);
  if (index >= 0) localVault[index] = { name, bytes: packed };
  else localVault.push({ name, bytes: packed });
}

function queueAutoEncode() {
  window.clearTimeout(encodeTimer);
  encodeTimer = window.setTimeout(() => void autoEncodeFolder(), 60);
}

function setEncodeHint(label) {
  if (!els.catalogHint || state.source !== "folder") return;
  els.catalogHint.innerHTML = `${label} · ${escapeHtml(state.folderName)} · <kbd>B</kbd> monitor`;
}

async function writeFolderApc(name, packed) {
  const root = state.folderHandle;
  if (!root?.getDirectoryHandle) return;
  try {
    const dir = await root.getDirectoryHandle("blockchain", { create: true });
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(packed);
    await writable.close();
  } catch {
    /* read-only folder */
  }
}

async function autoEncodeFolder() {
  if (state.source !== "folder" || !state.photos.length) return;
  const generation = ++encodeGeneration;
  setEncodeHint("Auto-encoding folder");
  if (window.ApertureAndroid?.encodeFolder) {
    try {
      const data = JSON.parse(window.ApertureAndroid.encodeFolder() || "{}");
      if (generation !== encodeGeneration) return;
      applyEncodeResult(data);
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    const response = await fetch("/api/vault/encode", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        path: state.folderPath,
        paths: state.folderPath ? [state.folderPath] : [],
      }),
    });
    if (response.ok) {
      const data = await response.json();
      if (generation !== encodeGeneration) return;
      applyEncodeResult(data);
      return;
    }
  } catch {
    /* encode in the browser */
  }
  await encodeCatalogLocally(generation);
}

function applyEncodeResult(data) {
  const encoded = Number(data?.encoded || 0);
  const skipped = Number(data?.skipped || 0);
  const total = encoded + skipped;
  if (Array.isArray(data?.blocks) && data.blocks.length) cacheChainBlocks(data.blocks);
  setEncodeHint(
    encoded
      ? `Encoded ${encoded} plate${encoded === 1 ? "" : "s"}`
      : total
        ? "Folder already on chain"
        : "No plates to encode",
  );
  if (!els.chainLedger?.hidden) void renderChainMonitor(data);
}

async function encodeCatalogLocally(generation) {
  const blocks = await loadChainBlocks();
  const seen = new Set(blocks.map((block) => String(block.imageHash || "")).filter(Boolean));
  let encoded = 0;
  let skipped = 0;
  const folderName = state.folderName || "Folder";
  for (const photo of state.photos) {
    if (generation !== encodeGeneration) return;
    const src = String(photo.src || "");
    if (!photo.local && !src.startsWith("blob:") && !src.startsWith("/media/")) {
      skipped += 1;
      continue;
    }
    let blob;
    try {
      blob = await fetch(src).then((response) => {
        if (!response.ok) throw new Error("fetch");
        return response.blob();
      });
    } catch {
      skipped += 1;
      continue;
    }
    if (!blob.size || blob.size > 25 * 1024 * 1024) {
      skipped += 1;
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const imageHash = await chain.sha256HexBytes(bytes);
    if (seen.has(imageHash)) {
      skipped += 1;
      continue;
    }
    const filename = downloadFilename(photo);
    const prev = blocks[blocks.length - 1];
    const block = await chain.mineBlock({
      height: Number(prev?.height || 0) + 1,
      timestamp: new Date().toISOString().slice(0, 19),
      title: photo.title || filename,
      caption: folderName,
      file: filename,
      imageHash,
      prevHash: prev?.hash || chain.GENESIS_PREV,
      nonce: 0,
    });
    blocks.push(block);
    cacheChainBlocks(blocks);
    const packed = await chain.lockBytes(bytes, block, {
      file: filename,
      title: photo.title || filename,
      caption: folderName,
      mime: blob.type || "application/octet-stream",
    });
    const name = chain.vaultName(block, filename);
    rememberLocalVault(name, packed);
    await writeFolderApc(name, packed);
    seen.add(imageHash);
    encoded += 1;
    setEncodeHint(`Encoding… ${encoded}`);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  applyEncodeResult({ encoded, skipped, blocks: await loadChainBlocks() });
}

async function lockPlateInVault(blob, filename, title, caption, block, src = "") {
  if (!block) return null;
  if (window.ApertureAndroid?.chainLock) {
    try {
      const data = JSON.parse(window.ApertureAndroid.chainLock(src, filename, JSON.stringify(block)) || "{}");
      return data.ok === false ? null : data;
    } catch {
      /* fall through */
    }
  }
  if (!blob) return null;
  try {
    const body = new FormData();
    body.append("title", title);
    body.append("caption", caption);
    body.append("plate", blob instanceof Blob ? blob : new Blob([blob]), filename);
    const response = await fetch("/api/vault/lock", { method: "POST", body });
    if (response.ok) return await response.json();
  } catch {
    /* encode locally */
  }
  const bytes = new Uint8Array(await (blob instanceof Blob ? blob.arrayBuffer() : blob));
  const packed = await chain.lockBytes(bytes, block, {
    file: filename,
    title,
    caption,
    mime: blob.type || "application/octet-stream",
  });
  rememberLocalVault(chain.vaultName(block, filename), packed);
  if (state.vaultHandle?.getFileHandle) {
    try {
      const fileHandle = await state.vaultHandle.getFileHandle(chain.vaultName(block, filename), { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(packed);
      await writable.close();
    } catch {
      /* read-only handle */
    }
  }
  return { ok: true, vault: chain.vaultName(block, filename) };
}

async function collectApcFromHandle(handle, prefix = "") {
  const files = [];
  for await (const [name, child] of handle.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.kind === "directory") {
      files.push(...(await collectApcFromHandle(child, rel)));
      continue;
    }
    const file = await child.getFile();
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (chain.isApcName(name) || (head[0] === 0x41 && head[1] === 0x50 && head[2] === 0x43 && head[3] === 0x48)) {
      files.push(file);
    }
  }
  return files;
}

async function unlockPackedFiles(fileList, folderName = "blockchain") {
  const blocks = await loadChainBlocks();
  const packed = [];
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!chain.parseEnvelope(bytes)) continue;
    const name = file.name || `plate-${packed.length + 1}.apc`;
    rememberLocalVault(name, bytes);
    packed.push({ name, bytes });
  }
  const listing = await listingFromPacked(packed, blocks);
  listing.folder = folderName;
  listing.valid = await chain.verifyChain(blocks);
  listing.blocks = blocks;
  listing.photos = [];
  return listing;
}

function photosFromListing(listing) {
  const ready = (listing.photos || []).filter((photo) => photo?.src);
  if (ready.length) return ready;
  return (listing.files || [])
    .filter((item) => item.unlocked && item.bytes)
    .map((item) => photoFromUnlocked(item.name, item.header, item.bytes));
}

function openUnlockedCatalog(listing) {
  const existing = (listing.photos || []).filter((photo) => photo?.src);
  revokeBlobs();
  const photos = (existing.length ? existing : photosFromListing({ ...listing, photos: [] })).map((photo, index) => ({
    ...photo,
    featured: index === 0,
  }));
  if (!photos.length) return false;
  setCatalog(photos, {
    folderName: listing.folder || "blockchain",
    folderPath: listing.path || "",
    source: "blockchain",
    handle: state.vaultHandle,
  });
  return true;
}

async function renderChainMonitor(listing) {
  if (!els.chainList) return;
  const data = listing || (await fetchVault());
  const blocks = Array.isArray(data.blocks) && data.blocks.length ? data.blocks : await loadChainBlocks();
  const valid = data.valid !== false && (await chain.verifyChain(blocks));
  const tip = blocks[blocks.length - 1];
  if (els.chainStatus) {
    els.chainStatus.textContent = valid
      ? `Live · height ${Number(tip?.height || 0)} · ${blocks.length} block${blocks.length === 1 ? "" : "s"} · difficulty ${chain.DIFFICULTY}`
      : "Chain failed verification — plates stay locked";
  }
  const files = data.files || [];
  const unlocked = files.filter((item) => item.unlocked).length;
  if (els.chainVaultStatus) {
    if (!files.length) {
      els.chainVaultStatus.textContent = data.path
        ? `Vault · ${data.folder || "blockchain"} · empty`
        : "Unlock a blockchain folder to decode sealed plates.";
    } else {
      els.chainVaultStatus.textContent = `${unlocked} of ${files.length} plate${files.length === 1 ? "" : "s"} decoded${
        data.folder ? ` · ${data.folder}` : ""
      }`;
    }
  }
  els.chainList.innerHTML = blocks
    .slice()
    .reverse()
    .map(
      (block) => `
      <li class="chain-block${Number(block.height) === 0 ? " is-genesis" : ""}">
        <strong>${Number(block.height) === 0 ? "Genesis" : `Block ${block.height}`}${block.title ? ` · ${escapeHtml(block.title)}` : ""}</strong>
        <span>${escapeHtml(block.caption || "No caption")}</span>
        <span>${chain.shortHash(block.hash)} ← ${chain.shortHash(block.prevHash)}</span>
      </li>`
    )
    .join("");
  if (els.chainFiles) {
    els.chainFiles.hidden = files.length === 0;
    els.chainFiles.innerHTML = files
      .map(
        (item) => `
        <li class="chain-block${item.unlocked ? " is-unlocked" : " is-locked"}" data-vault="${escapeHtml(item.name)}" ${
          item.unlocked ? `data-open="${escapeHtml(item.src || item.photo?.id || "")}"` : ""
        }>
          <strong>${escapeHtml(item.title || item.file || item.name)}<span class="chain-flag">${
            item.unlocked ? "Unlocked" : "Locked"
          }</span></strong>
          <span>${escapeHtml(item.caption || item.file || item.name)}</span>
          <span>Block ${Number(item.height || 0)}</span>
        </li>`
      )
      .join("");
  }
}

async function openChainLedger() {
  if (!els.chainLedger) return;
  els.chainLedger.hidden = false;
  await renderChainMonitor();
  window.clearInterval(chainMonitorTimer);
  chainMonitorTimer = window.setInterval(() => {
    if (els.chainLedger?.hidden) {
      window.clearInterval(chainMonitorTimer);
      return;
    }
    renderChainMonitor();
  }, 2500);
}

function closeChainLedger() {
  if (!els.chainLedger) return;
  els.chainLedger.hidden = true;
  window.clearInterval(chainMonitorTimer);
}

async function unlockBlockchainFolder() {
  if (els.chainUnlock) els.chainUnlock.disabled = true;
  if (els.chainVaultStatus) els.chainVaultStatus.textContent = "Unlocking…";
  try {
    const existing = await fetchVault();
    if ((existing.files || []).length) {
      await renderChainMonitor(existing);
      if (openUnlockedCatalog(existing)) closeChainLedger();
      else if (els.chainVaultStatus) {
        els.chainVaultStatus.textContent = existing.valid
          ? "No decodable plates in the blockchain folder."
          : "Chain failed verification — plates stay locked";
      }
      return;
    }
    if (window.ApertureAndroid?.openBlockchainFolder) {
      window.ApertureAndroid.openBlockchainFolder();
      return;
    }
    if (window.showDirectoryPicker) {
      try {
        const dir = await window.showDirectoryPicker({ mode: "readwrite" });
        state.vaultHandle = dir;
        const files = await collectApcFromHandle(dir);
        const listing = await unlockPackedFiles(files, dir.name || "blockchain");
        listing.path = dir.name;
        await renderChainMonitor(listing);
        if (openUnlockedCatalog(listing)) closeChainLedger();
        else if (els.chainVaultStatus) {
          els.chainVaultStatus.textContent = listing.valid
            ? "No decodable plates in that folder."
            : "Chain failed verification — plates stay locked";
        }
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    els.vaultFolderInput?.click();
  } finally {
    if (els.chainUnlock) els.chainUnlock.disabled = false;
  }
}

async function openVaultFile(name, src) {
  if (src && state.source === "blockchain") {
    const match = state.photos.find((photo) => photo.id === src || photo.src === src || photo.id === `vault/${name}` || photo.id === `vault-${name}`);
    if (match) {
      closeChainLedger();
      openViewer(match.id);
      return;
    }
  }
  const listing = await fetchVault();
  await renderChainMonitor(listing);
  if (!openUnlockedCatalog(listing)) return;
  closeChainLedger();
  const id = `vault/${name}`;
  const localId = `vault-${name}`;
  const photo = state.photos.find((item) => item.id === id || item.id === localId || item.id === src);
  if (photo) openViewer(photo.id);
}

async function sealPostBlock(photo, caption, filename, blob) {
  setPostProgress(86, "Sealing block…");
  let imageHash = "";
  if (blob) {
    imageHash = await hashBytes(await blob.arrayBuffer());
  } else {
    imageHash = await chain.sha256Hex([photo.id, photo.src, filename, caption].join("|"));
  }
  const title = photo.title || filename;
  if (window.ApertureAndroid?.chainAppend) {
    try {
      const data = JSON.parse(window.ApertureAndroid.chainAppend(title, caption, filename, imageHash) || "{}");
      if (Array.isArray(data.blocks)) cacheChainBlocks(data.blocks);
      return data.block || null;
    } catch {
      /* fall through */
    }
  }
  try {
    const response = await fetch("/api/chain", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ title, caption, file: filename, imageHash }),
    });
    if (response.ok) {
      const data = await response.json();
      if (data.block) {
        if (Array.isArray(data.blocks)) cacheChainBlocks(data.blocks);
        return data.block;
      }
    }
  } catch {
    /* mine locally */
  }
  const blocks = await loadChainBlocks();
  const prev = blocks[blocks.length - 1];
  const block = await chain.mineBlock({
    height: Number(prev.height || 0) + 1,
    timestamp: new Date().toISOString().slice(0, 19),
    title,
    caption,
    file: filename,
    imageHash,
    prevHash: prev.hash,
    nonce: 0,
  });
  blocks.push(block);
  cacheChainBlocks(blocks);
  return block;
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
      const block = await sealPostBlock(photo, caption, filename, null);
      await lockPlateInVault(null, filename, photo.title || filename, caption, block, photo.src);
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
        if (result.block) cacheChainBlocks(await loadChainBlocks());
        else {
          const block = await sealPostBlock(photo, caption, filename, blob);
          await lockPlateInVault(blob, filename, photo.title || filename, caption, block, photo.src);
        }
        setPostProgress(100, "Sent");
        window.setTimeout(closePostForm, 700);
        return;
      }
    } catch {
      /* fall through to share sheet */
    }
    await postViaShareApi(file, caption, photo.title || "Aperture");
    const block = await sealPostBlock(photo, caption, filename, blob);
    await lockPlateInVault(blob, filename, photo.title || filename, caption, block, photo.src);
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
  const dropped = [...(transfer.files || [])];
  if (dropped.length && dropped.every((file) => chain.isApcName(file.name))) {
    const listing = await unlockPackedFiles(dropped, guessFolderName(dropped) || "blockchain");
    await renderChainMonitor(listing);
    if (openUnlockedCatalog(listing)) return;
  }
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
    openRecent(Number(btn.dataset.recent), btn.dataset.id, { exclusive: false });
  });
  els.recentTabs?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-recent]");
    if (!btn) return;
    openRecent(Number(btn.dataset.recent), btn.dataset.id, { exclusive: false });
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
  els.chainBtn?.addEventListener("click", openChainLedger);
  document.getElementById("chainClose")?.addEventListener("click", closeChainLedger);
  els.chainUnlock?.addEventListener("click", unlockBlockchainFolder);
  els.chainFiles?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-vault]");
    if (!row || row.classList.contains("is-locked")) return;
    openVaultFile(row.dataset.vault, row.dataset.open);
  });
  els.chainLedger?.addEventListener("click", (event) => {
    if (event.target === els.chainLedger) closeChainLedger();
  });
  els.vaultInput?.addEventListener("change", async () => {
    const files = [...(els.vaultInput.files || [])];
    els.vaultInput.value = "";
    if (!files.length) return;
    const listing = await unlockPackedFiles(files, "blockchain");
    await renderChainMonitor(listing);
    if (openUnlockedCatalog(listing)) closeChainLedger();
  });
  els.vaultFolderInput?.addEventListener("change", async () => {
    const files = [...(els.vaultFolderInput.files || [])];
    const folderName = guessFolderName(files) || "blockchain";
    els.vaultFolderInput.value = "";
    const listing = await unlockPackedFiles(files, folderName);
    await renderChainMonitor(listing);
    if (openUnlockedCatalog(listing)) closeChainLedger();
    else if (els.chainVaultStatus) {
      els.chainVaultStatus.textContent = listing.valid
        ? "No decodable plates in that folder."
        : "Chain failed verification — plates stay locked";
    }
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
  window.addEventListener("aperture-native-vault", async () => {
    const listing = await fetchVault();
    await renderChainMonitor(listing);
    if (openUnlockedCatalog(listing)) closeChainLedger();
    else if (els.chainVaultStatus) {
      els.chainVaultStatus.textContent = (listing.files || []).length
        ? "Chain failed verification — plates stay locked"
        : "No decodable plates in that folder.";
    }
  });
  onHash();
}

function apertureHandleBack() {
  if (!els.help.hidden) {
    els.help.hidden = true;
    return true;
  }
  if (els.chainLedger && !els.chainLedger.hidden) {
    closeChainLedger();
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
