export const VERSION = 1;
export const LABEL = "aperture-eth-shard-v1";
export const SECRET_KEY = "aperture-eth-secret";
export const LEDGER_KEY = "aperture-eth-ledger";
export const PREFIX = "eths:";
export const SHARD_COUNT = 64;

const te = new TextEncoder();

export function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function fromHex(value) {
  const hex = String(value || "").replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function randomBytes(size) {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

export async function checksumAddress(payload20) {
  const hex = toHex(payload20.subarray(0, 20));
  const digest = await sha256(te.encode(hex));
  let out = "0x";
  for (let i = 0; i < hex.length; i += 1) {
    const ch = hex[i];
    const nibble = (digest[i >> 1] >> (i % 2 ? 0 : 4)) & 0x0f;
    out += /[a-f]/.test(ch) && nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

export function normalizeAddress(value) {
  const hex = String(value || "")
    .trim()
    .replace(/^0x/i, "")
    .replace(/[^0-9a-f]/gi, "")
    .toLowerCase();
  if (hex.length !== 40) return "";
  return `0x${hex}`;
}

export async function catalogAddress(secret) {
  return checksumAddress((await sha256(concat(te.encode("eth-catalog"), secret))).subarray(0, 20));
}

export async function plateAddress(imageHash, secret) {
  return checksumAddress((await sha256(concat(imageHash, te.encode("eth-plate"), secret))).subarray(0, 20));
}

export async function shardId(imageHash, secret) {
  const digest = await sha256(concat(imageHash, te.encode("eth-shard"), secret));
  return ((digest[0] << 8) | digest[1]) % SHARD_COUNT;
}

export function shardPointer(shard, address) {
  return `${PREFIX}${Number(shard)}/${address}`;
}

export function tokenIdFromHash(imageHash) {
  return `0x${toHex(imageHash)}`;
}

export function nftTokenURI(address) {
  return `/api/eth/nft/${address || normalizeAddress(address)}`;
}

export function nftMetadata(cert) {
  const address = cert.address || "";
  return {
    name: cert.title || "Plate",
    description: `Aperture plate attached as an ERC-721 NFT on Ethereum shard ${cert.shard}.`,
    image: address ? `/media/eth/${address}` : "",
    external_url: cert.pointer || "",
    background_color: "1C5FA8",
    attributes: [
      { trait_type: "Shard", value: cert.shard },
      { trait_type: "Catalog", value: cert.catalogAddress || "" },
      { trait_type: "File", value: cert.file || "plate" },
    ],
    token_id: cert.tokenId || "",
  };
}

export function parsePointer(code) {
  let raw = String(code || "").trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith(PREFIX)) raw = raw.slice(PREFIX.length);
  let shard = null;
  let address = raw;
  const slash = raw.indexOf("/");
  if (slash >= 0 && /^\d+$/.test(raw.slice(0, slash))) {
    shard = Number(raw.slice(0, slash));
    address = raw.slice(slash + 1);
  }
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  if (shard != null && (shard < 0 || shard >= SHARD_COUNT)) return null;
  return {
    ok: true,
    kind: "aperture-eth-shard",
    chain: "ethereum",
    shard,
    address: normalized,
    pointer: shard == null ? normalized : shardPointer(shard, normalized),
  };
}

const localPlates = new Map();

export function rememberBytes(address, bytes) {
  const key = normalizeAddress(address);
  if (key && bytes) localPlates.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

export function loadBytes(address) {
  return localPlates.get(normalizeAddress(address)) || null;
}

export async function encodePlate(plain, meta, secret) {
  const bytes = plain instanceof Uint8Array ? plain : new Uint8Array(plain);
  const imageHash = await sha256(bytes);
  const address = await plateAddress(imageHash, secret);
  const catalog = await catalogAddress(secret);
  const shard = await shardId(imageHash, secret);
  const pointer = shardPointer(shard, address);
  const cert = {
    v: VERSION,
    kind: "aperture-eth-shard",
    chain: "ethereum",
    shard,
    address,
    catalogAddress: catalog,
    pointer,
    title: String(meta.title || meta.file || "Plate"),
    file: String(meta.file || "plate"),
    mime: String(meta.mime || "application/octet-stream"),
    imageHash: toHex(imageHash).toUpperCase(),
    encodedAt: new Date().toISOString().slice(0, 19),
    tx: {
      from: catalog,
      to: address,
      data: `0x${toHex(imageHash)}`,
    },
  };
  cert.standard = "erc721";
  cert.tokenId = tokenIdFromHash(imageHash);
  cert.tokenURI = nftTokenURI(address);
  cert.contract = catalog;
  cert.nft = nftMetadata(cert);
  rememberBytes(address, bytes);
  return { ok: true, certificate: cert, address, catalogAddress: catalog, shard, pointer };
}

export function loadSecret() {
  try {
    const raw = localStorage.getItem(SECRET_KEY);
    if (raw && /^[0-9a-f]{64}$/i.test(raw)) return fromHex(raw);
  } catch {
    /* quota */
  }
  const secret = randomBytes(32);
  try {
    localStorage.setItem(SECRET_KEY, toHex(secret));
  } catch {
    /* quota */
  }
  return secret;
}

export function loadLedger() {
  try {
    const data = JSON.parse(localStorage.getItem(LEDGER_KEY) || "{}");
    if (Array.isArray(data.plates)) return data;
  } catch {
    /* ignore */
  }
  return { plates: [] };
}

export function rememberCertificate(cert) {
  const ledger = loadLedger();
  const digest = String(cert.imageHash || "").toUpperCase();
  const plates = ledger.plates.filter((item) => String(item.imageHash || "").toUpperCase() !== digest);
  plates.unshift(cert);
  ledger.plates = plates.slice(0, 80);
  ledger.catalogAddress = cert.catalogAddress || ledger.catalogAddress || "";
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    /* quota */
  }
  return ledger;
}
