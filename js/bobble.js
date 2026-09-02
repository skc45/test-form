const cache = new Map();
const pending = new Map();
const hosts = new Set();
let faceDetector = null;
const queue = [];
let busy = false;
let enabled = true;
let slideVx = 0;
let slideVy = 0;
let slideRaf = 0;
let lastPointer = null;
const scrollState = new WeakMap();

const SCAN_SIZE = 192;
const FACE_SCORE_MIN = 26;
const MAX_MODELS = 4;
const DEFAULT_FACE = { x: 0.18, y: 0.06, w: 0.64, h: 0.72, score: 1, assumed: true };
const BOBBLE_KEY = "aperture-bobble";

function assumedFace() {
  return { ...DEFAULT_FACE };
}

export function prefersBobbleMotion() {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isBobbleEnabled() {
  return enabled;
}

export function canPaintBobbles() {
  return enabled;
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

export function startSlideDriver() {
  if (startSlideDriver.bound) {
    if (enabled && !slideRaf) slideRaf = requestAnimationFrame(tickSlide);
    return;
  }
  startSlideDriver.bound = true;
  const opts = { passive: true };
  const stage = document.getElementById("stage");
  const film = document.getElementById("filmstrip");
  stage?.addEventListener("scroll", onSlideScroll, opts);
  film?.addEventListener("scroll", onSlideScroll, opts);
  window.addEventListener("wheel", onSlideWheel, opts);
  window.addEventListener("pointerdown", onSlidePointerDown, opts);
  window.addEventListener("pointermove", onSlidePointerMove, opts);
  window.addEventListener("pointerup", onSlidePointerUp, opts);
  window.addEventListener("pointercancel", onSlidePointerUp, opts);
  if (enabled) slideRaf = requestAnimationFrame(tickSlide);
}

function onSlideScroll(event) {
  const el = event.currentTarget;
  if (!el) return;
  const now = performance.now();
  const prev = scrollState.get(el) || { x: el.scrollLeft, y: el.scrollTop, t: now };
  const dt = Math.max(8, now - prev.t);
  addSlideVelocity(((el.scrollLeft - prev.x) / dt) * 16, ((el.scrollTop - prev.y) / dt) * 16);
  scrollState.set(el, { x: el.scrollLeft, y: el.scrollTop, t: now });
}

function onSlideWheel(event) {
  addSlideVelocity(event.deltaX * 0.18, event.deltaY * 0.18);
}

function onSlidePointerDown(event) {
  lastPointer = { x: event.clientX, y: event.clientY, t: performance.now() };
}

function onSlidePointerMove(event) {
  const now = performance.now();
  const prev = lastPointer;
  lastPointer = { x: event.clientX, y: event.clientY, t: now };
  if (!prev) return;
  if (!(event.buttons || event.pointerType === "touch")) return;
  const dt = Math.max(8, now - prev.t);
  addSlideVelocity(((event.clientX - prev.x) / dt) * 16, ((event.clientY - prev.y) / dt) * 16);
}

function onSlidePointerUp() {
  lastPointer = null;
}

function addSlideVelocity(dx, dy) {
  slideVx = clamp(slideVx + dx, -90, 90);
  slideVy = clamp(slideVy + dy, -90, 90);
  if (enabled && !slideRaf) slideRaf = requestAnimationFrame(tickSlide);
}

function tickSlide() {
  slideRaf = 0;
  slideVx *= 0.86;
  slideVy *= 0.86;
  if (Math.abs(slideVx) < 0.04) slideVx = 0;
  if (Math.abs(slideVy) < 0.04) slideVy = 0;
  applySlideMotion();
  if (enabled && (slideVx || slideVy)) slideRaf = requestAnimationFrame(tickSlide);
}

function applySlideMotion() {
  const speed = Math.min(1, Math.hypot(slideVx, slideVy) / 42);
  const tx = clamp(slideVx * 0.42, -30, 30);
  const ty = clamp(slideVy * 0.42, -34, 34);
  const rot = clamp(-slideVx * 0.14 + slideVy * 0.04, -9, 9);
  const sc = 1.04 + speed * 0.14;
  const warp = 10 + speed * 44;
  const root = document.documentElement;
  root.style.setProperty("--bobble-tx", `${tx.toFixed(2)}px`);
  root.style.setProperty("--bobble-ty", `${ty.toFixed(2)}px`);
  root.style.setProperty("--bobble-rot", `${rot.toFixed(2)}deg`);
  root.style.setProperty("--bobble-sc", sc.toFixed(3));
  const displace = document.getElementById("sdBobbleDisplace");
  if (displace) displace.setAttribute("scale", warp.toFixed(1));
}

export async function detectModels(img) {
  const src = img?.currentSrc || img?.src || "";
  if (!src || !img?.naturalWidth) return [assumedFace()];
  if (cache.has(src)) return cache.get(src);
  if (pending.has(src)) return pending.get(src);
  const job = measureModels(img)
    .then((models) => {
      const faces = models.length ? models : [assumedFace()];
      cache.set(src, faces);
      pending.delete(src);
      return faces;
    })
    .catch(() => {
      pending.delete(src);
      return [assumedFace()];
    });
  pending.set(src, job);
  return job;
}

export function attachBobbles(host, img) {
  if (!host || !img) return;
  hosts.add(host);
  host._bobbleImg = img;
  startSlideDriver();
  if (!canPaintBobbles()) {
    clearHost(host);
    return;
  }
  const run = () => {
    void paintBobbles(host, img);
  };
  const start = () => waitForBox(img, run);
  if (img.complete && img.naturalWidth) start();
  else img.addEventListener("load", start, { once: true });
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
    const img = host._bobbleImg;
    if (!enabled || !img) clearHost(host);
    else attachBobbles(host, img);
  }
  if (enabled) startSlideDriver();
  else {
    slideVx = 0;
    slideVy = 0;
    if (slideRaf) {
      cancelAnimationFrame(slideRaf);
      slideRaf = 0;
    }
    applySlideMotion();
  }
}

function clearHost(host) {
  const layer = host.querySelector(":scope > .bobble-layer");
  if (layer) layer.replaceChildren();
  host.classList.remove("has-bobble");
}

function waitForBox(img, fn, tries = 0) {
  if ((img.clientWidth > 8 && img.clientHeight > 8) || tries > 45) {
    fn();
    return;
  }
  requestAnimationFrame(() => waitForBox(img, fn, tries + 1));
}

async function paintBobbles(host, img) {
  const layer = layerFor(host);
  mountModels(host, img, layer, [assumedFace()]);
  const models = await detectModels(img);
  if (!host.isConnected) return;
  mountModels(host, img, layer, models.length ? models : [assumedFace()]);
}

function mountModels(host, img, layer, models) {
  layer.replaceChildren();
  const fitted = displayBoxes(img, models);
  const address = highlightAddress(img);
  fitted.forEach((box) => {
    const model = document.createElement("span");
    model.className = "bobble-model bobble-browser";
    model.style.setProperty("--bx", `${box.left}%`);
    model.style.setProperty("--by", `${box.top}%`);
    model.style.setProperty("--bw", `${box.width}%`);
    model.style.setProperty("--bh", `${box.height}%`);
    model.appendChild(browserChrome(address));
    const view = document.createElement("span");
    view.className = "bobble-viewport";
    const cut = document.createElement("span");
    cut.className = "bobble-cut";
    cut.appendChild(cutImage(img, box));
    const rim = document.createElement("span");
    rim.className = "bobble-rim";
    view.appendChild(cut);
    view.appendChild(rim);
    model.appendChild(view);
    layer.appendChild(model);
  });
  host.classList.toggle("has-bobble", Boolean(fitted.length));
}

function browserChrome(address) {
  const chrome = document.createElement("span");
  chrome.className = "bobble-chrome";

  const titlebar = document.createElement("span");
  titlebar.className = "bobble-titlebar";
  const traffic = document.createElement("span");
  traffic.className = "bobble-traffic";
  traffic.setAttribute("aria-hidden", "true");
  ["close", "min", "max"].forEach((name) => {
    const dot = document.createElement("span");
    dot.className = `bobble-dot bobble-dot-${name}`;
    traffic.appendChild(dot);
  });
  const tabs = document.createElement("span");
  tabs.className = "bobble-tabs";
  const tab = document.createElement("span");
  tab.className = "bobble-tab";
  const fav = document.createElement("span");
  fav.className = "bobble-fav";
  fav.setAttribute("aria-hidden", "true");
  tab.appendChild(fav);
  tab.appendChild(document.createTextNode("Highlight"));
  tabs.appendChild(tab);
  titlebar.appendChild(traffic);
  titlebar.appendChild(tabs);

  const toolbar = document.createElement("span");
  toolbar.className = "bobble-toolbar";
  const nav = document.createElement("span");
  nav.className = "bobble-nav";
  nav.setAttribute("aria-hidden", "true");
  [
    ["back", "M14 6l-6 6 6 6"],
    ["fwd", "M10 6l6 6-6 6"],
    ["reload", "M16.5 8.2A5 5 0 108 16.5M16.5 8.2V4.8M16.5 8.2H13"],
  ].forEach(([name, d]) => {
    const btn = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    btn.setAttribute("class", `bobble-nav-btn bobble-nav-${name}`);
    btn.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    btn.appendChild(path);
    nav.appendChild(btn);
  });
  const omnibox = document.createElement("span");
  omnibox.className = "bobble-omnibox";
  const lock = document.createElement("span");
  lock.className = "bobble-lock";
  lock.setAttribute("aria-hidden", "true");
  const url = document.createElement("span");
  url.className = "bobble-url";
  url.textContent = address;
  omnibox.appendChild(lock);
  omnibox.appendChild(url);
  toolbar.appendChild(nav);
  toolbar.appendChild(omnibox);

  chrome.appendChild(titlebar);
  chrome.appendChild(toolbar);
  return chrome;
}

function highlightAddress(img) {
  const raw = img?.currentSrc || img?.src || "";
  try {
    const url = new URL(raw, location.href);
    if (url.protocol === "blob:" || url.protocol === "data:") return "aperture://highlight/media";
    const host = url.hostname || "local";
    const path = (url.pathname || "/media").replace(/\/+$/, "") || "/media";
    return `aperture://highlight/${host}${path}`.slice(0, 72);
  } catch {
    return "aperture://highlight/media";
  }
}

function layerFor(host) {
  let layer = host.querySelector(":scope > .bobble-layer");
  if (!layer) {
    layer = document.createElement("span");
    layer.className = "bobble-layer";
    layer.setAttribute("aria-hidden", "true");
    host.appendChild(layer);
  }
  return layer;
}

function cutImage(img, box) {
  const face = document.createElement("img");
  face.className = "bobble-face";
  face.alt = "";
  face.draggable = false;
  face.decoding = "async";
  if (img.crossOrigin) face.crossOrigin = img.crossOrigin;
  face.src = img.currentSrc || img.src;
  face.style.width = `${(100 / (box.width / 100)).toFixed(3)}%`;
  face.style.height = `${(100 / (box.height / 100)).toFixed(3)}%`;
  face.style.left = `${(-(box.left / box.width) * 100).toFixed(3)}%`;
  face.style.top = `${(-(box.top / box.height) * 100).toFixed(3)}%`;
  face.style.transform = "scale(1.48)";
  face.style.transformOrigin = "50% 40%";
  return face;
}

function displayBoxes(img, models) {
  const cw = img.clientWidth || 1;
  const ch = img.clientHeight || 1;
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  const fit = getComputedStyle(img).objectFit;
  let x = 0;
  let y = 0;
  let w = cw;
  let h = ch;
  if (fit === "cover") {
    const scale = Math.max(cw / iw, ch / ih);
    w = iw * scale;
    h = ih * scale;
    x = (cw - w) / 2;
    y = (ch - h) / 2;
  } else if (fit === "contain") {
    const scale = Math.min(cw / iw, ch / ih);
    w = iw * scale;
    h = ih * scale;
    x = (cw - w) / 2;
    y = (ch - h) / 2;
  }
  return models.map((box) => ({
    left: ((x + box.x * w) / cw) * 100,
    top: ((y + box.y * h) / ch) * 100,
    width: ((box.w * w) / cw) * 100,
    height: ((box.h * h) / ch) * 100,
  }));
}

async function measureModels(img) {
  const apiFaces = await detectFaces(img);
  const structured = await enqueue(() => detectByFeatures(img));
  const found = nms([...apiFaces, ...structured], MAX_MODELS, 0.32)
    .map((box) => expand(box, box.fromApi ? 0.22 : 0.18))
    .filter(validBox);
  return found.length ? found : [assumedFace()];
}

async function detectFaces(img) {
  const Detector = window.FaceDetector;
  if (!Detector) return [];
  try {
    if (!faceDetector) faceDetector = new Detector({ fastMode: false, maxDetectedFaces: MAX_MODELS });
    const sample = await faceSample(img);
    try {
      const hits = await faceDetector.detect(sample.source);
      return (hits || [])
        .map((hit) => boxFromDetectedFace(hit, sample.img || img, sample.width, sample.height))
        .filter(Boolean);
    } finally {
      if (sample.source && sample.source !== img && typeof sample.source.close === "function") {
        sample.source.close();
      }
    }
  } catch {
    faceDetector = null;
    return [];
  }
}

async function faceSample(img) {
  try {
    const bitmap = await createImageBitmap(img);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, img };
  } catch {
    const probe = await loadProbe(img);
    return {
      source: probe,
      width: probe.naturalWidth || probe.width || img.naturalWidth,
      height: probe.naturalHeight || probe.height || img.naturalHeight,
      img: probe,
    };
  }
}

