export const SKIN_KEY = "aperture.skin";
export const DEFAULT_ID = "aero";

const FIELDS = [
  "skyTop",
  "skyMid",
  "skyDeep",
  "glow",
  "haze",
  "ink",
  "muted",
  "accent",
  "accentDeep",
  "glass",
];

export const PRESETS = [
  {
    id: "aero",
    name: "Aero sky",
    skyTop: "#7ec8f5",
    skyMid: "#3d8fd4",
    skyDeep: "#1c5fa8",
    glow: "#9fe7ff",
    haze: "#c8ffe4",
    ink: "#14324c",
    muted: "#3f6888",
    accent: "#4eb3f2",
    accentDeep: "#1f7fd4",
    glass: "#badcf8",
    sheen: 0.55,
  },
  {
    id: "midnight",
    name: "Midnight",
    skyTop: "#4a6a9a",
    skyMid: "#243656",
    skyDeep: "#0e1624",
    glow: "#8eb4ff",
    haze: "#c9b8ff",
    ink: "#e8eef8",
    muted: "#9aadc4",
    accent: "#7eb6ff",
    accentDeep: "#3d6fbf",
    glass: "#3a4f72",
    sheen: 0.42,
  },
  {
    id: "forest",
    name: "Forest",
    skyTop: "#9fd6b8",
    skyMid: "#3f8a62",
    skyDeep: "#1c4a34",
    glow: "#d4ffc4",
    haze: "#b8ffe8",
    ink: "#143328",
    muted: "#3d6a56",
    accent: "#6bcf8e",
    accentDeep: "#2e8a58",
    glass: "#c5e6d2",
    sheen: 0.52,
  },
  {
    id: "sunset",
    name: "Sunset",
    skyTop: "#ffc39a",
    skyMid: "#e07858",
    skyDeep: "#7a2e3c",
    glow: "#ffe0a3",
    haze: "#ffb3c9",
    ink: "#3a1c1c",
    muted: "#8a4a4a",
    accent: "#ff8a5b",
    accentDeep: "#d4523c",
    glass: "#f3c4b0",
    sheen: 0.5,
  },
  {
    id: "graphite",
    name: "Graphite",
    skyTop: "#c5c9d2",
    skyMid: "#6b7380",
    skyDeep: "#2a2e36",
    glow: "#e8eef6",
    haze: "#c8d0dc",
    ink: "#1a1d22",
    muted: "#5a6270",
    accent: "#9aa4b5",
    accentDeep: "#4d5563",
    glass: "#d5dae3",
    sheen: 0.48,
  },
  {
    id: "orchid",
    name: "Orchid",
    skyTop: "#d2b4f0",
    skyMid: "#7a4db8",
    skyDeep: "#3a1f66",
    glow: "#f0c8ff",
    haze: "#c8b4ff",
    ink: "#241436",
    muted: "#6a5088",
    accent: "#c084fc",
    accentDeep: "#7c3aed",
    glass: "#dcc6f5",
    sheen: 0.5,
  },
  {
    id: "honey",
    name: "Honey",
    skyTop: "#ffe08a",
    skyMid: "#d4a017",
    skyDeep: "#6b4a08",
    glow: "#fff3c0",
    haze: "#ffd580",
    ink: "#3a2a0a",
    muted: "#7a6230",
    accent: "#e8b923",
    accentDeep: "#b8860b",
    glass: "#f3e0a8",
    sheen: 0.58,
  },
];

let current = clone(PRESETS[0]);

export function defaultSkin() {
  return clone(PRESETS[0]);
}

export function presetById(id) {
  return PRESETS.find((item) => item.id === id) || null;
}

export function getSkin() {
  return clone(current);
}

