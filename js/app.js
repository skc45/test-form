import { CATEGORIES as DEMO_CATEGORIES, PHOTOS as DEMO_PHOTOS, fallbackSrc, plateNumber } from "./catalog.js";
import * as cache from "./data.js";
import * as theme from "./theme.js";
import * as eth from "./eth.js";
import * as plugs from "./interface.js";
import * as bobble from "./bobble.js";

theme.bootSkin();

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
  downloadsPermit: document.getElementById("downloadsPermit"),
  downloadCopy: document.getElementById("downloadCopy"),
  downloadFill: document.getElementById("downloadFill"),
  postForm: document.getElementById("postForm"),
  postCard: document.getElementById("postCard"),
  postPreview: document.getElementById("postPreview"),
  postCaption: document.getElementById("postCaption"),
  postStatus: document.getElementById("postStatus"),
  postTrack: document.getElementById("postTrack"),
  postFill: document.getElementById("postFill"),
  cropForm: document.getElementById("cropForm"),
  cropImage: document.getElementById("cropImage"),
  cropBox: document.getElementById("cropBox"),
  cropStatus: document.getElementById("cropStatus"),
  postSend: document.getElementById("postSend"),
  postShare: document.getElementById("postShare"),
  themeBtn: document.getElementById("themeBtn"),
  ethBtn: document.getElementById("ethBtn"),
  canvasBar: document.getElementById("canvasBar"),
  canvasCopy: document.getElementById("canvasCopy"),
  canvasBoard: document.getElementById("canvasBoard"),
  canvasStatus: document.getElementById("canvasStatus"),
  canvasWall: document.getElementById("canvasWall"),
  canvasTrack: document.getElementById("canvasTrack"),
  canvasFill: document.getElementById("canvasFill"),
  canvasNftAll: document.getElementById("canvasNftAll"),
  plugBtn: document.getElementById("plugBtn"),
  plugMenu: document.getElementById("plugMenu"),
  plugStatus: document.getElementById("plugStatus"),
  plugBay: document.getElementById("plugBay"),
  plugHits: document.getElementById("plugHits"),
  plugQuery: document.getElementById("plugQuery"),
  ethShard: document.getElementById("ethShard"),
  ethStatus: document.getElementById("ethStatus"),
  ethCatalogAddress: document.getElementById("ethCatalogAddress"),
  ethList: document.getElementById("ethList"),
  ethPointerInput: document.getElementById("ethPointerInput"),
  ethPointerReadout: document.getElementById("ethPointerReadout"),
  ethTrack: document.getElementById("ethTrack"),
  ethFill: document.getElementById("ethFill"),
  skinEditor: document.getElementById("skinEditor"),
  skinSwatches: document.getElementById("skinSwatches"),
  skinStatus: document.getElementById("skinStatus"),
  skinSheen: document.getElementById("skinSheen"),
  app: document.getElementById("app"),
  brandKicker: document.querySelector(".brand-kicker"),
};

