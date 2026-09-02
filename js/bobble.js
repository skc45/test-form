const hosts = new Set();
let enabled = true;
let slides = [];
let tick = 0;
let clock = 0;
let nextOffset = 0;

const BOBBLE_KEY = "aperture-bobble";
export const SLIDE_SPEED = 25;
export const BASE_SLIDE_MS = 3200;
export const SLIDE_MS = Math.max(40, Math.round(BASE_SLIDE_MS / SLIDE_SPEED));
export const RECENT_SLIDE_MS = Math.max(40, Math.round(1800 / SLIDE_SPEED));

export function prefersBobbleMotion() {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isBobbleEnabled() {
  return enabled;
}

export function canPaintBobbles() {
  return enabled;
}

export function setSlides(photos) {
  const next = [];
  const seen = new Set();
  for (const photo of photos || []) {
    const src = typeof photo === "string" ? photo : photo?.thumb || photo?.src || photo?.hero || "";
    if (!src || seen.has(src)) continue;
    seen.add(src);
    next.push(src);
  }
  slides = next;
  if (enabled) syncHosts();
}

export async function restoreBobble() {
  if (window.ApertureAndroid?.loadBobble) {
    try {
      const raw = window.ApertureAndroid.loadBobble();
      if (raw) {
        enabled = JSON.parse(raw).enabled !== false;
        persistLocal(enabled);
        applyEnabled();
        return enabled;
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const data = JSON.parse(localStorage.getItem(BOBBLE_KEY) || "{}");
    if (typeof data.enabled === "boolean") enabled = data.enabled;
  } catch {
    enabled = true;
  }
  applyEnabled();
  return enabled;
}

export function setBobbleEnabled(on) {
  enabled = Boolean(on);
  persist(enabled);
  applyEnabled();
  return enabled;
}

export function toggleBobble() {
  return setBobbleEnabled(!enabled);
}

export function attachBobbles(host, img) {
  attachSlideshow(host, img);
}

export function attachSlideshow(host, img) {
  if (!host) return;
  hosts.add(host);
  host._slideImg = img;
  if (!Object.prototype.hasOwnProperty.call(host, "_slideAt")) {
    host._slideAt = nextOffset++;
  }
  if (!canPaintBobbles()) {
    clearHost(host);
    return;
  }
  mountSlideshow(host);
  ensureClock();
}

function persist(on) {
  const body = JSON.stringify({ enabled: on });
  persistLocal(on);
  window.ApertureAndroid?.saveBobble?.(body);
}

function persistLocal(on) {
  try {
    localStorage.setItem(BOBBLE_KEY, JSON.stringify({ enabled: on }));
  } catch {
    /* quota */
  }
}

function applyEnabled() {
  document.body.classList.toggle("bobble-off", !enabled);
  for (const host of [...hosts]) {
    if (!host.isConnected) {
      hosts.delete(host);
      continue;
    }
    if (!enabled) clearHost(host);
    else attachSlideshow(host, host._slideImg);
  }
  if (enabled) ensureClock();
  else stopClock();
}

function clearHost(host) {
  const layer = host.querySelector(":scope > .slide-layer, :scope > .bobble-layer");
  if (layer) layer.replaceChildren();
  host.classList.remove("has-slideshow", "has-bobble");
}

function layerFor(host) {
  let layer = host.querySelector(":scope > .slide-layer, :scope > .bobble-layer");
  if (!layer) {
    layer = document.createElement("span");
    host.appendChild(layer);
  }
  layer.className = "slide-layer bobble-layer";
  layer.setAttribute("aria-hidden", "true");
  return layer;
}

function mountSlideshow(host) {
  const layer = layerFor(host);
  layer.replaceChildren();
  const wrap = document.createElement("span");
  wrap.className = "plate-slideshow";
  const a = document.createElement("img");
  const b = document.createElement("img");
  a.alt = "";
  b.alt = "";
  a.draggable = false;
  b.draggable = false;
  a.className = "is-active";
  wrap.appendChild(a);
  wrap.appendChild(b);
  layer.appendChild(wrap);
  host._slidePair = [a, b];
  host.classList.add("has-slideshow");
  paintHost(host);
}

function frameIndex(host) {
  const n = slides.length;
  if (!n) return 0;
  return (tick + (host._slideAt || 0)) % n;
}

function paintHost(host) {
  const pair = host._slidePair;
  if (!pair || !slides.length) return;
  const src = slides[frameIndex(host)];
  const show = pair[0].classList.contains("is-active") ? pair[0] : pair[1];
  if (show.src === src || show.getAttribute("src") === src) return;
  const hide = show === pair[0] ? pair[1] : pair[0];
  hide.onload = () => {
    hide.classList.add("is-active");
    show.classList.remove("is-active");
  };
  hide.src = src;
  if (hide.complete && hide.naturalWidth) {
    hide.classList.add("is-active");
    show.classList.remove("is-active");
  }
}

function syncHosts() {
  for (const host of [...hosts]) {
    if (!host.isConnected) {
      hosts.delete(host);
      continue;
    }
    if (enabled) paintHost(host);
  }
}

function ensureClock() {
  if (clock || !enabled || slides.length < 2 || !prefersBobbleMotion()) return;
  clock = window.setInterval(() => {
    if (!enabled || slides.length < 2) {
      stopClock();
      return;
    }
    tick += 1;
    syncHosts();
  }, SLIDE_MS);
}

function stopClock() {
  window.clearInterval(clock);
  clock = 0;
}
