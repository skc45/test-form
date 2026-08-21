export const MAGIC = new Uint8Array([0x41, 0x50, 0x58, 0x52]);
export const VERSION = 1;
export const NONCE_SIZE = 16;
export const HASH_SIZE = 32;
export const CIPHER_LABEL = "aperture-xrp-cipher-v1";
export const MEMO_TYPE = "aperture/xrp";
export const SECRET_KEY = "aperture-xrp-secret";
export const LEDGER_KEY = "aperture-xrp-ledger";
export const XRP_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

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
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
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

export async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

export function xorSeal(plain, key) {
  const out = new Uint8Array(plain.length);
  const n = key.length || 1;
  for (let i = 0; i < plain.length; i += 1) out[i] = plain[i] ^ key[i % n];
  return out;
}

export function randomBytes(size) {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

export function b58encode(bytes, alphabet = XRP_ALPHABET) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = alphabet[0].repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += alphabet[digits[i]];
  return out;
}

export async function classicAddress(payload20) {
  const versioned = concat(new Uint8Array([0]), payload20.subarray(0, 20));
  const check = (await sha256(await sha256(versioned))).subarray(0, 4);
  return b58encode(concat(versioned, check));
}

export async function cipherKey(secret) {
  return sha256(concat(te.encode(CIPHER_LABEL), secret));
}

export async function plateAddress(imageHash, secret) {
  const payload = (await sha256(concat(imageHash, te.encode("xrpl-plate"), secret))).subarray(0, 20);
  return classicAddress(payload);
}

export async function catalogAddress(secret) {
  const payload = (await sha256(concat(te.encode("xrpl-catalog"), secret))).subarray(0, 20);
  return classicAddress(payload);
}

export function memoHex(text) {
  return toHex(te.encode(String(text || "")));
}

export function certificateJson(cert) {
  return JSON.stringify(cert, Object.keys(cert).sort());
}

export async function encodePlate(plain, meta, secret) {
  const bytes = plain instanceof Uint8Array ? plain : new Uint8Array(plain);
  const nonce = randomBytes(NONCE_SIZE);
  const imageHash = await sha256(bytes);
  const key = await sha256(concat(secret, nonce, imageHash));
  const cipher = xorSeal(bytes, key);
  const macKey = await cipherKey(secret);
  const tag = await hmacSha256(macKey, concat(nonce, imageHash, cipher));
  const envelope = concat(MAGIC, new Uint8Array([VERSION]), nonce, imageHash, tag, cipher);
  const address = await plateAddress(imageHash, secret);
  const cert = {
    v: 1,
    kind: "aperture-xrp",
    ledger: "xrpl",
    title: String(meta.title || meta.file || "Plate"),
    file: String(meta.file || "plate"),
    mime: String(meta.mime || "application/octet-stream"),
    imageHash: toHex(imageHash),
    cipherHash: toHex(await sha256(cipher)),
    address,
    tag: toHex(tag),
    encodedAt: new Date().toISOString().slice(0, 19),
  };
  const memoData = memoHex(certificateJson(cert));
  cert.memoType = memoHex(MEMO_TYPE);
  cert.memoFormat = memoHex("application/json");
  cert.memoData = memoData;
  cert.tx = {
    TransactionType: "Payment",
    Account: await catalogAddress(secret),
    Destination: address,
    Amount: "1",
    Memos: [
      {
        Memo: {
          MemoType: cert.memoType,
          MemoFormat: cert.memoFormat,
          MemoData: memoData,
        },
      },
    ],
  };
  return { ok: true, envelope, certificate: cert, address, catalogAddress: cert.tx.Account };
}

export async function decodePlate(envelope, secret) {
  const data = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
  if (data.length < 4 + 1 + NONCE_SIZE + HASH_SIZE * 2) return null;
  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1] || data[2] !== MAGIC[2] || data[3] !== MAGIC[3] || data[4] !== VERSION) {
    return null;
  }
  let offset = 5;
  const nonce = data.subarray(offset, offset + NONCE_SIZE);
  offset += NONCE_SIZE;
  const imageHash = data.subarray(offset, offset + HASH_SIZE);
  offset += HASH_SIZE;
  const tag = data.subarray(offset, offset + HASH_SIZE);
  offset += HASH_SIZE;
  const cipher = data.subarray(offset);
  const macKey = await cipherKey(secret);
  const expected = await hmacSha256(macKey, concat(nonce, imageHash, cipher));
  if (toHex(expected) !== toHex(tag)) return null;
  const key = await sha256(concat(secret, nonce, imageHash));
  const plain = xorSeal(cipher, key);
  if (toHex(await sha256(plain)) !== toHex(imageHash)) return null;
  return { plain, imageHash, nonce, tag };
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
    localStorage.setItem(SECRET_KEY, toHex(secret).toLowerCase());
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
  const plates = ledger.plates.filter((item) => item.imageHash !== cert.imageHash);
  plates.unshift(cert);
  ledger.plates = plates.slice(0, 80);
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    /* quota */
  }
  return ledger;
}