function boxFromDetectedFace(hit, img, width, height) {
  const frame = {
    naturalWidth: width || img.naturalWidth,
    naturalHeight: height || img.naturalHeight,
    clientWidth: img.clientWidth,
    clientHeight: img.clientHeight,
    width: img.width,
    height: img.height,
  };
  const landmarks = Array.isArray(hit.landmarks) ? hit.landmarks : [];
  const fromMarks = boxFromLandmarks(landmarks, frame);
  if (fromMarks) return { ...fromMarks, score: 48, fromApi: true };
  const rect = hit.boundingBox || hit;
  const mapped = normalizeRect(rect, frame);
  if (!mapped) return null;
  return { ...mapped, score: 42, fromApi: true };
}

function boxFromLandmarks(landmarks, img) {
  const points = [];
  for (const mark of landmarks) {
    const locs = Array.isArray(mark.locations) ? mark.locations : mark.x != null ? [mark] : [];
    for (const pt of locs) {
      const mapped = normalizePoint(pt, img);
      if (mapped) points.push(mapped);
    }
  }
  if (points.length < 2) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 0.03 || h < 0.03) return null;
  const padX = w * 0.55;
  const padY = h * 0.75;
  const box = {
    x: clamp(minX - padX, 0, 1),
    y: clamp(minY - padY * 0.85, 0, 1),
    w: 0,
    h: 0,
  };
  box.w = clamp(maxX + padX, 0, 1) - box.x;
  box.h = clamp(maxY + padY * 0.55, 0, 1) - box.y;
  return validBox(box) ? box : null;
}