export function parseHex(value, fallback = "#1c5fa8") {
  const raw = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const [r, g, b] = raw.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

export function normalizeSkin(raw) {
  const base = defaultSkin();
  const data = raw && typeof raw === "object" ? raw : {};
  const out = { ...base };
  for (const key of FIELDS) out[key] = parseHex(data[key], base[key]);
  const sheen = Number(data.sheen);
  out.sheen = Number.isFinite(sheen) ? Math.min(1, Math.max(0, sheen)) : base.sheen;
  const preset = matchingPreset(out);
  if (preset) {
    out.id = preset.id;
    out.name = preset.name;
  } else {
    out.id = "custom";
    out.name = "Custom";
  }
  return out;
}

export function matchingPreset(skin) {
  const next = normalizeCompare(skin);
  return PRESETS.find((item) => fieldsEqual(item, next)) || null;
}

export function cssVars(skin) {
  const next = normalizeSkin(skin);
  const sheen = next.sheen;
  const night = mix(next.skyDeep, "#000000", 0.42);
  const glassHi = alpha("#ffffff", 0.28 + sheen * 0.34);
  const glassMid = alpha(next.glass, 0.16 + sheen * 0.16);
  const glassLo = alpha(next.accentDeep, 0.18 + sheen * 0.12);
  const glossMid = mix(next.glass, "#ffffff", 0.62);
  const glossCut = mix(next.accent, next.glass, 0.35);
  const glossLo = mix(next.accent, next.glass, 0.18);
  const accentHi = mix(next.accent, "#ffffff", 0.55);
  const accentHover = mix(next.accent, "#ffffff", 0.72);
  return {
    "--bg": next.skyDeep,
    "--bg-2": alpha(next.glow, 0.28),
    "--ink": next.ink,
    "--muted": next.muted,
    "--line": alpha("#ffffff", 0.55),
    "--gold": next.accent,
    "--gold-2": mix(next.accent, "#ffffff", 0.72),
    "--accent": next.accent,
    "--accent-deep": next.accentDeep,
    "--accent-soft": alpha(next.accent, 0.28),
    "--accent-bar": `linear-gradient(90deg, ${accentHi}, ${next.accent} 55%, ${next.accentDeep})`,
    "--accent-gloss": `linear-gradient(180deg, ${accentHi} 0%, ${next.accent} 46%, ${next.accentDeep} 52%, ${mix(next.accent, next.accentDeep, 0.35)} 100%)`,
    "--accent-gloss-hover": `linear-gradient(180deg, ${accentHover} 0%, ${mix(next.accent, "#ffffff", 0.28)} 46%, ${next.accentDeep} 52%, ${next.accent} 100%)`,
    "--glow": next.glow,
    "--haze": next.haze,
    "--sky-mid": next.skyMid,
    "--sky": `linear-gradient(180deg, ${next.skyTop} 0%, ${next.skyMid} 42%, ${next.skyDeep} 72%, ${night} 100%)`,
    "--chrome": next.skyMid,
    "--veil": alpha(next.skyDeep, 0.32),
    "--glass": `linear-gradient(180deg, ${glassHi} 0%, ${glassMid} 42%, ${glassLo} 100%)`,
    "--gloss": `linear-gradient(180deg, #ffffff 0%, ${glossMid} 46%, ${glossCut} 48%, ${glossLo} 100%)`,
    "--shadow": `0 18px 50px ${alpha(next.skyDeep, 0.28)}`,
    "--brand-mark": `radial-gradient(circle at 35% 30%, #fff, ${next.accent} 45%, ${next.accentDeep})`,
  };
}

export function swatchStyle(skin) {
  const next = normalizeSkin(skin);
  return [
    `background: radial-gradient(ellipse 80% 70% at 20% 15%, ${next.glow} 0%, transparent 55%),`,
    `radial-gradient(ellipse 70% 60% at 88% 18%, ${next.haze} 0%, transparent 50%),`,
    `linear-gradient(180deg, ${next.skyTop}, ${next.skyMid} 48%, ${next.skyDeep})`,
  ].join(" ");
}

export function patchSkin(skin, patch) {
  const next = { ...normalizeSkin(skin), ...patch };
  if (patch.ink && !patch.muted) next.muted = mix(patch.ink, next.skyMid, 0.42);
  if (patch.accent && !patch.accentDeep) next.accentDeep = mix(patch.accent, next.skyDeep, 0.4);
  return normalizeSkin(next);
}

export function applySkin(skin, { persist = true } = {}) {
  current = normalizeSkin(skin);
  const root = document.documentElement;
  const vars = cssVars(current);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.style.colorScheme = luminance(current.skyDeep) < 0.28 ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", current.skyMid);
  if (typeof window.ApertureAndroid?.setChrome === "function") {
    window.ApertureAndroid.setChrome(current.skyMid);
  }
  if (persist) void saveSkin(current);
  return current;
}

export function bootSkin() {
  try {
    const raw = localStorage.getItem(SKIN_KEY);
    if (raw) applySkin(JSON.parse(raw), { persist: false });
  } catch {
    /* keep CSS defaults */
  }
}

export async function restoreSkin() {
  if (window.ApertureAndroid?.loadSkin) {
    try {
      const raw = window.ApertureAndroid.loadSkin();
      if (raw) {
        applySkin(JSON.parse(raw), { persist: false });
        localStorage.setItem(SKIN_KEY, JSON.stringify(getSkin()));
        return getSkin();
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const response = await fetch("/api/skin", { headers: { Accept: "application/json" } });
    if (response.ok) {
      const data = await response.json();
      if (data?.skyMid || data?.id) {
        applySkin(data, { persist: false });
        localStorage.setItem(SKIN_KEY, JSON.stringify(getSkin()));
        return getSkin();
      }
    }
  } catch {
    /* static hosts have no skin API */
  }
  return getSkin();
}

export async function saveSkin(skin) {
  const next = normalizeSkin(skin);
  current = next;
  const body = JSON.stringify(next);
  try {
    localStorage.setItem(SKIN_KEY, body);
  } catch {
    /* quota */
  }
  if (window.ApertureAndroid?.saveSkin) {
    window.ApertureAndroid.saveSkin(body);
    return next;
  }
  try {
    await fetch("/api/skin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
  } catch {
    /* browser-only */
  }
  return next;
}

function clone(value) {
  return { ...value };
}

function normalizeCompare(skin) {
  const next = { ...defaultSkin(), ...skin };
  for (const key of FIELDS) next[key] = parseHex(next[key], defaultSkin()[key]);
  next.sheen = Number(Number(next.sheen).toFixed(2));
  return next;
}

function fieldsEqual(left, right) {
  return FIELDS.every((key) => parseHex(left[key]) === parseHex(right[key])) && Number(left.sheen).toFixed(2) === Number(right.sheen).toFixed(2);
}

function rgb(hex) {
  const value = parseHex(hex);
  return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
}

function alpha(hex, amount) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${amount})`;
}

function mix(left, right, amount) {
  const a = rgb(left);
  const b = rgb(right);
  const channel = (index) => Math.round(a[index] + (b[index] - a[index]) * amount);
  return `#${[channel(0), channel(1), channel(2)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
