const cache = new Map();
let faceDetector = null;
const queue = [];
let busy = false;

export function prefersBobbleMotion() {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export async function detectModels(img) {
  const src = img?.currentSrc || img?.src || "";
  if (!src || !img?.naturalWidth) return [];
  if (cache.has(src)) return cache.get(src);
  const models = await measureModels(img);
  cache.set(src, models);
  return models;
}

export function attachBobbles(host, img) {
  if (!host || !img || !prefersBobbleMotion()) return;
  const run = () => {
    void paintBobbles(host, img);
  };
  if (img.complete && img.naturalWidth) run();
  else img.addEventListener("load", run, { once: true });
}

async function paintBobbles(host, img) {
  const layer = layerFor(host);
  layer.replaceChildren();
  host.classList.remove("has-bobble");
  const models = await detectModels(img);
  if (!models.length || !host.isConnected) return;
  const fitted = displayBoxes(img, models);
  fitted.forEach((box, index) => {
    const model = document.createElement("span");
    model.className = "bobble-model";
    model.style.setProperty("--bx", `${box.left}%`);
    model.style.setProperty("--by", `${box.top}%`);
    model.style.setProperty("--bw", `${box.width}%`);
    model.style.setProperty("--bh", `${box.height}%`);
    model.style.setProperty("--delay", `${(index * 0.37).toFixed(2)}s`);
    model.style.setProperty("--bobble-dur", `${(2.45 + (index % 4) * 0.28).toFixed(2)}s`);
    const cut = document.createElement("span");
    cut.className = "bobble-cut";
    cut.style.backgroundImage = `url("${cssUrl(img.currentSrc || img.src)}")`;
    cut.style.backgroundSize = `${(100 / (box.width / 100)).toFixed(3)}% ${(100 / (box.height / 100)).toFixed(3)}%`;
    cut.style.backgroundPosition = `${(-(box.left / box.width) * 100).toFixed(3)}% ${(-(box.top / box.height) * 100).toFixed(3)}%`;
    model.appendChild(cut);
    layer.appendChild(model);
  });
  host.classList.add("has-bobble");
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

function cssUrl(src) {
  return String(src || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
    width: (box.w * w) / cw * 100,
    height: (box.h * h) / ch * 100,
  }));
}

async function measureModels(img) {
  const faces = await detectFaces(img);
  if (faces.length) return faces.map((box) => expand(box));
  return enqueue(() => detectSkinModels(img));
}

async function detectFaces(img) {
  const Detector = window.FaceDetector;
  if (!Detector) return [];
  try {
    if (!faceDetector) faceDetector = new Detector({ fastMode: true, maxDetectedFaces: 6 });
    const hits = await faceDetector.detect(img);
    return (hits || [])
      .map((hit) => {
        const rect = hit.boundingBox || hit;
        const w = img.naturalWidth || img.width || 1;
        const h = img.naturalHeight || img.height || 1;
        return {
          x: rect.x / w,
          y: rect.y / h,
          w: rect.width / w,
          h: rect.height / h,
        };
      })
      .filter(validBox);
  } catch {
    faceDetector = null;
    return [];
  }
}

async function detectSkinModels(img) {
  try {
    const source = await loadProbe(img);
    const max = 96;
    const scale = Math.min(1, max / Math.max(source.naturalWidth, source.naturalHeight));
    const width = Math.max(16, Math.round(source.naturalWidth * scale));
    const height = Math.max(16, Math.round(source.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(source, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const boxes = blobsFromSkin(pixels, width, height);
    return nms(boxes).map((box) => expand(box, 0.2));
  } catch {
    return [];
  }
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

function blobsFromSkin(data, width, height) {
  const seen = new Uint8Array(width * height);
  const boxes = [];
  const skinAt = (index) => {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return y > 42 && y < 245 && cb > 77 && cb < 127 && cr > 133 && cr < 173 && r > 58 && r >= g - 12 && r >= b - 8;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (seen[start] || !skinAt(start * 4)) continue;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % width;
        const cy = (cur / width) | 0;
        count += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const neighbors = [cur + 1, cur - 1, cur + width, cur - width];
        for (const next of neighbors) {
          if (next < 0 || next >= seen.length || seen[next]) continue;
          const nx = next % width;
          const ny = (next / width) | 0;
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          if (!skinAt(next * 4)) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const area = count / (width * height);
      const aspect = bw / bh;
      if (area < 0.01 || area > 0.42) continue;
      if (aspect < 0.38 || aspect > 1.75) continue;
      if (minY > height * 0.7) continue;
      const box = { x: minX / width, y: minY / height, w: bw / width, h: bh / height };
      if (validBox(box)) boxes.push(box);
    }
  }
  return boxes;
}

function nms(boxes, limit = 5) {
  const ranked = [...boxes].sort((a, b) => b.w * b.h - a.w * a.h);
  const kept = [];
  for (const box of ranked) {
    if (kept.some((item) => iou(item, box) > 0.38)) continue;
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
  const w = Math.min(0.72, box.w * (1 + pad));
  const h = Math.min(0.78, box.h * (1 + pad * 1.2));
  const x = Math.max(0, Math.min(1 - w, box.x + box.w / 2 - w / 2));
  const y = Math.max(0, Math.min(1 - h, box.y + box.h / 2 - h / 2 - box.h * 0.04));
  return { x, y, w, h };
}

function validBox(box) {
  return box.w > 0.04 && box.h > 0.05 && box.w < 0.9 && box.h < 0.9 && box.x >= 0 && box.y >= 0;
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