function normalizePoint(pt, img) {
  const x = Number(pt.x);
  const y = Number(pt.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const trials = [
    [img.naturalWidth, img.naturalHeight],
    [img.clientWidth, img.clientHeight],
    [img.width, img.height],
  ];
  for (const [sx, sy] of trials) {
    if (!sx || !sy) continue;
    const nx = x / sx;
    const ny = y / sy;
    if (nx >= -0.05 && ny >= -0.05 && nx <= 1.08 && ny <= 1.08) {
      return { x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) };
    }
  }
  return null;
}

function normalizeRect(rect, img) {
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null;
  const trials = [
    [img.naturalWidth, img.naturalHeight],
    [img.clientWidth, img.clientHeight],
    [img.width, img.height],
  ];
  for (const [sx, sy] of trials) {
    if (!sx || !sy) continue;
    const box = { x: x / sx, y: y / sy, w: width / sx, h: height / sy };
    if (box.x < -0.05 || box.y < -0.05 || box.x + box.w > 1.08 || box.y + box.h > 1.08) continue;
    if (box.w < 0.035 || box.h < 0.04 || box.w > 0.86 || box.h > 0.9) continue;
    return {
      x: clamp(box.x, 0, 1),
      y: clamp(box.y, 0, 1),
      w: clamp(box.w, 0.03, 1 - clamp(box.x, 0, 1)),
      h: clamp(box.h, 0.03, 1 - clamp(box.y, 0, 1)),
    };
  }
  return null;
}

