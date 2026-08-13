import { CATEGORIES, PHOTOS, fallbackSrc, plateNumber } from "./catalog.js";

const state = {
  photos: [...PHOTOS],
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
};

const els = {
  filters: document.getElementById("filters"),
  catalog: document.getElementById("catalog"),
  empty: document.getElementById("empty"),
  count: document.getElementById("resultCount"),
  search: document.getElementById("search"),
  layoutBtn: document.getElementById("layoutBtn"),
  fileInput: document.getElementById("fileInput"),
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
  app: document.getElementById("app"),
};

let slideTimer = 0;
let chromeTimer = 0;
let swipe = { x: 0, t: 0 };

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
  img.alt = `${photo.title} — ${photo.location}`;
  img.addEventListener(
    "error",
    () => {
      img.src = fallbackSrc(photo.id);
    },
    { once: true }
  );
  if (img.complete && img.naturalWidth) img.classList.add("is-ready");
  else img.addEventListener("load", () => img.classList.add("is-ready"), { once: true });
}

function renderFilters() {
  els.filters.innerHTML = CATEGORIES.map(
    (cat) => `
      <button class="filter" type="button" data-filter="${cat.id}" aria-pressed="${
        state.filter === cat.id
      }">${cat.label}</button>`
  ).join("");
}

function renderHero() {
  const featured = state.photos.find((p) => p.featured) || state.photos[0];
  if (!featured) return;
  bindImage(els.heroImg, featured, "hero");
  els.heroTitle.textContent = featured.title;
  els.heroMeta.textContent = `${featured.photographer} · ${featured.location} · ${featured.year}`;
  els.heroIndex.textContent = `Plate ${plateNumber(featured.index)}`;
  els.heroBtn.onclick = () => openViewer(featured.id);
}

function renderCatalog() {
  const photos = visiblePhotos();
  els.count.textContent = `${photos.length} plate${photos.length === 1 ? "" : "s"}`;
  els.empty.hidden = photos.length > 0;
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
          <span>${photo.location}</span>
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
  els.viewerMeta.textContent = `${photo.photographer} · ${photo.location} · ${photo.year}`;
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
  history.replaceState(null, "", `#photo/${photo.id}`);
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
  history.replaceState(null, "", location.pathname);
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

function addFiles(files) {
  [...files]
    .filter((file) => file.type.startsWith("image/"))
    .forEach((file) => {
      const url = URL.createObjectURL(file);
      const photo = {
        id: `local-${crypto.randomUUID()}`,
        title: file.name.replace(/\.[^.]+$/, ""),
        photographer: "You",
        location: "Local file",
        year: new Date().getFullYear(),
        category: "yours",
        src: url,
        thumb: url,
        hero: url,
        index: state.photos.length,
        local: true,
      };
      state.photos.unshift(photo);
    });
  state.filter = "yours";
  renderFilters();
  renderCatalog();
  renderHero();
}

function onHash() {
  const match = location.hash.match(/^#photo\/(.+)$/);
  if (match) openViewer(decodeURIComponent(match[1]));
}

function onKey(event) {
  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    els.help.hidden = !els.help.hidden;
    return;
  }
  if (event.key === "Escape") {
    if (!els.help.hidden) {
      els.help.hidden = true;
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

function wire() {
  renderFilters();
  renderHero();
  renderCatalog();

  els.filters.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-filter]");
    if (!btn) return;
    state.filter = btn.dataset.filter;
    renderFilters();
    renderCatalog();
  });

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    renderCatalog();
  });

  els.layoutBtn.addEventListener("click", () => {
    state.layout = state.layout === "masonry" ? "grid" : "masonry";
    renderCatalog();
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
    });
  });
  window.addEventListener("dragleave", () => els.app.classList.remove("is-drag"));
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    els.app.classList.remove("is-drag");
    addFiles(event.dataTransfer.files);
  });

  window.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", onHash);
  onHash();
}

wire();
