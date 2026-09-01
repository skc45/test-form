const cache = new Map();
const pending = new Map();
let faceDetector = null;
const queue = [];
let busy = false;

const SCAN_SIZE = 192;
const FACE_SCORE_MIN = 18;
const MAX_MODELS = 6;
const DEFAULT_FACE = { x: 0.18, y: 0.06, w: 0.64, h: 0.72, score: 1, assumed: true };

function assumedFace() {
  return { ...DEFAULT_FACE };
}

export function prefersBobbleMotion() {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  if (!host || !img || !prefersBobbleMotion()) return;
  const run = () => {
    void paintBobbles(host, img);
  };
  const start = () => waitForBox(img, run);
  if (img.complete && img.naturalWidth) start();
  else img.addEventListener("load", start, { once: true });
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
  fitted.forEach((box, index) => {
    const model = document.createElement("span");
    model.className = "bobble-model";
    model.style.setProperty("--bx", `${box.left}%`);
    model.style.setProperty("--by", `${box.top}%`);
    model.style.setProperty("--bw", `${box.width}%`);
    model.style.setProperty("--bh", `${box.height}%`);
    model.style.setProperty("--delay", `${(index * 0.37).toFixed(2)}s`);
    model.style.setProperty("--bobble-dur", `${(2.15 + (index % 4) * 0.28).toFixed(2)}s`);
    const cut = document.createElement("span");
    cut.className = "bobble-cut";
    cut.appendChild(cutImage(img, box));
    model.appendChild(cut);
    layer.appendChild(model);
  });
  host.classList.toggle("has-bobble", Boolean(fitted.length));
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
  const real = nms(apiFaces, MAX_MODELS, 0.32)
    .map((box) => expand(box, 0.1))
    .filter(validBox);
  if (real.length) return real;
  return [assumedFace()];
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

function expand(box, pad = 0.08) {
  const w = Math.min(0.62, box.w * (1 + pad));
  const h = Math.min(0.7, box.h * (1 + pad * 1.15));
  const x = clamp(box.x + box.w / 2 - w / 2, 0, 1 - w);
  const y = clamp(box.y + box.h / 2 - h / 2 - box.h * 0.03, 0, 1 - h);
  return { x, y, w, h, score: box.score || 0 };
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