async function detectByFeatures(img) {
  const frame = await rasterize(img);
  if (!frame) return [];
  const { gray, width, height, skin } = frame;
  const integrals = integralImage(gray, width, height);
  const hits = [];
  const minDim = Math.min(width, height);
  for (let win = Math.max(22, Math.round(minDim * 0.1)); win <= minDim * 0.62; win = Math.round(win * 1.22)) {
    const fh = Math.round(win * 1.28);
    if (fh > height) break;
    const step = Math.max(2, Math.round(win * 0.16));
    for (let y = 0; y <= height - fh; y += step) {
      for (let x = 0; x <= width - win; x += step) {
        const stats = windowStats(integrals, x, y, win, fh);
        if (stats.variance < 140 || stats.variance > 6200) continue;
        const score = faceScore(integrals, x, y, win, fh, skin);
        if (score < FACE_SCORE_MIN) continue;
        hits.push({
          x: x / width,
          y: y / height,
          w: win / width,
          h: fh / height,
          score,
          px: x,
          py: y,
          pw: win,
          ph: fh,
        });
      }
    }
  }
  const refined = nms(hits, 12, 0.28).map((hit) => refineHit(integrals, skin, width, height, hit));
  return nms(
    refined.filter((hit) => hit.score >= FACE_SCORE_MIN && validBox(hit)),
    MAX_MODELS,
    0.3,
  );
}

