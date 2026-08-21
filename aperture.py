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
import hmac
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


SKIP_DIR_NAMES = {"blockchain"}


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


XRP_MAGIC = b"APXR"
XRP_VERSION = 1
XRP_NONCE_SIZE = 16
XRP_HASH_SIZE = 32
XRP_CIPHER_LABEL = b"aperture-xrp-cipher-v1"
XRP_MEMO_TYPE = "aperture/xrp"
XRP_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"
XRP_MAX_PLATE = 25 * 1024 * 1024


def xrp_secret_file() -> Path:
    return cache_home() / "xrp-secret"


def xrp_ledger_file() -> Path:
    return cache_home() / "xrp.json"


def xrp_vault_dir() -> Path:
    path = cache_home() / "xrp"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_xrp_secret() -> bytes:
    path = xrp_secret_file()
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


def xor_seal(plain: bytes, key: bytes) -> bytes:
    if not key:
        return plain
    return bytes(value ^ key[index % len(key)] for index, value in enumerate(plain))


def b58encode(data: bytes, alphabet: str = XRP_ALPHABET) -> str:
    zeros = 0
    for byte in data:
        if byte == 0:
            zeros += 1
        else:
            break
    number = int.from_bytes(data, "big")
    chars: list[str] = []
    while number:
        number, rem = divmod(number, 58)
        chars.append(alphabet[rem])
    return alphabet[0] * zeros + "".join(reversed(chars or [alphabet[0]]))


def classic_address(payload20: bytes) -> str:
    versioned = b"\x00" + payload20[:20]
    check = sha256_bytes(sha256_bytes(versioned))[:4]
    return b58encode(versioned + check)


def cipher_key(secret: bytes) -> bytes:
    return sha256_bytes(XRP_CIPHER_LABEL + secret)


def plate_address(image_hash: bytes, secret: bytes) -> str:
    payload = sha256_bytes(image_hash + b"xrpl-plate" + secret)[:20]
    return classic_address(payload)


def catalog_address(secret: bytes | None = None) -> str:
    payload = sha256_bytes(b"xrpl-catalog" + (secret if secret is not None else load_xrp_secret()))[:20]
    return classic_address(payload)


def certificate_json(cert: dict) -> str:
    return json.dumps(cert, separators=(",", ":"), ensure_ascii=True, sort_keys=True)


def memo_hex(text: str) -> str:
    return to_hex(text.encode("utf-8"))


def encode_plate(plain: bytes, title: str = "", filename: str = "plate", mime: str = "application/octet-stream") -> dict:
    if not plain or len(plain) > XRP_MAX_PLATE:
        return {"ok": False, "error": "invalid plate"}
    secret = load_xrp_secret()
    nonce = os.urandom(XRP_NONCE_SIZE)
    image_hash = sha256_bytes(plain)
    key = sha256_bytes(secret + nonce + image_hash)
    cipher = xor_seal(plain, key)
    tag = hmac.new(cipher_key(secret), nonce + image_hash + cipher, hashlib.sha256).digest()
    envelope = XRP_MAGIC + bytes([XRP_VERSION]) + nonce + image_hash + tag + cipher
    address = plate_address(image_hash, secret)
    cert = {
        "v": 1,
        "kind": "aperture-xrp",
        "ledger": "xrpl",
        "title": title or Path(filename).stem or "Plate",
        "file": Path(filename).name or "plate",
        "mime": mime or "application/octet-stream",
        "imageHash": to_hex(image_hash),
        "cipherHash": to_hex(sha256_bytes(cipher)),
        "address": address,
        "tag": to_hex(tag),
        "encodedAt": datetime.now().isoformat(timespec="seconds"),
    }
    memo_data = memo_hex(certificate_json(cert))
    catalog = catalog_address(secret)
    cert["memoType"] = memo_hex(XRP_MEMO_TYPE)
    cert["memoFormat"] = memo_hex("application/json")
    cert["memoData"] = memo_data
    cert["tx"] = {
        "TransactionType": "Payment",
        "Account": catalog,
        "Destination": address,
        "Amount": "1",
        "Memos": [{"Memo": {"MemoType": cert["memoType"], "MemoFormat": cert["memoFormat"], "MemoData": memo_data}}],
    }
    vault = xrp_vault_dir() / f"{address}.apxr"
    vault.write_bytes(envelope)
    remember_xrp_certificate(cert)
    return {"ok": True, "certificate": cert, "address": address, "catalogAddress": catalog, "vault": vault.name}


def decode_plate(envelope: bytes, secret: bytes | None = None) -> tuple[dict, bytes] | None:
    if len(envelope) < 5 + XRP_NONCE_SIZE + XRP_HASH_SIZE * 2:
        return None
    if envelope[:4] != XRP_MAGIC or envelope[4] != XRP_VERSION:
        return None
    secret = secret if secret is not None else load_xrp_secret()
    cursor = 5
    nonce = envelope[cursor : cursor + XRP_NONCE_SIZE]
    cursor += XRP_NONCE_SIZE
    image_hash = envelope[cursor : cursor + XRP_HASH_SIZE]
    cursor += XRP_HASH_SIZE
    tag = envelope[cursor : cursor + XRP_HASH_SIZE]
    cursor += XRP_HASH_SIZE
    cipher = envelope[cursor:]
    expected = hmac.new(cipher_key(secret), nonce + image_hash + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, tag):
        return None
    key = sha256_bytes(secret + nonce + image_hash)
    plain = xor_seal(cipher, key)
    if sha256_bytes(plain) != image_hash:
        return None
    return {"imageHash": to_hex(image_hash), "tag": to_hex(tag)}, plain


def remember_xrp_certificate(cert: dict) -> dict:
    ledger = load_xrp_ledger()
    digest = str(cert.get("imageHash") or "")
    plates = [item for item in ledger.get("plates") or [] if str(item.get("imageHash") or "") != digest]
    plates.insert(0, cert)
    ledger["plates"] = plates[:80]
    ledger["catalogAddress"] = cert.get("tx", {}).get("Account") or catalog_address()
    ledger["updatedAt"] = datetime.now().isoformat(timespec="seconds")
    path = xrp_ledger_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    return ledger


def load_xrp_ledger() -> dict:
    path = xrp_ledger_file()
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


def list_xrp() -> dict:
    ledger = load_xrp_ledger()
    plates = ledger.get("plates") or []
    return {
        "ok": True,
        "catalogAddress": ledger.get("catalogAddress") or catalog_address(),
        "count": len(plates),
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
                if size <= 0 or size > XRP_MAX_PLATE:
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
    payload = list_xrp()
    payload["encoded"] = encoded
    payload["skipped"] = skipped
    if last:
        payload["address"] = last.get("address")
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
        if parsed.path == "/api/xrp":
            self._send_json(list_xrp())
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
        if parsed.path == "/api/skin":
            self._send_json({"ok": True, **save_skin(self._read_json())})
            return
        if parsed.path == "/api/xrp":
            self._encode_xrp()
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
        posts = cache_home() / "posts"
        posts.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
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
                "caption": meta["caption"],
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

    def _encode_xrp(self) -> None:
        content_type = self.headers.get("Content-Type") or ""
        if "multipart/form-data" in content_type:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > XRP_MAX_PLATE + 4096:
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