let slideTimer = 0;
let chromeTimer = 0;
let downloadTimer = 0;
let recentSlideTimer = 0;
let downloadBusy = false;
let downloadsPermitWait = null;
let postBusy = false;
let ethBusy = false;
let canvasNftBusy = false;
let canvasPosts = [];
let plugMap = plugs.defaultPlugs();
let plugHits = [];
let longPress = { timer: 0, fired: false, x: 0, y: 0 };
let swipe = { x: 0, t: 0 };
const crop = {
  photo: null,
  norm: null,
  drag: null,
};

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
    return [photo.title, photo.location, photo.photographer, photo.category, photo.id]
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
  bobble.attachBobbles(els.heroBtn, els.heroImg);
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
        <span class="card-photo">
          <img alt="" />
          <span class="bobble-layer" aria-hidden="true"></span>
        </span>
        <span class="card-meta">
          <strong>${photo.title}</strong>
          <span>${photo.location || photo.category}</span>
        </span>
      </button>`
    )
    .join("");

  [...els.catalog.querySelectorAll(".card")].forEach((card, i) => {
    const photo = photos[i];
    const image = card.querySelector("img");
    bindImage(image, photo);
    bobble.attachBobbles(card.querySelector(".card-photo"), image);
    card.addEventListener("click", () => {
      if (longPressConsumed()) return;
      openViewer(photo.id);
    });
    attachLongPress(card, () => openCrop(photo));
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
    attachLongPress(thumb, () => openCrop(photos[i]));
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
}

function persistCatalog() {
  void persistCatalogAsync();
}

async function persistCatalogAsync() {
  const hint = els.catalogHint;
  if (state.source === "folder" && state.folderName) {
    if (hint) {
      hint.innerHTML = `${escapeHtml(state.folderName)} · <kbd>I</kbd> interface · <kbd>B</kbd> canvasboard · <kbd>X</kbd> NFT`;
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
  if (hint) {
    hint.innerHTML = "Open a folder · <kbd>I</kbd> interface · <kbd>B</kbd> canvasboard · <kbd>X</kbd> NFT · <kbd>T</kbd> skin";
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

function paintSkinEditor() {
  const skin = theme.getSkin();
  if (els.skinStatus) els.skinStatus.textContent = `${skin.name} · live`;
  if (els.skinSwatches) {
    els.skinSwatches.innerHTML = theme.PRESETS.map(
      (item) => `
      <button class="skin-swatch" type="button" data-skin-id="${item.id}" aria-pressed="${item.id === skin.id ? "true" : "false"}" style="${theme.swatchStyle(item)}" title="${item.name}">
        <span>${item.name}</span>
      </button>`
    ).join("");
  }
  for (const input of els.skinEditor?.querySelectorAll("input[data-skin]") || []) {
    input.value = skin[input.dataset.skin] || "#000000";
  }
  if (els.skinSheen) els.skinSheen.value = String(Math.round(skin.sheen * 100));
}

function openSkinEditor() {
  if (!els.skinEditor) return;
  paintSkinEditor();
  els.skinEditor.hidden = false;
}

function closeSkinEditor() {
  if (els.skinEditor) els.skinEditor.hidden = true;
}

function pluggedCount() {
  return plugs.SERVERS.filter((server) => plugs.isPlugged(plugMap[server.id])).length;
}

function paintPlugBay() {
  if (!els.plugBay) return;
  els.plugBay.innerHTML = plugs.SERVERS.map((server) => {
    const engineId = plugMap[server.id] || "off";
    const unplugged = !plugs.isPlugged(engineId);
    const options = plugs.ENGINES.map(
      (engine) =>
        `<option value="${engine.id}"${engine.id === engineId ? " selected" : ""}>${escapeHtml(engine.label)}</option>`
    ).join("");
    return `
      <div class="plug-row${unplugged ? " is-unplugged" : ""}">
        <div class="plug-server">
          <strong>${escapeHtml(server.label)}</strong>
          <span>${escapeHtml(server.hint)}</span>
        </div>
        <span class="plug-cable" aria-hidden="true"></span>
        <label>
          <span class="sr-only">Search engine for ${escapeHtml(server.label)}</span>
          <select data-plug-server="${server.id}">${options}</select>
        </label>
      </div>`;
  }).join("");
}

async function collectPlugRecords() {
  const records = [];
  if (plugs.isPlugged(plugMap.catalog)) {
    for (const photo of state.photos) records.push(plugs.recordFromPhoto(photo, "catalog"));
  }
  if (plugs.isPlugged(plugMap.demo) && !(state.source === "demo" && plugs.isPlugged(plugMap.catalog))) {
    for (const photo of DEMO_PHOTOS) records.push(plugs.recordFromPhoto(photo, "demo"));
  }
  if (plugs.isPlugged(plugMap.canvas)) {
    const listing = await fetchCanvasPosts();
    for (const post of listing.posts || []) records.push(plugs.recordFromPost(post));
  }
  if (plugs.isPlugged(plugMap.eth)) {
    const listing = await fetchEthShard();
    for (const item of listing.plates || []) records.push(plugs.recordFromEth(item));
  }
  return records;
}

async function paintPlugHits() {
  if (!els.plugHits) return;
  const query = String(els.plugQuery?.value || "").trim();
  const live = pluggedCount();
  if (!query) {
    plugHits = [];
    els.plugHits.innerHTML = `<p class="plug-empty">Type to search plugged engines</p>`;
    if (els.plugStatus) {
      els.plugStatus.textContent = live
        ? `${live} image server${live === 1 ? "" : "s"} plugged into search engines`
        : "Plug an image server into a search engine, then search those plugs.";
    }
    return;
  }
  const records = await collectPlugRecords();
  plugHits = records
    .filter((record) => plugs.matchRecord(plugMap[record.server], record, query))
    .slice(0, 24);
  if (!plugHits.length) {
    els.plugHits.innerHTML = `<p class="plug-empty">No plugged engines match that query</p>`;
  } else {
    els.plugHits.innerHTML = plugHits
      .map((record, index) => {
        const engine = plugs.engineById(plugMap[record.server]);
        const server = plugs.serverById(record.server);
        const meta = [server.label, engine.label, record.location || record.pointer || record.file]
          .filter(Boolean)
          .join(" · ");
        const thumb = record.src
          ? `<img alt="" src="${escapeHtml(record.src)}" />`
          : `<span class="plug-hit-fill"></span>`;
        return `
        <li>
          <button class="plug-hit" type="button" data-plug-hit="${index}">
            ${thumb}
            <span>
              <strong>${escapeHtml(record.title || record.caption || record.file || "Plate")}</strong>
              <span>${escapeHtml(meta)}</span>
            </span>
          </button>
        </li>`;
      })
      .join("");
  }
  if (els.plugStatus) {
    els.plugStatus.textContent = `${plugHits.length} hit${plugHits.length === 1 ? "" : "s"} across ${live} plugged server${live === 1 ? "" : "s"}`;
  }
}

async function openPlugMenu() {
  if (!els.plugMenu) return;
  els.plugMenu.hidden = false;
  paintPlugBay();
  await paintPlugHits();
  els.plugQuery?.focus();
}

function closePlugMenu() {
  if (els.plugMenu) els.plugMenu.hidden = true;
}

async function setPlugEngine(serverId, engineId) {
  plugMap = plugs.normalizePlugs({ ...plugMap, [serverId]: engineId });
  paintPlugBay();
  await plugs.savePlugs(plugMap);
  await paintPlugHits();
}

async function resetPlugs() {
  plugMap = plugs.defaultPlugs();
  paintPlugBay();
  await plugs.savePlugs(plugMap);
  await paintPlugHits();
}

function openPlugHit(index) {
  const record = plugHits[index];
  if (!record) return;
  closePlugMenu();
  if (record.server === "eth" && (record.pointer || record.address)) {
    if (els.ethPointerInput) els.ethPointerInput.value = record.pointer || record.address;
    void openEthShard(record.pointer || record.address);
    return;
  }
  if (record.server === "canvas" && record.src) {
    insertDecodedPlate({
      id: record.id || `canvas/${record.file || index}`,
      src: record.src,
      thumb: record.src,
      hero: record.src,
      title: record.title || record.caption || "Post",
      local: true,
      category: "canvas",
    });
    return;
  }
  const photo = record.photo;
  if (photo && state.photos.some((item) => item.id === photo.id)) {
    openViewer(photo.id);
    return;
  }
  if (photo) {
    insertDecodedPlate({
      ...photo,
      featured: true,
      category: photo.category || record.server,
    });
  }
}

function shortAddress(value) {
  const text = String(value || "");
  if (text.length < 16) return text;
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

function currentPlate() {
  if (state.open) return visiblePhotos()[state.activeIndex] || null;
  return state.photos.find((photo) => photo.featured) || state.photos[0] || null;
}

function setEthProgress(pct, label) {
  if (els.ethTrack) els.ethTrack.hidden = pct <= 0;
  if (els.ethFill) els.ethFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (label && els.ethStatus) els.ethStatus.textContent = label;
}

async function fetchEthShard() {
  try {
    const response = await fetch("/api/eth", { headers: { Accept: "application/json" } });
    if (response.ok) return await response.json();
  } catch {
    /* static host */
  }
  if (window.ApertureAndroid?.ethShard) {
    try {
      return JSON.parse(window.ApertureAndroid.ethShard() || "{}");
    } catch {
      /* ignore */
    }
  }
  const local = eth.loadLedger();
  return { ok: true, plates: local.plates || [], catalogAddress: local.catalogAddress || "", count: (local.plates || []).length };
}

function paintEthShard(listing) {
  const plates = listing?.plates || [];
  const address = listing?.catalogAddress || "";
  if (els.ethCatalogAddress) {
    els.ethCatalogAddress.hidden = !address;
    els.ethCatalogAddress.textContent = address ? `Collection ${address}` : "";
  }
  if (els.ethList) {
    els.ethList.innerHTML = plates
      .slice(0, 12)
      .map((item) => {
        const token = item.tokenId || item.nft?.token_id || "";
        return `
      <li>
        <button class="eth-plate" type="button" data-pointer="${escapeHtml(item.pointer || item.address || "")}" data-address="${escapeHtml(item.address || "")}">
          <strong>${escapeHtml(item.title || item.nft?.name || item.file || "NFT")}</strong>
          <span>NFT ${escapeHtml(token ? shortAddress(token) : "erc721")} · shard ${escapeHtml(String(item.shard ?? "—"))}</span>
          <span>${escapeHtml(item.pointer || item.tokenURI || "")}</span>
        </button>
      </li>`;
      })
      .join("");
  }
  if (els.ethStatus && !ethBusy) {
    els.ethStatus.textContent = plates.length
      ? `${plates.length} NFT${plates.length === 1 ? "" : "s"} attached to the Ethereum shard`
      : "Attach plates as NFTs on an Ethereum shard, then open them from a 0x pointer.";
  }
}

async function openEthOverlay() {
  if (!els.ethShard) return;
  els.ethShard.hidden = false;
  paintEthShard(await fetchEthShard());
}

function closeEthOverlay() {
  if (els.ethShard) els.ethShard.hidden = true;
}

async function encodeBytesOnEth(bytes, title, filename, mime) {
  try {
    const body = new FormData();
    body.append("title", title);
    body.append("plate", new Blob([bytes], { type: mime || "application/octet-stream" }), filename);
    const response = await fetch("/api/eth", { method: "POST", body });
    if (response.ok) return await response.json();
  } catch {
    /* encode locally */
  }
  const encoded = await eth.encodePlate(bytes, { title, file: filename, mime }, eth.loadSecret());
  eth.rememberCertificate(encoded.certificate);
  return encoded;
}

async function encodePhotoOnEth(photo, onProgress) {
  const filename = downloadFilename(photo);
  const title = photo.title || filename;
  if (window.ApertureAndroid?.ethEncode) {
    let src = photo.src;
    if (String(src || "").startsWith("blob:")) {
      const blob = await plateBlob(photo, (pct) => onProgress?.(Math.max(8, pct)));
      src = await blobToDataUrl(blob);
    }
    onProgress?.(40);
    return JSON.parse(window.ApertureAndroid.ethEncode(src, filename, title) || "{}");
  }
  const blob = await plateBlob(photo, (pct) => onProgress?.(Math.max(8, pct)));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return encodeBytesOnEth(bytes, title, filename, blob.type);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

async function encodeCatalogOnEth() {
  if (ethBusy || !state.photos.length) return;
  ethBusy = true;
  setEthProgress(4, "Attaching NFTs…");
  try {
    if (window.ApertureAndroid?.ethEncodeFolder) {
      const listing = JSON.parse(window.ApertureAndroid.ethEncodeFolder() || "{}");
      paintEthShard(listing);
      setEthProgress(100, listing.count ? `${listing.count} NFTs on shard` : "Attached as NFTs");
      return;
    }
    if (!window.ApertureAndroid) {
      try {
        const response = await fetch("/api/eth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: state.folderPath }),
        });
        if (response.ok) {
          const listing = await response.json();
          if (listing.encoded || listing.count) {
            paintEthShard(listing);
            setEthProgress(100, `${listing.count || listing.encoded} NFTs on shard`);
            return;
          }
        }
      } catch {
        /* fall through to local encode */
      }
    }
    const photos = state.photos.slice(0, 80);
    let encoded = 0;
    let listing = await fetchEthShard();
    for (let i = 0; i < photos.length; i += 1) {
      setEthProgress(Math.round(((i + 1) / photos.length) * 92), `Attaching ${i + 1} of ${photos.length}…`);
      const result = await encodePhotoOnEth(photos[i]);
      if (result?.ok !== false && (result.certificate || result.address)) encoded += 1;
    }
    listing = await fetchEthShard();
    paintEthShard(listing);
    setEthProgress(100, encoded ? `${listing.count || encoded} NFTs on shard` : "Could not attach");
  } catch {
    setEthProgress(0, "Could not attach as NFT");
  } finally {
    ethBusy = false;
  }
}

async function encodeCurrentOnEth() {
  const photo = currentPlate();
  if (!photo || ethBusy) return;
  ethBusy = true;
  setEthProgress(8, `Attaching ${photo.title || "plate"}…`);
  try {
    const result = await encodePhotoOnEth(photo, (pct) => setEthProgress(Math.max(10, pct), "Reading plate…"));
    if (result?.pointer && els.ethPointerInput) els.ethPointerInput.value = result.pointer;
    paintEthShard(await fetchEthShard());
    setEthProgress(100, result?.address ? `NFT ${shortAddress(result.address)} · shard ${result.shard}` : "Attached as NFT");
  } catch {
    setEthProgress(0, "Could not attach this plate");
  } finally {
    ethBusy = false;
  }
}

function showPointerReadout(text) {
  if (!els.ethPointerReadout) return;
  els.ethPointerReadout.hidden = !text;
  els.ethPointerReadout.textContent = text || "";
}

function insertDecodedPlate(photo) {
  const next = [{ ...photo, featured: true }, ...state.photos.filter((item) => item.id !== photo.id)];
  next.forEach((item, index) => {
    item.index = index;
    item.featured = index === 0;
  });
  state.photos = next;
  const cat = photo.category || "nft";
  const labels = { nft: "NFT", canvas: "Board", eth: "ETH" };
  const label = labels[cat] || cat;
  if (!state.categories.some((item) => item.id === cat)) {
    state.categories = [...state.categories, { id: cat, label }];
  }
  renderFilters();
  renderHero();
  renderCatalog();
  openViewer(photo.id);
}

function nftPlaceholderSrc(located) {
  const title = escapeHtml(located?.nft?.name || located?.title || "NFT");
  const token = String(located?.tokenId || located?.certificate?.tokenId || located?.nft?.token_id || "");
  const shard = located?.shard == null ? "shard" : `shard ${located.shard}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 750">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7ec8f5"/><stop offset="1" stop-color="#1C5FA8"/></linearGradient></defs>
    <rect width="600" height="750" fill="url(#g)"/>
    <path d="M300 150l110 145-110 270-110-270z" fill="none" stroke="#ffffff" stroke-width="8"/>
    <text x="300" y="620" text-anchor="middle" fill="#ffffff" font-family="Outfit,sans-serif" font-size="28">${title}</text>
    <text x="300" y="656" text-anchor="middle" fill="#d9f0ff" font-family="Outfit,sans-serif" font-size="16">${escapeHtml(shard)} · ERC-721</text>
    <text x="300" y="684" text-anchor="middle" fill="#d9f0ff" font-family="Outfit,sans-serif" font-size="14">${escapeHtml(token ? shortAddress(token) : "")}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function openEthShard(code) {
  const pointer = String(code || els.ethPointerInput?.value || "").trim();
  if (!pointer) {
    setEthProgress(0, "Paste a shard pointer to open");
    return;
  }
  if (els.ethPointerInput) els.ethPointerInput.value = pointer;
  ethBusy = true;
  setEthProgress(12, "Reading Ethereum shard…");
  try {
    let located = null;
    if (window.ApertureAndroid?.ethOpen) {
      located = JSON.parse(window.ApertureAndroid.ethOpen(pointer) || "{}");
    }
    if (!located?.ok) {
      try {
        const response = await fetch("/api/eth/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pointer }),
        });
        if (response.ok) located = await response.json();
      } catch {
        located = null;
      }
    }
    if (!located?.ok) {
      try {
        const response = await fetch(`/api/eth/shard?c=${encodeURIComponent(pointer)}`, {
          headers: { Accept: "application/json" },
        });
        if (response.ok) located = await response.json();
      } catch {
        located = null;
      }
    }
    if (!located?.ok) {
      located = eth.parsePointer(pointer);
      if (located?.ok) {
        const cert = (eth.loadLedger().plates || []).find(
          (item) => eth.normalizeAddress(item.address) === located.address || item.pointer === pointer
        );
        if (cert && located.shard != null && Number(cert.shard) !== located.shard) located = { ok: false };
        else if (cert) {
          located.certificate = cert;
          located.title = cert.title || cert.nft?.name || "ETH NFT";
          located.shard = cert.shard;
          located.pointer = cert.pointer || located.pointer;
          located.catalogAddress = cert.catalogAddress || "";
          located.imageHash = cert.imageHash || "";
          located.tokenId = cert.tokenId || "";
          located.tokenURI = cert.tokenURI || eth.nftTokenURI(located.address);
          located.standard = cert.standard || "erc721";
          located.nft = cert.nft || eth.nftMetadata(cert);
        }
        const bytes = eth.loadBytes(located.address);
        if (bytes) {
          const src = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
          state.blobUrls.push(src);
          located.src = src;
          located.decoded = true;
        }
        if (!cert && !located.decoded) located = { ok: false };
      }
    }
    if (!located?.ok) {
      setEthProgress(0, "Could not open that shard");
      showPointerReadout("");
      return;
    }
    const shardLabel = located.shard == null ? "shard" : `shard ${located.shard}`;
    const tokenId = located.tokenId || located.certificate?.tokenId || located.nft?.token_id || "";
    showPointerReadout(tokenId ? `${shardLabel} · NFT ${shortAddress(tokenId)}` : `${shardLabel} · ${located.address}`);
    let src = located.src || "";
    if (!src && located.decoded && located.address) src = `/media/eth/${located.address}`;
    if (!src) src = nftPlaceholderSrc(located);
    const photo = {
      id: `eth/${located.address}`,
      title: located.nft?.name || located.title || located.certificate?.title || "ETH NFT",
      photographer: "Ethereum NFT",
      location: tokenId ? `Token ${tokenId}` : located.address,
      year: new Date().getFullYear(),
      category: "nft",
      src,
      thumb: src,
      hero: src,
      local: true,
      featured: true,
      tokenId,
      tokenURI: located.tokenURI || located.certificate?.tokenURI || "",
    };
    insertDecodedPlate(photo);
    closeEthOverlay();
    setEthProgress(100, `Opened NFT ${shortAddress(located.address)}`);
  } catch {
    setEthProgress(0, "Could not open that shard");
  } finally {
    ethBusy = false;
  }
}