function refineHit(integrals, skin, width, height, hit) {
  let best = hit;
  for (const scale of [0.9, 1, 1.08]) {
    const pw = Math.round(hit.pw * scale);
    const ph = Math.round(hit.ph * scale);
    for (let dy = -3; dy <= 3; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        const x = hit.px + dx;
        const y = hit.py + dy;
        if (x < 0 || y < 0 || x + pw > width || y + ph > height) continue;
        const stats = windowStats(integrals, x, y, pw, ph);
        if (stats.variance < 140 || stats.variance > 6200) continue;
        const score = faceScore(integrals, x, y, pw, ph, skin);
        if (score > best.score) {
          best = {
            x: x / width,
            y: y / height,
            w: pw / width,
            h: ph / height,
            score,
            px: x,
            py: y,
            pw,
            ph,
          };
        }
      }
    }
  }
  return best;
}

function faceScore(integrals, x, y, w, h, skin) {
  const mean = (x0, y0, x1, y1) => rectMean(integrals, x0, y0, x1, y1);
  const leftEye = mean(x + w * 0.12, y + h * 0.22, x + w * 0.44, y + h * 0.48);
  const rightEye = mean(x + w * 0.56, y + h * 0.22, x + w * 0.88, y + h * 0.48);
  const bridge = mean(x + w * 0.4, y + h * 0.24, x + w * 0.6, y + h * 0.4);
  const cheeks = mean(x + w * 0.16, y + h * 0.5, x + w * 0.84, y + h * 0.7);
  const forehead = mean(x + w * 0.22, y + h * 0.05, x + w * 0.78, y + h * 0.2);
  const mouth = mean(x + w * 0.3, y + h * 0.7, x + w * 0.7, y + h * 0.9);
  const brow = mean(x + w * 0.18, y + h * 0.14, x + w * 0.82, y + h * 0.26);
  const eyeMean = (leftEye + rightEye) / 2;
  const eyeDark = cheeks - eyeMean;
  const mouthDark = cheeks - mouth;
  const browDark = forehead - eyeMean;
  const bridgeLight = bridge - eyeMean;
  const symmetry = 1 - Math.min(1, Math.abs(leftEye - rightEye) / Math.max(8, cheeks));
  if (eyeDark < 6.5) return 0;
  if (leftEye >= cheeks - 2 || rightEye >= cheeks - 2) return 0;
  if (symmetry < 0.62) return 0;
  if (bridgeLight < 1.2) return 0;
  if (mouthDark < 1.5) return 0;
  const skinBoost = skinRatio(skin, integrals.width, x, y, w, h);
  const tooSandy = skinBoost > 0.82 && eyeDark < 9;
  if (tooSandy) return 0;
  return eyeDark * 1.35 + mouthDark * 0.5 + browDark * 0.25 + bridgeLight * 0.4 + symmetry * 10 + skinBoost * 4;
}

function skinRatio(skin, width, x, y, w, h) {
  if (!skin) return 0;
  const x0 = Math.max(0, Math.floor(x + w * 0.2));
  const y0 = Math.max(0, Math.floor(y + h * 0.18));
  const x1 = Math.min(width, Math.ceil(x + w * 0.8));
  const y1 = Math.min(skin.length / width, Math.ceil(y + h * 0.78));
  let hits = 0;
  let total = 0;
  for (let py = y0; py < y1; py += 2) {
    const row = py * width;
    for (let px = x0; px < x1; px += 2) {
      total += 1;
      if (skin[row + px]) hits += 1;
    }
  }
  return total ? hits / total : 0;
}

