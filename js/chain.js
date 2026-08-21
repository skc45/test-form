export const DIFFICULTY = 3;
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