function downloadEthShard() {
  void (async () => {
    const listing = await fetchEthShard();
    const blob = new Blob([JSON.stringify(listing, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Aperture-nft-${slug(state.folderName || "catalog")}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    if (window.ApertureAndroid?.shareEth) window.ApertureAndroid.shareEth();
  })();
}

function editSkin(patch) {
  theme.applySkin(theme.patchSkin(theme.getSkin(), patch));
  paintSkinEditor();
}

function onHash() {
  const match = location.hash.match(/^#photo\/(.+)$/);
  if (match) openViewer(decodeURIComponent(match[1]));
}

function onKey(event) {
  if (els.downloadsPermit && !els.downloadsPermit.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDownloadsPermit(false);
    }
    return;
  }
  if (els.cropForm && !els.cropForm.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCrop();
    }
    return;
  }
  if (els.postForm && !els.postForm.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePostForm();
    }
    return;
  }
  if (els.canvasBoard && !els.canvasBoard.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCanvasBoard();
    }
    return;
  }
  if (els.plugMenu && !els.plugMenu.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePlugMenu();
    }
    return;
  }
  if (els.skinEditor && !els.skinEditor.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSkinEditor();
    }
    return;
  }
  if (els.ethShard && !els.ethShard.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeEthOverlay();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void openEthShard();
    }
    return;
  }
  if (event.key === "t" || event.key === "T") {
    if (event.target.matches("input, textarea")) return;
    event.preventDefault();
    if (els.skinEditor?.hidden === false) closeSkinEditor();
    else openSkinEditor();
    return;
  }
  if (event.key === "i" || event.key === "I") {
    if (event.target.matches("input, textarea")) return;
    event.preventDefault();
    if (els.plugMenu?.hidden === false) closePlugMenu();
    else void openPlugMenu();
    return;
  }
  if (event.key === "b" || event.key === "B") {
    if (event.target.matches("input, textarea")) return;
    event.preventDefault();
    if (els.canvasBoard?.hidden === false) closeCanvasBoard();
    else void openCanvasBoard();
    return;
  }
  if (event.key === "x" || event.key === "X") {
    if (event.target.matches("input, textarea")) return;
    event.preventDefault();
    if (els.ethShard?.hidden === false) closeEthOverlay();
    else void openEthOverlay();
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

function nativeRequestDownloads() {
  return new Promise((resolve) => {
    window.apertureDownloadsPermission = (ok) => {
      window.apertureDownloadsPermission = null;
      resolve(ok === true || ok === "true");
    };
    window.ApertureAndroid.requestDownloads();
  });
}

async function requestDownloadsGrant() {
  if (window.ApertureAndroid?.requestDownloads) {
    return nativeRequestDownloads();
  }
  if (window.showDirectoryPicker) {
    try {
      let dir;
      try {
        dir = await window.showDirectoryPicker({
          id: "aperture-downloads",
          mode: "readwrite",
          startIn: "downloads",
        });
      } catch (error) {
        if (error?.name === "AbortError") return false;
        dir = await window.showDirectoryPicker({ id: "aperture-downloads", mode: "readwrite" });
      }
      await cache.saveDownloadsHandle(dir);
      return true;
    } catch (error) {
      return false;
    }
  }
  try {
    localStorage.setItem("aperture-downloads", "granted");
  } catch {
    /* quota */
  }
  return true;
}

async function hasDownloadsAccess() {
  if (window.ApertureAndroid?.hasDownloadsAccess) {
    return Boolean(window.ApertureAndroid.hasDownloadsAccess());
  }
  const handle = await cache.loadDownloadsHandle();
  if (handle) {
    const permission = await cache.queryHandlePermission(handle, "readwrite");
    if (permission === "granted") return true;
    const next = await cache.requestHandlePermission(handle, "readwrite");
    return next === "granted";
  }
  try {
    return localStorage.getItem("aperture-downloads") === "granted";
  } catch {
    return false;
  }
}

function closeDownloadsPermit(allowed = false) {
  if (els.downloadsPermit) els.downloadsPermit.hidden = true;
  const wait = downloadsPermitWait;
  downloadsPermitWait = null;
  wait?.(allowed);
}

function askDownloadsPermit() {
  if (!els.downloadsPermit) return requestDownloadsGrant();
  els.downloadsPermit.hidden = false;
  return new Promise((resolve) => {
    downloadsPermitWait = resolve;
  });
}

async function allowDownloadsPermit() {
  if (els.downloadsPermit) els.downloadsPermit.hidden = true;
  const granted = await requestDownloadsGrant();
  const wait = downloadsPermitWait;
  downloadsPermitWait = null;
  wait?.(granted);
}

async function ensureDownloadsAccess() {
  if (await hasDownloadsAccess()) return true;
  return askDownloadsPermit();
}

async function saveToDownloads(blob, filename) {
  const handle = await cache.loadDownloadsHandle();
  if (!handle) {
    triggerSave(blob, filename);
    return;
  }
  let dir = handle;
  try {
    dir = await handle.getDirectoryHandle("Aperture", { create: true });
  } catch {
    dir = handle;
  }
  const file = await dir.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function openDownloadsFolder() {
  if (!(await ensureDownloadsAccess())) return;
  if (window.ApertureAndroid?.openDownloads) {
    window.ApertureAndroid.openDownloads();
    return;
  }
  const handle = await cache.loadDownloadsHandle();
  if (handle) {
    await openDirectoryHandle(handle);
    hideOpener();
  }
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
      setDownloadProgress(pct, pct >= 100 ? "Saved to Downloads" : `Downloading… ${pct}%`);
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
    if (!(await ensureDownloadsAccess())) {
      finishDownload(false, "Downloads permission needed");
      return;
    }
    if (window.ApertureAndroid?.download) {
      await nativeDownload(photo.src, filename);
      finishDownload(true, "Saved to Downloads");
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
    await saveToDownloads(blob, filename);
    finishDownload(true, "Saved to Downloads");
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

function defaultCropNorm() {
  const img = els.cropImage;
  const w = img?.clientWidth || 1;
  const h = img?.clientHeight || 1;
  const side = Math.min(w, h) * 0.86;
  return { x: (w - side) / 2 / w, y: (h - side) / 2 / h, w: side / w, h: side / h };
}

function clampCrop(next) {
  let { x, y, w, h } = next;
  const min = 0.08;
  w = Math.max(min, Math.min(1, w));
  h = Math.max(min, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, w, h };
}

function paintCropBox() {
  const img = els.cropImage;
  const box = els.cropBox;
  if (!img || !box || !crop.norm) return;
  const w = img.clientWidth;
  const h = img.clientHeight;
  if (!w || !h) return;
  box.style.left = `${crop.norm.x * w}px`;
  box.style.top = `${crop.norm.y * h}px`;
  box.style.width = `${crop.norm.w * w}px`;
  box.style.height = `${crop.norm.h * h}px`;
}

function openCrop(photo) {
  if (!photo || !els.cropForm) return;
  window.clearTimeout(longPress.timer);
  crop.photo = photo;
  crop.norm = null;
  crop.drag = null;
  if (els.cropStatus) els.cropStatus.textContent = "Drag the frame to crop";
  els.cropForm.hidden = false;
  const src = photo.hero || photo.src || photo.thumb;
  if (els.cropImage) {
    els.cropImage.onload = () => {
      if (!crop.norm) crop.norm = defaultCropNorm();
      paintCropBox();
    };
    els.cropImage.src = src;
    if (els.cropImage.complete && els.cropImage.naturalWidth) {
      if (!crop.norm) crop.norm = defaultCropNorm();
      paintCropBox();
    }
  }
  void (async () => {
    try {
      const blob = await plateBlob(photo, () => {});
      const url = URL.createObjectURL(blob);
      state.blobUrls.push(url);
      if (crop.photo === photo && els.cropImage) els.cropImage.src = url;
    } catch {
      /* keep original src */
    }
  })();
}

function closeCrop() {
  if (els.cropForm) els.cropForm.hidden = true;
  crop.photo = null;
  crop.norm = null;
  crop.drag = null;
}

function startCropDrag(event) {
  if (!crop.norm || !els.cropImage) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const handle = event.target?.dataset?.handle || "move";
  crop.drag = {
    handle,
    start: { ...crop.norm, px: event.clientX, py: event.clientY },
    imgW: els.cropImage.clientWidth || 1,
    imgH: els.cropImage.clientHeight || 1,
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveCropDrag(event) {
  if (!crop.drag) return;
  const dx = (event.clientX - crop.drag.start.px) / crop.drag.imgW;
  const dy = (event.clientY - crop.drag.start.py) / crop.drag.imgH;
  const { x, y, w, h } = crop.drag.start;
  const handle = crop.drag.handle;
  let next = { x, y, w, h };
  if (handle === "move") next = { x: x + dx, y: y + dy, w, h };
  else if (handle === "nw") next = { x: x + dx, y: y + dy, w: w - dx, h: h - dy };
  else if (handle === "ne") next = { x, y: y + dy, w: w + dx, h: h - dy };
  else if (handle === "sw") next = { x: x + dx, y, w: w - dx, h: h + dy };
  else if (handle === "se") next = { x, y, w: w + dx, h: h + dy };
  crop.norm = clampCrop(next);
  paintCropBox();
}

function endCropDrag() {
  crop.drag = null;
}

function cropMime(photo) {
  const src = String(photo?.src || photo?.file || "");
  if (/\.png(\?|$)/i.test(src) || String(photo?.mime || "").includes("png")) return "image/png";
  return "image/jpeg";
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("empty crop"))), type, 0.92);
    } catch (err) {
      reject(err);
    }
  });
}