function windowStats(integrals, x, y, w, h) {
  const area = w * h;
  const sum = rectSum(integrals.sat, integrals.stride, x, y, x + w, y + h);
  const sum2 = rectSum(integrals.sat2, integrals.stride, x, y, x + w, y + h);
  const mean = sum / area;
  return { mean, variance: sum2 / area - mean * mean };
}

function integralImage(gray, width, height) {
  const stride = width + 1;
  const sat = new Float64Array(stride * (height + 1));
  const sat2 = new Float64Array(stride * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let row = 0;
    let row2 = 0;
    for (let x = 1; x <= width; x += 1) {
      const v = gray[(y - 1) * width + (x - 1)];
      row += v;
      row2 += v * v;
      const i = y * stride + x;
      sat[i] = sat[(y - 1) * stride + x] + row;
      sat2[i] = sat2[(y - 1) * stride + x] + row2;
    }
  }
  return { sat, sat2, stride, width, height };
}

function rectSum(sat, stride, x0, y0, x1, y1) {
  const a = Math.max(0, Math.min(stride - 1, Math.round(x0)));
  const b = Math.max(0, Math.min(Math.floor(sat.length / stride) - 1, Math.round(y0)));
  const c = Math.max(a + 1, Math.min(stride - 1, Math.round(x1)));
  const d = Math.max(b + 1, Math.min(Math.floor(sat.length / stride) - 1, Math.round(y1)));
  return sat[d * stride + c] - sat[b * stride + c] - sat[d * stride + a] + sat[b * stride + a];
}

function rectMean(integrals, x0, y0, x1, y1) {
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  return rectSum(integrals.sat, integrals.stride, x0, y0, x1, y1) / (w * h);
}

async function rasterize(img) {
  try {
    const source = await loadProbe(img);
    const max = SCAN_SIZE;
    const scale = Math.min(1, max / Math.max(source.naturalWidth, source.naturalHeight));
    const width = Math.max(32, Math.round(source.naturalWidth * scale));
    const height = Math.max(32, Math.round(source.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const gray = new Float32Array(width * height);
    const skin = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      const r = pixels[p];
      const g = pixels[p + 1];
      const b = pixels[p + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      skin[i] = isSkin(r, g, b) ? 1 : 0;
    }
    return { gray, width, height, skin };
  } catch {
    return null;
  }
}

function isSkin(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const hsvS = max ? (max - min) / max : 0;
  return (
    y > 40 &&
    y < 240 &&
    cb > 80 &&
    cb < 124 &&
    cr > 135 &&
    cr < 172 &&
    r > 60 &&
    r >= g - 8 &&
    g >= b - 18 &&
    hsvS > 0.08 &&
    hsvS < 0.68 &&
    r - g > 4
  );
}

function loadProbe(img) {
  const src = img.currentSrc || img.src || "";
  if (!/^https?:/i.test(src)) return img;
  return new Promise((resolve) => {
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => resolve(probe.naturalWidth ? probe : img);
    probe.onerror = () => resolve(img);
    probe.src = src;
  });
}

function nms(boxes, limit = 5, overlap = 0.38) {
  const ranked = [...boxes].sort((a, b) => (b.score || b.w * b.h) - (a.score || a.w * a.h));
  const kept = [];
  for (const box of ranked) {
    if (kept.some((item) => iou(item, box) > overlap)) continue;
    kept.push(box);
    if (kept.length >= limit) break;
  }
  return kept;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  const union = a.w * a.h + b.w * b.h - inter;
  return union ? inter / union : 0;
}

function expand(box, pad = 0.16) {
  const w = Math.min(0.74, box.w * (1 + pad * 1.4));
  const h = Math.min(0.84, box.h * (1 + pad * 1.6));
  const x = clamp(box.x + box.w / 2 - w / 2, 0, 1 - w);
  const y = clamp(box.y + box.h / 2 - h / 2 - box.h * 0.02, 0, 1 - h);
  return { x, y, w, h, score: box.score || 0, fromApi: Boolean(box.fromApi) };
}

function validBox(box) {
  return box && box.w > 0.035 && box.h > 0.04 && box.w < 0.86 && box.h < 0.9 && box.x >= 0 && box.y >= 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function enqueue(fn) {
  return new Promise((resolve) => {
    queue.push(async () => {
      try {
        resolve(await fn());
      } catch {
        resolve([]);
      }
    });
    pump();
  });
}

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  Promise.resolve(job()).finally(() => {
    busy = false;
    if (queue.length) window.setTimeout(pump, 16);
  });
}
