#!/usr/bin/env python3
"""Aperture — full-screen image catalog desktop launcher.

Open a folder of photographs in the Aperture GUI:

    ./aperture
    ./aperture ~/Pictures
    ./aperture --install-launcher
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import posixpath
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from email import message_from_bytes
from email.policy import default as email_policy
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
CACHE_ENV = "APERTURE_CACHE_DIR"
MAX_RECENTS = 3
MAX_RECENT_SLIDES = 8
IMAGE_EXTS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
    ".avif",
    ".svg",
}

CHROME_CANDIDATES = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "msedge",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)


def cache_home() -> Path:
    override = os.environ.get(CACHE_ENV)
    if override:
        return Path(override)
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".cache"
    return base / "aperture"


def session_file() -> Path:
    return cache_home() / "session.json"


def posts_dir() -> Path:
    folder = cache_home() / "posts"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def post_public_fields(meta: dict, filename: str) -> dict:
    item = {
        "title": str(meta.get("title") or ""),
        "caption": str(meta.get("caption") or ""),
        "file": filename,
        "type": str(meta.get("type") or ""),
        "sentAt": str(meta.get("sentAt") or ""),
        "src": "/media/posts/" + quote(filename),
        "pointer": str(meta.get("pointer") or ""),
        "address": str(meta.get("address") or ""),
        "tokenId": str(meta.get("tokenId") or ""),
    }
    if meta.get("shard") is not None and str(meta.get("shard")) != "":
        try:
            item["shard"] = int(meta.get("shard"))
        except (TypeError, ValueError):
            item["shard"] = str(meta.get("shard"))
    return item


def list_posts() -> dict:
    folder = cache_home() / "posts"
    items: list[dict] = []
    if folder.is_dir():
        metas = sorted(folder.glob("*.json"), key=lambda path: path.name, reverse=True)
        for meta_path in metas:
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(meta, dict):
                continue
            filename = Path(str(meta.get("file") or "")).name
            image = (folder / filename).resolve()
            if not filename or not image.is_file() or not safe_under(folder.resolve(), image):
                continue
            items.append(post_public_fields(meta, filename))
    return {"ok": True, "count": len(items), "posts": items}


def attach_post_nft(body: dict) -> dict:
    filename = Path(str(body.get("file") or "")).name
    pointer = str(body.get("pointer") or "")
    address = str(body.get("address") or "")
    if not filename:
        return {"ok": False, "error": "missing post"}
    if not pointer and not address:
        return {"ok": False, "error": "missing nft"}
    folder = cache_home() / "posts"
    if not folder.is_dir():
        return {"ok": False, "error": "unknown post"}
    for meta_path in folder.glob("*.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(meta, dict):
            continue
        if Path(str(meta.get("file") or "")).name != filename:
            continue
        meta["pointer"] = pointer
        meta["address"] = address
        meta["tokenId"] = str(body.get("tokenId") or "")
        shard = body.get("shard")
        if shard is not None and str(shard) != "":
            try:
                meta["shard"] = int(shard)
            except (TypeError, ValueError):
                meta["shard"] = str(shard)
        meta["nftAttachedAt"] = datetime.now().isoformat(timespec="seconds")
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        return {"ok": True, "post": post_public_fields(meta, filename)}
    return {"ok": False, "error": "unknown post"}


SKIP_DIR_NAMES = {"blockchain", "xrp"}


def in_skip_dir(root: Path, path: Path) -> bool:
    try:
        return any(part.lower() in SKIP_DIR_NAMES for part in path.relative_to(root.resolve()).parts)
    except ValueError:
        return False


def chrome_profile_dir() -> Path:
    path = cache_home() / "chrome-profile"
    path.mkdir(parents=True, exist_ok=True)
    return path


class Runtime:
    """Mutable server state so recent plates can switch the open folder."""

    def __init__(self, folder: Path | None = None):
        self.folders: list[Path] = [folder.resolve()] if folder else []

    @property
    def folder(self) -> Path | None:
        return self.folders[0] if self.folders else None

    @folder.setter
    def folder(self, value: Path | None) -> None:
        self.folders = [value] if value else []


def folder_name_from_path(path: str) -> str:
    return Path(str(path)).name or str(path)


def recent_id(item) -> str:
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return ""
    return str(item.get("id") or item.get("path") or "").strip()


def as_recent(item, photo_count: int | None = None) -> dict | None:
    if isinstance(item, str):
        path = item.strip()
        if not path:
            return None
        return {
            "id": path,
            "path": path,
            "name": folder_name_from_path(path),
            "photoCount": int(photo_count or 0),
            "openedAt": "",
            "cover": "",
        }
    if not isinstance(item, dict):
        return None
    path = str(item.get("path") or item.get("id") or "").strip()
    ident = str(item.get("id") or path).strip()
    if not ident:
        return None
    try:
        count = int(item.get("photoCount") or photo_count or 0)
    except (TypeError, ValueError):
        count = int(photo_count or 0)
    return {
        "id": ident,
        "path": path or ident,
        "name": str(item.get("name") or folder_name_from_path(path or ident)),
        "photoCount": count,
        "openedAt": str(item.get("openedAt") or ""),
        "cover": str(item.get("cover") or ""),
        "covers": [
            str(src)
            for src in (item.get("covers") if isinstance(item.get("covers"), list) else [])
            if str(src).strip()
        ][:MAX_RECENT_SLIDES],
    }


def normalize_recents(raw) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for item in raw or []:
        entry = as_recent(item)
        if not entry or entry["id"] in seen:
            continue
        seen.add(entry["id"])
        out.append(entry)
        if len(out) == MAX_RECENTS:
            break
    return out


def upsert_recent(recents, entry: dict) -> list[dict]:
    next_item = as_recent(entry)
    if not next_item:
        return normalize_recents(recents)
    ident = next_item["id"]
    rest = [item for item in normalize_recents(recents) if item["id"] != ident]
    return [next_item, *rest][:MAX_RECENTS]


def decorate_recents(recents: list[dict]) -> list[dict]:
    out: list[dict] = []
    for index, item in enumerate(recents):
        try:
            count = int(item.get("photoCount") or 0)
        except (TypeError, ValueError):
            count = 0
        n = min(MAX_RECENT_SLIDES, count if count > 0 else MAX_RECENT_SLIDES)
        n = max(n, 1)
        covers = [f"/api/recent-cover?i={index}&p={plate}" for plate in range(n)]
        out.append({**item, "cover": covers[0], "covers": covers})
    return out


def images_in(folder: Path, limit: int = MAX_RECENT_SLIDES) -> list[Path]:
    if not folder.is_dir():
        return []
    found: list[Path] = []
    for path in sorted(folder.rglob("*"), key=lambda item: item.as_posix().lower()):
        if in_skip_dir(folder, path) or not is_image(path):
            continue
        found.append(path)
        if len(found) >= limit:
            break
    return found


def first_image_in(folder: Path) -> Path | None:
    found = images_in(folder, 1)
    return found[0] if found else None


def load_disk_session() -> dict:
    path = session_file()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
        data["recents"] = normalize_recents(data.get("recents"))
        return data
    except (OSError, json.JSONDecodeError):
        return {}


def save_disk_session(update: dict) -> dict:
    home = cache_home()
    home.mkdir(parents=True, exist_ok=True)
    payload = {**load_disk_session(), **update, "updatedAt": datetime.now().isoformat(timespec="seconds")}
    recents = normalize_recents(payload.get("recents"))
    folder = payload.get("lastFolder")
    if folder:
        recents = upsert_recent(
            recents,
            {
                "id": str(folder),
                "path": str(folder),
                "name": payload.get("lastFolderName") or folder_name_from_path(str(folder)),
                "photoCount": payload.get("photoCount") or 0,
                "openedAt": payload.get("updatedAt"),
            },
        )
    payload["recents"] = recents
    tmp = home / "session.json.tmp"
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(session_file())
    return payload


def clear_disk_session() -> None:
    path = session_file()
    if path.is_file():
        path.unlink()


SKIN_FIELDS = (
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
)


def skin_file() -> Path:
    return cache_home() / "skin.json"


def default_skin() -> dict:
    return {
        "id": "aero",
        "name": "Aero sky",
        "skyTop": "#7ec8f5",
        "skyMid": "#3d8fd4",
        "skyDeep": "#1c5fa8",
        "glow": "#9fe7ff",
        "haze": "#c8ffe4",
        "ink": "#14324c",
        "muted": "#3f6888",
        "accent": "#4eb3f2",
        "accentDeep": "#1f7fd4",
        "glass": "#badcf8",
        "sheen": 0.55,
    }


def parse_hex_color(value, fallback: str) -> str:
    raw = str(value or "").strip()
    if len(raw) == 7 and raw.startswith("#"):
        try:
            int(raw[1:], 16)
            return raw.lower()
        except ValueError:
            return fallback
    if len(raw) == 4 and raw.startswith("#"):
        try:
            int(raw[1:], 16)
            return "#" + "".join(ch * 2 for ch in raw[1:].lower())
        except ValueError:
            return fallback
    return fallback


def normalize_skin(data) -> dict:
    base = default_skin()
    if not isinstance(data, dict):
        return base
    out = dict(base)
    for key in SKIN_FIELDS:
        out[key] = parse_hex_color(data.get(key), base[key])
    try:
        sheen = float(data.get("sheen", base["sheen"]))
    except (TypeError, ValueError):
        sheen = base["sheen"]
    out["sheen"] = max(0.0, min(1.0, sheen))
    out["id"] = str(data.get("id") or "custom")[:32]
    out["name"] = str(data.get("name") or "Custom")[:48]
    return out


def load_skin() -> dict:
    path = skin_file()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return normalize_skin(data)
        except (OSError, json.JSONDecodeError):
            pass
    return default_skin()


def save_skin(data) -> dict:
    skin = normalize_skin(data)
    path = skin_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(skin, indent=2) + "\n", encoding="utf-8")
    return skin


INTERFACE_SERVERS = ("catalog", "demo", "canvas", "eth")
INTERFACE_ENGINES = ("off", "titles", "captions", "files", "pointers")


def interface_file() -> Path:
    return cache_home() / "interface.json"


def default_interface() -> dict:
    return {
        "ok": True,
        "plugs": {
            "catalog": "titles",
            "demo": "titles",
            "canvas": "captions",
            "eth": "pointers",
        },
    }


def normalize_interface(data) -> dict:
    base = default_interface()["plugs"]
    raw = data.get("plugs") if isinstance(data, dict) else {}
    if not isinstance(raw, dict):
        raw = {}
    plugs = {}
    for server in INTERFACE_SERVERS:
        engine = str(raw.get(server) or base[server])
        plugs[server] = engine if engine in INTERFACE_ENGINES else base[server]
    return {"ok": True, "plugs": plugs}


def load_interface() -> dict:
    path = interface_file()
    if path.is_file():
        try:
            return normalize_interface(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            pass
    return default_interface()


def save_interface(data) -> dict:
    payload = normalize_interface(data)
    path = interface_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


ETH_VERSION = 1
ETH_SHARD_COUNT = 64
ETH_PREFIX = "eths:"
ETH_MAX_PLATE = 25 * 1024 * 1024
ETH_LABEL = b"aperture-eth-shard-v1"
ETH_STANDARD = "erc721"


def eth_secret_file() -> Path:
    return cache_home() / "eth-secret"


def eth_ledger_file() -> Path:
    return cache_home() / "eth.json"


def eth_vault_dir() -> Path:
    path = cache_home() / "eth"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_eth_secret() -> bytes:
    path = eth_secret_file()
    if path.is_file():
        raw = path.read_bytes().strip()
        try:
            decoded = bytes.fromhex(raw.decode("ascii"))
            if len(decoded) == 32:
                return decoded
        except (UnicodeDecodeError, ValueError):
            pass
        if len(raw) == 32:
            return raw
    secret = os.urandom(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(secret.hex() + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return secret


def sha256_bytes(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def to_hex(data: bytes) -> str:
    return data.hex().upper()


def checksum_address(payload20: bytes) -> str:
    hex_lower = payload20[:20].hex()
    digest = sha256_bytes(hex_lower.encode("ascii"))
    chars: list[str] = []
    for index, ch in enumerate(hex_lower):
        nibble = (digest[index >> 1] >> (0 if index % 2 else 4)) & 0x0F
        chars.append(ch.upper() if ch.isalpha() and nibble >= 8 else ch)
    return "0x" + "".join(chars)


def normalize_address(value: str) -> str:
    hex_lower = "".join(ch for ch in str(value or "").strip().removeprefix("0x").removeprefix("0X") if ch in "0123456789abcdefABCDEF").lower()
    if len(hex_lower) != 40:
        return ""
    return "0x" + hex_lower


def catalog_address(secret: bytes | None = None) -> str:
    payload = sha256_bytes(b"eth-catalog" + (secret if secret is not None else load_eth_secret()))[:20]
    return checksum_address(payload)


def plate_address(image_hash: bytes, secret: bytes) -> str:
    payload = sha256_bytes(image_hash + b"eth-plate" + secret)[:20]
    return checksum_address(payload)


def shard_id(image_hash: bytes, secret: bytes) -> int:
    digest = sha256_bytes(image_hash + b"eth-shard" + secret)
    return ((digest[0] << 8) | digest[1]) % ETH_SHARD_COUNT


def shard_pointer(shard: int, address: str) -> str:
    return f"{ETH_PREFIX}{int(shard)}/{address}"


def token_id_from_hash(image_hash: bytes) -> str:
    return "0x" + image_hash.hex()


def nft_token_uri(address: str) -> str:
    return "/api/eth/nft/" + (str(address or "").strip() or normalize_address(address))


def nft_metadata(cert: dict) -> dict:
    address = str(cert.get("address") or "")
    shard = cert.get("shard")
    return {
        "name": str(cert.get("title") or "Plate"),
        "description": f"Aperture plate attached as an ERC-721 NFT on Ethereum shard {shard}.",
        "image": f"/media/eth/{address}" if address else "",
        "external_url": str(cert.get("pointer") or ""),
        "background_color": "1C5FA8",
        "attributes": [
            {"trait_type": "Shard", "value": shard},
            {"trait_type": "Catalog", "value": cert.get("catalogAddress") or ""},
            {"trait_type": "File", "value": cert.get("file") or "plate"},
        ],
        "token_id": str(cert.get("tokenId") or ""),
    }


def attach_nft(cert: dict, image_hash: bytes) -> dict:
    address = str(cert.get("address") or "")
    catalog = str(cert.get("catalogAddress") or catalog_address())
    cert["standard"] = ETH_STANDARD
    cert["tokenId"] = token_id_from_hash(image_hash)
    cert["tokenURI"] = nft_token_uri(address)
    cert["contract"] = catalog
    cert["nft"] = nft_metadata(cert)
    return cert


def parse_pointer(code: str) -> dict | None:
    raw = str(code or "").strip()
    if not raw:
        return None
    if raw.lower().startswith(ETH_PREFIX):
        raw = raw[len(ETH_PREFIX) :]
    shard = None
    address = raw
    slash = raw.find("/")
    if slash >= 0 and raw[:slash].isdigit():
        shard = int(raw[:slash])
        address = raw[slash + 1 :]
    normalized = normalize_address(address)
    if not normalized:
        return None
    if shard is not None and not 0 <= shard < ETH_SHARD_COUNT:
        return None
    return {
        "ok": True,
        "kind": "aperture-eth-shard",
        "chain": "ethereum",
        "shard": shard,
        "address": normalized,
        "pointer": normalized if shard is None else shard_pointer(shard, normalized),
    }


def vault_name(address: str) -> str:
    return normalize_address(address).removeprefix("0x") + ".eth"


def lookup_eth_certificate(address: str = "", image_hash: str = "") -> dict | None:
    digest = str(image_hash or "").upper()
    wanted = normalize_address(address)
    for item in load_eth_ledger().get("plates") or []:
        if not isinstance(item, dict):
            continue
        if wanted and normalize_address(str(item.get("address") or "")) == wanted:
            return item
        if digest and str(item.get("imageHash") or "").upper() == digest:
            return item
    return None


def open_eth_vault(address: str) -> Path | None:
    name = vault_name(address)
    if name == ".eth":
        return None
    path = eth_vault_dir() / name
    return path if path.is_file() else None


def resolve_shard(code: str) -> dict:
    located = parse_pointer(code)
    if not located:
        return {"ok": False, "error": "invalid shard"}
    cert = lookup_eth_certificate(located["address"])
    vault = open_eth_vault(located["address"])
    if not cert and vault is None:
        return {"ok": False, "error": "unknown shard"}
    if cert and located.get("shard") is not None and int(cert.get("shard") or -1) != located["shard"]:
        return {"ok": False, "error": "shard mismatch"}
    if cert:
        located["address"] = cert.get("address") or located["address"]
        located["shard"] = cert.get("shard")
        located["pointer"] = cert.get("pointer") or located["pointer"]
        located["catalogAddress"] = cert.get("catalogAddress") or catalog_address()
        located["imageHash"] = cert.get("imageHash") or ""
        located["tokenId"] = cert.get("tokenId") or ""
        located["tokenURI"] = cert.get("tokenURI") or nft_token_uri(located["address"])
        located["standard"] = cert.get("standard") or ETH_STANDARD
        located["contract"] = cert.get("contract") or located["catalogAddress"]
        located["nft"] = cert.get("nft") if isinstance(cert.get("nft"), dict) else nft_metadata(cert)
    located["certificate"] = cert or {}
    located["title"] = (cert or {}).get("title") or (located.get("nft") or {}).get("name") or "ETH NFT"
    located["file"] = (cert or {}).get("file") or "plate"
    located["mime"] = (cert or {}).get("mime") or "application/octet-stream"
    located["src"] = "/media/eth/" + located["address"] if vault is not None else ""
    located["decoded"] = vault is not None
    return located


def encode_plate(plain: bytes, title: str = "", filename: str = "plate", mime: str = "application/octet-stream") -> dict:
    if not plain or len(plain) > ETH_MAX_PLATE:
        return {"ok": False, "error": "invalid plate"}
    secret = load_eth_secret()
    image_hash = sha256_bytes(plain)
    address = plate_address(image_hash, secret)
    catalog = catalog_address(secret)
    shard = shard_id(image_hash, secret)
    pointer = shard_pointer(shard, address)
    cert = {
        "v": ETH_VERSION,
        "kind": "aperture-eth-shard",
        "chain": "ethereum",
        "shard": shard,
        "address": address,
        "catalogAddress": catalog,
        "pointer": pointer,
        "title": title or Path(filename).stem or "Plate",
        "file": Path(filename).name or "plate",
        "mime": mime or "application/octet-stream",
        "imageHash": to_hex(image_hash),
        "encodedAt": datetime.now().isoformat(timespec="seconds"),
        "tx": {"from": catalog, "to": address, "data": "0x" + image_hash.hex()},
    }
    attach_nft(cert, image_hash)
    vault = eth_vault_dir() / vault_name(address)
    vault.write_bytes(plain)
    remember_eth_certificate(cert)
    return {
        "ok": True,
        "certificate": cert,
        "address": address,
        "catalogAddress": catalog,
        "shard": shard,
        "pointer": pointer,
        "vault": vault.name,
    }


def remember_eth_certificate(cert: dict) -> dict:
    ledger = load_eth_ledger()
    digest = str(cert.get("imageHash") or "")
    plates = [item for item in ledger.get("plates") or [] if str(item.get("imageHash") or "") != digest]
    plates.insert(0, cert)
    ledger["plates"] = plates[:80]
    ledger["catalogAddress"] = cert.get("catalogAddress") or catalog_address()
    ledger["updatedAt"] = datetime.now().isoformat(timespec="seconds")
    path = eth_ledger_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    return ledger


def load_eth_ledger() -> dict:
    path = eth_ledger_file()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                plates = data.get("plates")
                if not isinstance(plates, list):
                    data["plates"] = []
                return data
        except (OSError, json.JSONDecodeError):
            pass
    return {"plates": [], "catalogAddress": catalog_address()}


def list_eth() -> dict:
    ledger = load_eth_ledger()
    plates = ledger.get("plates") or []
    return {
        "ok": True,
        "catalogAddress": ledger.get("catalogAddress") or catalog_address(),
        "count": len(plates),
        "standard": ETH_STANDARD,
        "plates": plates,
    }


def encode_open_folders(folders: list[Path]) -> dict:
    encoded = 0
    skipped = 0
    last = None
    for folder in folders:
        if not folder.is_dir():
            continue
        root = folder.resolve()
        for path in sorted(root.rglob("*"), key=lambda item: item.as_posix().lower()):
            if in_skip_dir(root, path) or not is_image(path):
                continue
            try:
                size = path.stat().st_size
                if size <= 0 or size > ETH_MAX_PLATE:
                    skipped += 1
                    continue
                plain = path.read_bytes()
            except OSError:
                skipped += 1
                continue
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            result = encode_plate(plain, path.stem, path.name, mime)
            if result.get("ok"):
                encoded += 1
                last = result
            else:
                skipped += 1
    payload = list_eth()
    payload["encoded"] = encoded
    payload["skipped"] = skipped
    if last:
        payload["address"] = last.get("address")
        payload["shard"] = last.get("shard")
        payload["pointer"] = last.get("pointer")
        payload["certificate"] = last.get("certificate")
    return payload


def remember_folder(folder: Path, photo_count: int | None = None) -> dict:
    payload = {
        "source": "folder",
        "lastFolder": str(folder),
        "lastFolderName": folder.name,
    }
    if photo_count is not None:
        payload["photoCount"] = photo_count
    return save_disk_session(payload)


def resolve_startup_folder(requested: Path | None) -> Path | None:
    if requested:
        folder = requested.expanduser().resolve()
        if not folder.is_dir():
            return folder
        remember_folder(folder)
        return folder
    last = load_disk_session().get("lastFolder")
    if not last:
        return None
    folder = Path(last).expanduser()
    if folder.is_dir():
        return folder.resolve()
    return None


def slug(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in (value or "folder"))
    parts = [part for part in cleaned.split("-") if part]
    return "-".join(parts) or "folder"


def is_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_EXTS


def safe_under(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def scan_folder(folder: Path) -> list[dict]:
    root = folder.resolve()
    photos: list[dict] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix().lower()):
        if in_skip_dir(root, path) or not is_image(path):
            continue
        rel = path.relative_to(root).as_posix()
        parent = path.parent.name if path.parent != root else root.name
        location = path.parent.relative_to(root).as_posix() if path.parent != root else root.name
        year = datetime.fromtimestamp(path.stat().st_mtime).year
        media = "/media/" + quote(rel)
        photos.append(
            {
                "id": rel,
                "title": path.stem,
                "photographer": root.name,
                "location": location,
                "year": year,
                "category": slug(parent),
                "src": media,
                "thumb": media,
                "hero": media,
                "local": True,
                "featured": False,
            }
        )
    if photos:
        photos[0]["featured"] = True
        for index, photo in enumerate(photos):
            photo["index"] = index
    return photos


def scan_folders(folders: list[Path]) -> list[dict]:
    photos: list[dict] = []
    multi = len(folders) > 1
    for index, folder in enumerate(folders):
        for photo in scan_folder(folder):
            photo["featured"] = False
            if multi:
                rel = photo["id"]
                photo["id"] = f"{index}/{rel}"
                media = "/media/" + quote(photo["id"])
                photo["src"] = media
                photo["thumb"] = media
                photo["hero"] = media
            photos.append(photo)
    if photos:
        photos[0]["featured"] = True
        for index, photo in enumerate(photos):
            photo["index"] = index
    return photos


class ApertureHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, runtime: Runtime | None = None, folder: Path | None = None, app_mode: bool = True, **kwargs):
        self.runtime = runtime or Runtime(folder)
        self.app_mode = app_mode
        super().__init__(*args, directory=str(ROOT), **kwargs)

    @property
    def folder(self) -> Path | None:
        return self.runtime.folder

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        sys.stderr.write("Aperture: " + (format % args) + "\n")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/catalog":
            photos = scan_folders(self.runtime.folders) if self.runtime.folders else []
            session = load_disk_session()
            folder_names = [item.name for item in self.runtime.folders]
            self._send_json(
                {
                    "folder": " + ".join(folder_names),
                    "path": str(self.folder) if self.folder else "",
                    "paths": [str(item) for item in self.runtime.folders],
                    "app": self.app_mode,
                    "cached": bool(session.get("lastFolder")),
                    "photos": photos,
                    "recents": decorate_recents(session.get("recents") or []),
                }
            )
            return
        if parsed.path == "/api/cache":
            session = load_disk_session()
            last = session.get("lastFolder")
            exists = bool(last and Path(last).expanduser().is_dir())
            recents = decorate_recents(session.get("recents") or [])
            self._send_json({**session, "exists": exists, "recents": recents})
            return
        if parsed.path == "/api/recent-cover":
            self._send_recent_cover(parsed.query)
            return
        if parsed.path == "/api/skin":
            self._send_json({"ok": True, **load_skin()})
            return
        if parsed.path == "/api/interface":
            self._send_json(load_interface())
            return
        if parsed.path == "/api/eth":
            self._send_json(list_eth())
            return
        if parsed.path == "/api/posts":
            self._send_json(list_posts())
            return
        if parsed.path.startswith("/media/posts/"):
            self._send_post_media(unquote(parsed.path[len("/media/posts/") :]))
            return
        if parsed.path == "/api/eth/shard":
            qs = parse_qs(parsed.query)
            code = str((qs.get("c") or qs.get("code") or qs.get("pointer") or [""])[0])
            located = resolve_shard(code)
            if not located.get("ok"):
                self.send_error(400, str(located.get("error") or "Invalid shard"))
                return
            self._send_json(located)
            return
        if parsed.path.startswith("/api/eth/nft/"):
            self._send_nft_metadata(unquote(parsed.path[len("/api/eth/nft/") :]))
            return
        if parsed.path.startswith("/media/eth/"):
            self._send_eth_media(unquote(parsed.path[len("/media/eth/") :]))
            return
        if parsed.path.startswith("/media/"):
            self._send_media(unquote(parsed.path[len("/media/") :]))
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/post":
            self._save_post()
            return
        if parsed.path == "/api/posts/nft":
            result = attach_post_nft(self._read_json())
            if not result.get("ok"):
                self.send_error(400, str(result.get("error") or "Could not attach NFT"))
                return
            self._send_json(result)
            return
        if parsed.path == "/api/skin":
            self._send_json({"ok": True, **save_skin(self._read_json())})
            return
        if parsed.path == "/api/interface":
            self._send_json(save_interface(self._read_json()))
            return
        if parsed.path == "/api/eth":
            self._encode_eth()
            return
        if parsed.path == "/api/eth/open":
            body = self._read_json()
            located = resolve_shard(str(body.get("pointer") or body.get("code") or body.get("address") or ""))
            if not located.get("ok"):
                self.send_error(400, str(located.get("error") or "Invalid shard"))
                return
            self._send_json(located)
            return
        if parsed.path != "/api/open":
            self.send_error(404, "Not found")
            return
        body = self._read_json()
        folders = self._folders_from_body(body)
        if not folders:
            self.send_error(404, "Folder not found")
            return
        photos = scan_folders(folders)
        if len(folders) == 1:
            remember_folder(folders[0], len(photos))
        self.runtime.folders = folders
        self._send_json(
            {
                "ok": True,
                "folder": " + ".join(item.name for item in folders),
                "path": str(folders[0]),
                "paths": [str(item) for item in folders],
                "photos": photos,
            }
        )

    def _folders_from_body(self, body: dict) -> list[Path]:
        raw_paths = body.get("paths")
        values: list[str] = []
        if isinstance(raw_paths, list):
            values = [str(item).strip() for item in raw_paths if str(item).strip()]
        elif str(body.get("path") or "").strip():
            values = [str(body.get("path")).strip()]
        folders: list[Path] = []
        seen: set[str] = set()
        for raw in values:
            folder = Path(raw).expanduser()
            if not folder.is_dir():
                continue
            resolved = folder.resolve()
            key = str(resolved)
            if key in seen:
                continue
            seen.add(key)
            folders.append(resolved)
        return folders

    def _save_post(self) -> None:
        content_type = self.headers.get("Content-Type") or ""
        if "multipart/form-data" not in content_type:
            self.send_error(400, "Expected multipart form")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 25 * 1024 * 1024:
            self.send_error(400, "Invalid post")
            return
        fields, files = self._parse_multipart(content_type, self.rfile.read(length))
        plate = files.get("plate") or files.get("file")
        if not plate:
            self.send_error(400, "Missing plate")
            return
        filename, payload, ctype = plate
        if not payload:
            self.send_error(400, "Empty plate")
            return
        posts = posts_dir()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:21]
        safe = "".join(ch if ch.isalnum() or ch in ".-_" else "-" for ch in filename) or "plate.jpg"
        image_path = posts / f"{stamp}-{safe}"
        image_path.write_bytes(payload)
        meta = {
            "title": fields.get("title") or "",
            "caption": fields.get("caption") or "",
            "file": image_path.name,
            "type": ctype,
            "sentAt": datetime.now().isoformat(timespec="seconds"),
        }
        (posts / f"{stamp}.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self._send_json(
            {
                "ok": True,
                "file": image_path.name,
                "title": meta["title"],
                "caption": meta["caption"],
                "sentAt": meta["sentAt"],
                "src": "/media/posts/" + quote(image_path.name),
                "type": ctype,
            }
        )

    def _parse_multipart(self, content_type: str, raw: bytes) -> tuple[dict, dict]:
        header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
        message = message_from_bytes(header + raw, policy=email_policy)
        fields: dict[str, str] = {}
        files: dict[str, tuple[str, bytes, str]] = {}
        parts = message.get_payload()
        if not isinstance(parts, list):
            return fields, files
        for part in parts:
            name = part.get_param("name", header="content-disposition")
            if not name:
                continue
            filename = part.get_filename()
            payload = part.get_payload(decode=True) or b""
            if filename:
                files[str(name)] = (
                    Path(str(filename)).name,
                    payload,
                    part.get_content_type() or "application/octet-stream",
                )
            else:
                fields[str(name)] = payload.decode("utf-8", "replace")
        return fields, files

    def _encode_eth(self) -> None:
        content_type = self.headers.get("Content-Type") or ""
        if "multipart/form-data" in content_type:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > ETH_MAX_PLATE + 4096:
                self.send_error(400, "Invalid plate")
                return
            fields, files = self._parse_multipart(content_type, self.rfile.read(length))
            plate = files.get("plate") or files.get("file")
            if not plate or not plate[1]:
                self.send_error(400, "Missing plate")
                return
            filename, payload, ctype = plate
            result = encode_plate(payload, fields.get("title") or Path(filename).stem, filename, ctype)
            if not result.get("ok"):
                self.send_error(400, str(result.get("error") or "Could not encode"))
                return
            self._send_json(result)
            return
        body = self._read_json()
        folders = self._folders_from_body(body) or list(self.runtime.folders)
        if not folders:
            self.send_error(404, "Folder not found")
            return
        self._send_json(encode_open_folders(folders))

    def _send_eth_media(self, rel: str) -> None:
        address = Path(rel).name
        vault = open_eth_vault(address)
        if not vault:
            self.send_error(404, "Not found")
            return
        plain = vault.read_bytes()
        cert = lookup_eth_certificate(address)
        ctype = str((cert or {}).get("mime") or mimetypes.guess_type(str((cert or {}).get("file") or ""))[0] or "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(plain)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(plain)

    def _send_post_media(self, rel: str) -> None:
        folder = cache_home() / "posts"
        name = Path(rel).name
        path = (folder / name).resolve()
        if not folder.is_dir() or not path.is_file() or not safe_under(folder.resolve(), path):
            self.send_error(404, "Not found")
            return
        self._send_image_file(path)

    def _send_nft_metadata(self, address: str) -> None:
        cert = lookup_eth_certificate(address)
        if not cert:
            self.send_error(404, "Unknown NFT")
            return
        meta = cert.get("nft") if isinstance(cert.get("nft"), dict) else nft_metadata(cert)
        self._send_json(
            {
                **meta,
                "ok": True,
                "standard": cert.get("standard") or ETH_STANDARD,
                "tokenId": cert.get("tokenId") or meta.get("token_id") or "",
                "tokenURI": cert.get("tokenURI") or nft_token_uri(cert.get("address") or address),
                "contract": cert.get("contract") or cert.get("catalogAddress") or catalog_address(),
                "address": cert.get("address") or normalize_address(address),
                "pointer": cert.get("pointer") or "",
            }
        )

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
            return data if isinstance(data, dict) else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}

    def _send_json(self, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_image_file(self, path: Path) -> None:
        if not is_image(path):
            self.send_error(404, "Not found")
            return
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=60")
        self.end_headers()
        self.wfile.write(data)

    def _send_recent_cover(self, query: str) -> None:
        qs = parse_qs(query)
        try:
            index = int((qs.get("i") or ["0"])[0])
            plate = int((qs.get("p") or ["0"])[0])
        except ValueError:
            self.send_error(404, "Not found")
            return
        recents = load_disk_session().get("recents") or []
        if index < 0 or index >= len(recents) or plate < 0:
            self.send_error(404, "Not found")
            return
        folder = Path(recents[index]["path"]).expanduser()
        covers = images_in(folder, plate + 1)
        if plate >= len(covers):
            self.send_error(404, "Not found")
            return
        self._send_image_file(covers[plate])

    def _send_media(self, rel: str) -> None:
        folders = self.runtime.folders
        if not folders:
            self.send_error(404, "No folder open")
            return
        rel = posixpath.normpath(rel).lstrip("/")
        folder = self.folder
        relative = rel
        if len(folders) > 1:
            head, sep, rest = rel.partition("/")
            if not sep:
                self.send_error(404, "Not found")
                return
            try:
                index = int(head)
            except ValueError:
                self.send_error(404, "Not found")
                return
            if index < 0 or index >= len(folders):
                self.send_error(404, "Not found")
                return
            folder = folders[index]
            relative = rest
        if not folder:
            self.send_error(404, "No folder open")
            return
        path = (folder / relative).resolve()
        if not safe_under(folder, path) or not is_image(path):
            self.send_error(404, "Not found")
            return
        self._send_image_file(path)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/cache":
            self.send_error(404, "Not found")
            return
        clear_disk_session()
        self._send_json({"ok": True, "cleared": True})


def find_chrome() -> str | None:
    for candidate in CHROME_CANDIDATES:
        if os.path.sep in candidate or candidate.endswith(".exe"):
            if Path(candidate).exists():
                return candidate
            continue
        found = shutil.which(candidate)
        if found:
            return found
    return None


def open_gui(url: str) -> subprocess.Popen | None:
    chrome = find_chrome()
    if chrome:
        profile = chrome_profile_dir()
        cmd = [
            chrome,
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            f"--app={url}",
        ]
        return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    webbrowser.open(url)
    return None


def install_launcher() -> Path:
    script = ROOT / "aperture"
    target_dir = Path.home() / ".local" / "share" / "applications"
    target_dir.mkdir(parents=True, exist_ok=True)
    desktop = target_dir / "aperture.desktop"
    icon = ROOT / "favicon.svg"
    desktop.write_text(
        "\n".join(
            [
                "[Desktop Entry]",
                "Type=Application",
                "Name=Aperture",
                "Comment=Full-screen image catalog",
                f"Exec={script} %F",
                f"Path={ROOT}",
                f"Icon={icon}",
                "Terminal=false",
                "Categories=Graphics;Viewer;Photography;",
                "MimeType=inode/directory;",
                "StartupNotify=true",
                "",
            ]
        ),
        encoding="utf-8",
    )
    desktop.chmod(0o644)
    script.chmod(0o755)
    (ROOT / "aperture.py").chmod(0o755)
    return desktop


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Open Aperture as a desktop image catalog.")
    parser.add_argument("folder", nargs="?", help="Image folder to open")
    parser.add_argument("--port", type=int, default=0, help="Port (0 = automatic)")
    parser.add_argument("--no-browser", action="store_true", help="Serve only; do not open a window")
    parser.add_argument("--forget", action="store_true", help="Clear the cached last folder and exit")
    parser.add_argument("--install-launcher", action="store_true", help="Install a desktop menu entry")
    return parser.parse_args(argv)


def run_server(folder: Path | None, port: int, runtime: Runtime | None = None) -> ThreadingHTTPServer:
    runtime = runtime or Runtime(folder)
    handler = partial(ApertureHandler, runtime=runtime, app_mode=True)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.install_launcher:
        path = install_launcher()
        print(f"Installed launcher: {path}")
        return 0
    if args.forget:
        clear_disk_session()
        print(f"Cleared cache {session_file()}")
        return 0

    requested = Path(args.folder).expanduser().resolve() if args.folder else None
    if requested and not requested.is_dir():
        print(f"Not a folder: {requested}", file=sys.stderr)
        return 2
    folder = resolve_startup_folder(requested)

    server = run_server(folder, args.port)
    host, bound = server.server_address
    query = "mode=app"
    url = f"http://{host}:{bound}/?{query}"
    print(f"Aperture {url}")
    if folder:
        count = len(scan_folder(folder))
        remember_folder(folder, count)
        print(f"Folder {folder} ({count} images)")

    proc = None
    if not args.no_browser:
        proc = open_gui(url)

    try:
        if proc is not None:
            proc.wait()
        else:
            while True:
                time.sleep(3600)
    except KeyboardInterrupt:
        print("\nClosing Aperture")
    finally:
        server.shutdown()
        server.server_close()
        if proc is not None and proc.poll() is None:
            proc.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