async function applyCrop() {
  const photo = crop.photo;
  const img = els.cropImage;
  if (!photo || !img?.naturalWidth || !crop.norm) {
    if (els.cropStatus) els.cropStatus.textContent = "Wait for the plate to load";
    return;
  }
  const sx = Math.round(crop.norm.x * img.naturalWidth);
  const sy = Math.round(crop.norm.y * img.naturalHeight);
  const sw = Math.max(1, Math.round(crop.norm.w * img.naturalWidth));
  const sh = Math.max(1, Math.round(crop.norm.h * img.naturalHeight));
  const scale = Math.min(1, 2048 / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  try {
    const mime = cropMime(photo);
    const blob = await canvasToBlob(canvas, mime);
    const url = URL.createObjectURL(blob);
    state.blobUrls.push(url);
    const ext = mime === "image/png" ? ".png" : ".jpg";
    const cropped = {
      ...photo,
      id: `crop/${photo.id}`,
      src: url,
      thumb: url,
      hero: url,
      local: true,
      mime,
      title: photo.title || "Plate",
      file: `${slug(photo.title || "plate")}-crop${ext}`,
    };
    closeCrop();
    openPostForm(cropped);
  } catch {
    if (els.cropStatus) els.cropStatus.textContent = "Could not crop this plate";
  }
}

function openPostForm(photo) {
  if (!photo || !els.postForm) return;
  window.clearTimeout(longPress.timer);
  state.postPhoto = photo;
  postBusy = false;
  const src = photo.hero || photo.src || photo.thumb;
  els.postPreview.src = src;
  els.postPreview.alt = photo.title || "Plate";
  els.postCaption.value = photo.title || "";
  els.postStatus.hidden = true;
  els.postTrack.hidden = true;
  els.postFill.style.width = "0%";
  if (els.postSend) els.postSend.disabled = false;
  if (els.postShare) els.postShare.disabled = false;
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

async function sendCanvasPost(event) {
  event?.preventDefault();
  const photo = state.postPhoto;
  if (!photo || postBusy) return;
  postBusy = true;
  if (els.postSend) els.postSend.disabled = true;
  if (els.postShare) els.postShare.disabled = true;
  const caption = els.postCaption.value.trim();
  const title = photo.title || downloadFilename(photo);
  setPostProgress(8, "Posting on Canvasboard…");
  try {
    const result = await saveCanvasPost(photo, title, caption, (pct) => {
      setPostProgress(Math.max(10, pct), "Saving plate…");
    });
    if (result?.ok === false) {
      setPostProgress(0, "Could not post on Canvasboard");
      postBusy = false;
      if (els.postSend) els.postSend.disabled = false;
      if (els.postShare) els.postShare.disabled = false;
      return;
    }
    setPostProgress(100, "Posted on Canvasboard");
    window.setTimeout(() => {
      closePostForm();
      void openCanvasBoard();
    }, 500);
  } catch {
    postBusy = false;
    if (els.postSend) els.postSend.disabled = false;
    if (els.postShare) els.postShare.disabled = false;
    setPostProgress(0, "Could not post on Canvasboard");
    if (els.postTrack) els.postTrack.hidden = true;
  }
}

const CANVAS_POSTS_KEY = "aperture-canvas-posts";

function loadLocalCanvasPosts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CANVAS_POSTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberLocalCanvasPost(post) {
  const next = [post, ...loadLocalCanvasPosts().filter((item) => item.file !== post.file)].slice(0, 80);
  try {
    localStorage.setItem(CANVAS_POSTS_KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
}

async function fetchCanvasPosts() {
  try {
    const response = await fetch("/api/posts", { headers: { Accept: "application/json" } });
    if (response.ok) return await response.json();
  } catch {
    /* static host or native intercept */
  }
  if (window.ApertureAndroid?.posts) {
    try {
      return JSON.parse(window.ApertureAndroid.posts() || "{}");
    } catch {
      /* ignore */
    }
  }
  const posts = loadLocalCanvasPosts();
  return { ok: true, count: posts.length, posts };
}

async function saveCanvasPost(photo, title, caption, onProgress) {
  const filename = downloadFilename(photo);
  if (window.ApertureAndroid?.savePost) {
    let src = photo.src;
    if (String(src || "").startsWith("blob:")) {
      const blob = await plateBlob(photo, (pct) => onProgress?.(Math.max(8, pct)));
      src = await blobToDataUrl(blob);
    }
    onProgress?.(70);
    return JSON.parse(window.ApertureAndroid.savePost(src, filename, title, caption) || "{}");
  }
  const blob = await plateBlob(photo, (pct) => onProgress?.(Math.max(8, pct)));
  const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
  try {
    const result = await postViaHttp(file, caption, title, (pct) => onProgress?.(Math.max(12, pct)));
    if (result?.ok !== false) {
      return {
        ok: true,
        title,
        caption,
        ...result,
        src: result.src || (result.file ? `/media/posts/${result.file}` : ""),
      };
    }
  } catch {
    /* fall through to local board */
  }
  const dataUrl = await blobToDataUrl(blob);
  const post = {
    ok: true,
    title,
    caption,
    file: filename,
    type: blob.type || "image/jpeg",
    sentAt: new Date().toISOString().slice(0, 19),
    src: dataUrl,
  };
  rememberLocalCanvasPost(post);
  return post;
}

function paintCanvasBoard(listing) {
  canvasPosts = listing?.posts || [];
  const attached = canvasPosts.filter((post) => post.pointer || post.address).length;
  if (els.canvasStatus && !canvasNftBusy) {
    if (!canvasPosts.length) {
      els.canvasStatus.textContent = "Crop a plate, then post it on the board.";
    } else if (attached) {
      els.canvasStatus.textContent = `${canvasPosts.length} post${canvasPosts.length === 1 ? "" : "s"} · ${attached} NFT${attached === 1 ? "" : "s"}`;
    } else {
      els.canvasStatus.textContent = `${canvasPosts.length} post${canvasPosts.length === 1 ? "" : "s"} on Canvasboard`;
    }
  }
  if (els.canvasNftAll) {
    els.canvasNftAll.disabled = canvasNftBusy || !canvasPosts.length;
    const pending = canvasPosts.filter((post) => !(post.pointer || post.address)).length;
    els.canvasNftAll.textContent = !canvasPosts.length
      ? "Attach as NFT"
      : pending
        ? attached
          ? "Attach remaining as NFTs"
          : "Attach as NFT"
        : "Open NFTs";
  }
  if (!els.canvasWall) return;
  if (!canvasPosts.length) {
    els.canvasWall.innerHTML = `<p class="canvas-empty">Nothing posted yet</p>`;
    return;
  }
  els.canvasWall.innerHTML = canvasPosts
    .map((post, index) => {
      const caption = post.caption || post.title || "";
      const title = post.title || post.caption || "Post";
      const pointer = post.pointer || post.address || "";
      const nftLabel = pointer
        ? `NFT ${shortAddress(post.tokenId || pointer)}`
        : "Not attached as NFT";
      return `
      <article class="canvas-plate">
        <button class="canvas-open" type="button" data-canvas-open="${index}">
          <span class="card-photo">
            <img src="${escapeHtml(post.src || "")}" alt="${escapeHtml(title)}" />
            <span class="bobble-layer" aria-hidden="true"></span>
          </span>
        </button>
        ${caption ? `<p class="canvas-caption">${escapeHtml(caption)}</p>` : ""}
        <p class="canvas-nft${pointer ? " is-attached" : ""}">${escapeHtml(nftLabel)}</p>
        <button class="text-btn canvas-nft-btn" type="button" data-canvas-nft="${index}">${
          pointer ? "Open NFT" : "Attach as NFT"
        }</button>
      </article>`;
    })
    .join("");
  els.canvasWall.querySelectorAll(".canvas-open").forEach((open) => {
    bobble.attachBobbles(open.querySelector(".card-photo"), open.querySelector("img"));
  });
}

function photoFromCanvasPost(post, index) {
  return {
    id: `canvas/${post.file || index}`,
    src: post.src,
    thumb: post.src,
    hero: post.src,
    title: post.title || post.caption || "Post",
    file: post.file,
    mime: post.type,
    local: true,
    category: "canvas",
  };
}

function canvasNftPatch(post, result) {
  return {
    file: post.file,
    pointer: result.pointer || "",
    address: result.address || "",
    tokenId: result.certificate?.tokenId || result.tokenId || result.nft?.token_id || "",
    shard: result.shard,
  };
}

function applyCanvasNft(post, result) {
  const patch = canvasNftPatch(post, result);
  Object.assign(post, patch);
  rememberLocalCanvasPost(post);
  return patch;
}

async function persistCanvasNft(post, result) {
  const patch = applyCanvasNft(post, result);
  if (window.ApertureAndroid?.attachPostNft && patch.file) {
    try {
      JSON.parse(window.ApertureAndroid.attachPostNft(patch.file, JSON.stringify(patch)) || "{}");
    } catch {
      /* ignore */
    }
  }
  try {
    await fetch("/api/posts/nft", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    });
  } catch {
    /* static host */
  }
  return patch;
}

function setCanvasNftProgress(pct, label) {
  if (els.canvasTrack) els.canvasTrack.hidden = pct <= 0;
  if (els.canvasFill) els.canvasFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (label && els.canvasStatus) els.canvasStatus.textContent = label;
  if (els.canvasNftAll) els.canvasNftAll.disabled = canvasNftBusy || !canvasPosts.length;
  els.canvasWall?.querySelectorAll("[data-canvas-nft]").forEach((btn) => {
    btn.disabled = canvasNftBusy;
  });
}

function canvasNftReady(result) {
  return result?.ok !== false && (result?.pointer || result?.address || result?.certificate);
}

async function encodeCanvasPostOnEth(index) {
  const post = canvasPosts[index];
  if (!post?.src || canvasNftBusy || ethBusy) return;
  if (post.pointer || post.address) {
    if (els.ethPointerInput) els.ethPointerInput.value = post.pointer || post.address;
    void openEthShard(post.pointer || post.address);
    return;
  }
  canvasNftBusy = true;
  setCanvasNftProgress(8, `Attaching ${post.title || post.caption || "post"}…`);
  try {
    const result = await encodePhotoOnEth(photoFromCanvasPost(post, index), (pct) => {
      setCanvasNftProgress(Math.max(10, pct), "Reading plate…");
    });
    if (!canvasNftReady(result)) {
      setCanvasNftProgress(0, "Could not attach as NFT");
      return;
    }
    await persistCanvasNft(post, result);
    if (result.pointer && els.ethPointerInput) els.ethPointerInput.value = result.pointer;
    paintCanvasBoard({ posts: canvasPosts });
    setCanvasNftProgress(100, result.pointer ? `NFT ${shortAddress(result.pointer)}` : "Attached as NFT");
  } catch {
    setCanvasNftProgress(0, "Could not attach as NFT");
  } finally {
    canvasNftBusy = false;
    if (els.canvasNftAll) els.canvasNftAll.disabled = !canvasPosts.length;
    window.setTimeout(() => {
      if (!canvasNftBusy) {
        if (els.canvasTrack) els.canvasTrack.hidden = true;
        paintCanvasBoard({ posts: canvasPosts });
      }
    }, 900);
  }
}

async function encodeCanvasBoardOnEth() {
  const pending = canvasPosts.filter((post) => post.src && !(post.pointer || post.address));
  if (canvasNftBusy || ethBusy) return;
  if (!pending.length) {
    const first = canvasPosts.find((post) => post.pointer || post.address);
    if (first?.pointer || first?.address) {
      const pointer = first.pointer || first.address;
      if (els.ethPointerInput) els.ethPointerInput.value = pointer;
      void openEthShard(pointer);
    }
    return;
  }
  canvasNftBusy = true;
  setCanvasNftProgress(4, "Attaching Canvasboard as NFTs…");
  let encoded = 0;
  try {
    for (let i = 0; i < pending.length; i += 1) {
      const post = pending[i];
      setCanvasNftProgress(Math.round(((i + 1) / pending.length) * 92), `Attaching ${i + 1} of ${pending.length}…`);
      const result = await encodePhotoOnEth(photoFromCanvasPost(post, canvasPosts.indexOf(post)));
      if (!canvasNftReady(result)) continue;
      await persistCanvasNft(post, result);
      encoded += 1;
    }
    paintCanvasBoard({ posts: canvasPosts });
    setCanvasNftProgress(100, encoded ? `${encoded} NFT${encoded === 1 ? "" : "s"} on Canvasboard` : "Could not attach as NFT");
  } catch {
    setCanvasNftProgress(0, "Could not attach as NFT");
  } finally {
    canvasNftBusy = false;
    if (els.canvasNftAll) els.canvasNftAll.disabled = !canvasPosts.length;
    window.setTimeout(() => {
      if (!canvasNftBusy) {
        if (els.canvasTrack) els.canvasTrack.hidden = true;
        paintCanvasBoard({ posts: canvasPosts });
      }
    }, 900);
  }
}

async function openCanvasBoard() {
  if (!els.canvasBoard) return;
  els.canvasBoard.hidden = false;
  paintCanvasBoard(await fetchCanvasPosts());
}

function closeCanvasBoard() {
  if (els.canvasBoard) els.canvasBoard.hidden = true;
}

function openCanvasPlate(index) {
  const post = canvasPosts[index];
  if (!post?.src) return;
  closeCanvasBoard();
  insertDecodedPlate({
    id: `canvas/${post.file || index}`,
    src: post.src,
    thumb: post.src,
    hero: post.src,
    title: post.title || post.caption || "Post",
    local: true,
    category: "canvas",
  });
}

async function sendPost(event) {
  event?.preventDefault();
  const photo = state.postPhoto;
  if (!photo || postBusy) return;
  postBusy = true;
  if (els.postSend) els.postSend.disabled = true;
  if (els.postShare) els.postShare.disabled = true;
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
    if (els.postSend) els.postSend.disabled = false;
    if (els.postShare) els.postShare.disabled = false;
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
  await theme.restoreSkin();
  plugMap = await plugs.restorePlugs();
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
  document.getElementById("openerDownloadsBtn")?.addEventListener("click", () => void openDownloadsFolder());
  document.getElementById("downloadsAllow")?.addEventListener("click", () => void allowDownloadsPermit());
  document.getElementById("downloadsDeny")?.addEventListener("click", () => closeDownloadsPermit(false));
  els.downloadsPermit?.addEventListener("click", (event) => {
    if (event.target === els.downloadsPermit) closeDownloadsPermit(false);
  });
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
    if (photo) openCrop(photo);
  });
  attachLongPress(els.heroBtn, () => {
    const featured = state.photos.find((p) => p.featured) || state.photos[0];
    if (featured) openCrop(featured);
  });
  document.getElementById("cropApply")?.addEventListener("click", () => void applyCrop());
  document.getElementById("cropCancel")?.addEventListener("click", closeCrop);
  els.cropForm?.addEventListener("click", (event) => {
    if (event.target === els.cropForm) closeCrop();
  });
  els.cropBox?.addEventListener("pointerdown", startCropDrag);
  els.cropBox?.addEventListener("pointermove", moveCropDrag);
  els.cropBox?.addEventListener("pointerup", endCropDrag);
  els.cropBox?.addEventListener("pointercancel", endCropDrag);
  window.addEventListener("resize", () => {
    if (els.cropForm && !els.cropForm.hidden) paintCropBox();
  });
  els.postCard?.addEventListener("submit", sendCanvasPost);
  document.getElementById("postShare")?.addEventListener("click", (event) => void sendPost(event));
  document.getElementById("postCancel")?.addEventListener("click", closePostForm);
  els.postForm?.addEventListener("click", (event) => {
    if (event.target === els.postForm) closePostForm();
  });
  els.themeBtn?.addEventListener("click", openSkinEditor);
  els.ethBtn?.addEventListener("click", () => void openEthOverlay());
  els.canvasBar?.addEventListener("click", () => void openCanvasBoard());
  document.getElementById("canvasClose")?.addEventListener("click", closeCanvasBoard);
  document.getElementById("canvasNftAll")?.addEventListener("click", () => void encodeCanvasBoardOnEth());
  els.canvasBoard?.addEventListener("click", (event) => {
    if (event.target === els.canvasBoard) closeCanvasBoard();
  });
  els.canvasWall?.addEventListener("click", (event) => {
    const nftBtn = event.target.closest("[data-canvas-nft]");
    if (nftBtn) {
      event.preventDefault();
      void encodeCanvasPostOnEth(Number(nftBtn.dataset.canvasNft));
      return;
    }
    const openBtn = event.target.closest("[data-canvas-open]");
    if (!openBtn) return;
    openCanvasPlate(Number(openBtn.dataset.canvasOpen));
  });
  document.getElementById("ethEncodeCatalog")?.addEventListener("click", () => void encodeCatalogOnEth());
  document.getElementById("ethEncodePlate")?.addEventListener("click", () => void encodeCurrentOnEth());
  document.getElementById("ethOpen")?.addEventListener("click", () => void openEthShard());
  document.getElementById("ethDownload")?.addEventListener("click", downloadEthShard);
  document.getElementById("ethClose")?.addEventListener("click", closeEthOverlay);
  els.ethList?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-pointer]");
    if (!btn) return;
    const pointer = btn.dataset.pointer || "";
    if (els.ethPointerInput) els.ethPointerInput.value = pointer;
    if (pointer) void openEthShard(pointer);
  });
  els.ethShard?.addEventListener("click", (event) => {
    if (event.target === els.ethShard) closeEthOverlay();
  });
  els.plugBtn?.addEventListener("click", () => void openPlugMenu());
  document.getElementById("plugClose")?.addEventListener("click", closePlugMenu);
  document.getElementById("plugReset")?.addEventListener("click", () => void resetPlugs());
  els.plugMenu?.addEventListener("click", (event) => {
    if (event.target === els.plugMenu) closePlugMenu();
  });
  els.plugQuery?.addEventListener("input", () => void paintPlugHits());
  els.plugBay?.addEventListener("change", (event) => {
    const select = event.target.closest("[data-plug-server]");
    if (!select) return;
    void setPlugEngine(select.dataset.plugServer, select.value);
  });
  els.plugHits?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-plug-hit]");
    if (!btn) return;
    openPlugHit(Number(btn.dataset.plugHit));
  });
  document.getElementById("skinClose")?.addEventListener("click", closeSkinEditor);
  document.getElementById("skinReset")?.addEventListener("click", () => {
    theme.applySkin(theme.defaultSkin());
    paintSkinEditor();
  });
  els.skinSwatches?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-skin-id]");
    if (!btn) return;
    const preset = theme.presetById(btn.dataset.skinId);
    if (!preset) return;
    theme.applySkin(preset);
    paintSkinEditor();
  });
  els.skinEditor?.querySelectorAll("input[data-skin]").forEach((input) => {
    input.addEventListener("input", () => editSkin({ [input.dataset.skin]: input.value }));
  });
  els.skinSheen?.addEventListener("input", () => editSkin({ sheen: Number(els.skinSheen.value) / 100 }));
  els.skinEditor?.addEventListener("click", (event) => {
    if (event.target === els.skinEditor) closeSkinEditor();
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
      openCrop(photo);
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
  if (els.downloadsPermit && !els.downloadsPermit.hidden) {
    closeDownloadsPermit(false);
    return true;
  }
  if (!els.help.hidden) {
    els.help.hidden = true;
    return true;
  }
  if (els.skinEditor && !els.skinEditor.hidden) {
    closeSkinEditor();
    return true;
  }
  if (els.ethShard && !els.ethShard.hidden) {
    closeEthOverlay();
    return true;
  }
  if (els.plugMenu && !els.plugMenu.hidden) {
    closePlugMenu();
    return true;
  }
  if (els.canvasBoard && !els.canvasBoard.hidden) {
    closeCanvasBoard();
    return true;
  }
  if (els.cropForm && !els.cropForm.hidden) {
    closeCrop();
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
