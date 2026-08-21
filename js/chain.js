export const DIFFICULTY = 1;
export const GENESIS_PREV = "0".repeat(64);
export const CHAIN_KEY = "aperture.chain";

export function blockPayload(block) {
  return [
    Number(block?.height ?? 0),
    String(block?.prevHash || ""),
    String(block?.timestamp || ""),
    String(block?.title || ""),
    String(block?.caption || ""),
    String(block?.file || ""),
    String(block?.imageHash || ""),
    Number(block?.nonce ?? 0),
  ].join("|");
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashBlock(block) {
  return sha256Hex(blockPayload(block));
}

export async function mineBlock(block, difficulty = DIFFICULTY) {
  const prefix = "0".repeat(difficulty);
  const next = { ...block, nonce: Number(block?.nonce || 0) };
  for (;;) {
    const digest = await hashBlock(next);
    if (digest.startsWith(prefix)) {
      next.hash = digest;
      return next;
    }
    next.nonce += 1;
  }
}

export async function genesisBlock() {
  return mineBlock({
    height: 0,
    timestamp: "1970-01-01T00:00:00",
    title: "Aperture",
    caption: "Genesis plate",
    file: "",
    imageHash: GENESIS_PREV,
    prevHash: GENESIS_PREV,
    nonce: 0,
  });
}

export async function verifyChain(blocks, difficulty = DIFFICULTY) {
  if (!Array.isArray(blocks) || !blocks.length) return false;
  const prefix = "0".repeat(difficulty);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const digest = await hashBlock(block);
    if (digest !== block.hash || !digest.startsWith(prefix)) return false;
    if (index === 0) {
      if (Number(block.height) !== 0 || block.prevHash !== GENESIS_PREV) return false;
      continue;
    }
    const prev = blocks[index - 1];
    if (Number(block.height) !== Number(prev.height) + 1 || block.prevHash !== prev.hash) return false;
  }
  return true;
}

export function shortHash(value) {
  const hash = String(value || "");
  if (hash.length < 18) return hash || "—";
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export const VAULT_EXT = ".apc";
const MAGIC = [0x41, 0x50, 0x43, 0x48];

export function isApcName(name) {
  return /\.(apc|aplate)$/i.test(String(name || ""));
}

export function vaultName(block, filename) {
  const height = String(Number(block?.height ?? 0)).padStart(4, "0");
  const stem = String(filename || "plate")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-") || "plate";
  return `${height}-${stem}${VAULT_EXT}`;
}

export async function sha256HexBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function xorBytes(data, key) {
  const src = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(src.length);
  const len = key.length || 1;
  for (let i = 0; i < src.length; i += 1) out[i] = src[i] ^ key[i % len];
  return out;
}

export async function vaultKey(block) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(block?.hash || "")));
  return new Uint8Array(digest);
}

export async function lockBytes(plain, block, meta = {}) {
  const bytes = plain instanceof Uint8Array ? plain : new Uint8Array(plain);
  const header = JSON.stringify({
    v: 1,
    height: Number(block?.height ?? 0),
    file: String(meta.file || ""),
    title: String(meta.title || ""),
    caption: String(meta.caption || ""),
    imageHash: await sha256HexBytes(bytes),
    mime: String(meta.mime || "application/octet-stream"),
  });
  const headerBytes = new TextEncoder().encode(header);
  const cipher = xorBytes(bytes, await vaultKey(block));
  const out = new Uint8Array(9 + headerBytes.length + cipher.length);
  out.set(MAGIC, 0);
  out[4] = 1;
  new DataView(out.buffer).setUint32(5, headerBytes.length);
  out.set(headerBytes, 9);
  out.set(cipher, 9 + headerBytes.length);
  return out;
}

export function parseEnvelope(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 9) return null;
  if (MAGIC.some((value, index) => bytes[index] !== value) || bytes[4] !== 1) return null;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5);
  if (n < 2 || 9 + n > bytes.length) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + n)));
    if (!header || typeof header !== "object") return null;
    return { header, cipher: bytes.subarray(9 + n) };
  } catch {
    return null;
  }
}

export async function unlockBytes(data, blocks) {
  const parsed = parseEnvelope(data);
  if (!parsed || !(await verifyChain(blocks))) return null;
  const height = Number(parsed.header.height);
  const block = (blocks || []).find((item) => Number(item.height) === height);
  if (!block) return null;
  const plain = xorBytes(parsed.cipher, await vaultKey(block));
  if ((await sha256HexBytes(plain)) !== String(parsed.header.imageHash || "")) return null;
  return { header: parsed.header, bytes: plain };
}
