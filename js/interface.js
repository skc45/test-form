export const INTERFACE_KEY = "aperture-interface";

export const SERVERS = [
  { id: "catalog", label: "Folder catalog", hint: "Plates in the open catalog" },
  { id: "demo", label: "Demo plates", hint: "Photographica volume" },
  { id: "canvas", label: "Canvasboard", hint: "Posted plates" },
  { id: "eth", label: "Ethereum shard", hint: "Attached NFTs" },
];

export const ENGINES = [
  { id: "off", label: "Unplugged", hint: "This server is not searchable" },
  { id: "titles", label: "Titles & places", hint: "Title, place, photographer" },
  { id: "captions", label: "Captions", hint: "Written captions" },
  { id: "files", label: "Filenames", hint: "File and plate ids" },
  { id: "pointers", label: "NFT pointers", hint: "eths: and 0x addresses" },
];

const ENGINE_IDS = new Set(ENGINES.map((item) => item.id));

export function defaultPlugs() {
  return {
    catalog: "titles",
    demo: "titles",
    canvas: "captions",
    eth: "pointers",
  };
}

export function engineById(id) {
  return ENGINES.find((item) => item.id === id) || ENGINES[0];
}

export function serverById(id) {
  return SERVERS.find((item) => item.id === id) || SERVERS[0];
}

export function isPlugged(engineId) {
  return Boolean(engineId) && engineId !== "off" && ENGINE_IDS.has(engineId);
}

export function normalizePlugs(raw) {
  const base = defaultPlugs();
  const plugs = raw && typeof raw === "object" ? raw.plugs || raw : {};
  const next = {};
  for (const server of SERVERS) {
    const engine = String(plugs?.[server.id] || base[server.id]);
    next[server.id] = ENGINE_IDS.has(engine) ? engine : base[server.id];
  }
  return next;
}

export function fieldsForEngine(engineId, record) {
  const value = (key) => String(record?.[key] ?? "");
  if (engineId === "titles") {
    return [value("title"), value("location"), value("photographer"), value("place")];
  }
  if (engineId === "captions") return [value("caption"), value("description")];
  if (engineId === "files") return [value("file"), value("id")];
  if (engineId === "pointers") return [value("pointer"), value("address"), value("tokenId")];
  return [];
}

export function matchRecord(engineId, record, query) {
  if (!isPlugged(engineId)) return false;
  const q = String(query || "").trim().toLowerCase();
  const hay = fieldsForEngine(engineId, record).join(" ").toLowerCase();
  if (!q) return Boolean(hay.trim());
  return hay.includes(q);
}

export function recordFromPhoto(photo, server) {
  return {
    server,
    id: photo?.id || "",
    title: photo?.title || "",
    location: photo?.location || "",
    photographer: photo?.photographer || "",
    caption: photo?.caption || "",
    file: photo?.file || photo?.id || "",
    src: photo?.thumb || photo?.src || photo?.hero || "",
    pointer: photo?.pointer || "",
    address: photo?.address || "",
    tokenId: photo?.tokenId || "",
    photo,
  };
}

export function recordFromPost(post) {
  return {
    server: "canvas",
    id: `canvas/${post?.file || ""}`,
    title: post?.title || "",
    location: "",
    photographer: "",
    caption: post?.caption || "",
    file: post?.file || "",
    src: post?.src || "",
    pointer: post?.pointer || "",
    address: post?.address || "",
    tokenId: post?.tokenId || "",
    post,
  };
}

export function recordFromEth(item) {
  return {
    server: "eth",
    id: `eth/${item?.address || item?.pointer || ""}`,
    title: item?.nft?.name || item?.title || "",
    location: item?.address || "",
    photographer: "Ethereum NFT",
    caption: item?.nft?.description || "",
    file: item?.file || "",
    src: item?.src || "",
    pointer: item?.pointer || "",
    address: item?.address || "",
    tokenId: item?.tokenId || item?.nft?.token_id || "",
    item,
  };
}

export function loadLocalPlugs() {
  try {
    return normalizePlugs(JSON.parse(localStorage.getItem(INTERFACE_KEY) || "{}"));
  } catch {
    return defaultPlugs();
  }
}

export async function restorePlugs() {
  if (window.ApertureAndroid?.loadInterface) {
    try {
      const raw = window.ApertureAndroid.loadInterface();
      if (raw) {
        const plugs = normalizePlugs(JSON.parse(raw));
        localStorage.setItem(INTERFACE_KEY, JSON.stringify({ plugs }));
        return plugs;
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const response = await fetch("/api/interface", { headers: { Accept: "application/json" } });
    if (response.ok) {
      const data = await response.json();
      const plugs = normalizePlugs(data);
      localStorage.setItem(INTERFACE_KEY, JSON.stringify({ plugs }));
      return plugs;
    }
  } catch {
    /* static host */
  }
  return loadLocalPlugs();
}

export async function savePlugs(plugs) {
  const next = normalizePlugs({ plugs });
  const body = JSON.stringify({ plugs: next });
  try {
    localStorage.setItem(INTERFACE_KEY, body);
  } catch {
    /* quota */
  }
  if (window.ApertureAndroid?.saveInterface) {
    window.ApertureAndroid.saveInterface(body);
    return next;
  }
  try {
    await fetch("/api/interface", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
  } catch {
    /* browser-only */
  }
  return next;
}
