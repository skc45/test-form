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


CHAIN_DIFFICULTY = 3
GENESIS_PREV = "0" * 64


def chain_file() -> Path:
    return cache_home() / "chain.json"


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def as_int(value, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def block_payload(block: dict) -> str:
    return "|".join(
        [
            str(as_int(block.get("height"), 0)),
            str(block.get("prevHash") or ""),
            str(block.get("timestamp") or ""),
            str(block.get("title") or ""),
            str(block.get("caption") or ""),
            str(block.get("file") or ""),
            str(block.get("imageHash") or ""),
            str(as_int(block.get("nonce"), 0)),
        ]
    )


def hash_block(block: dict) -> str:
    return sha256_hex(block_payload(block))


def mine_block(block: dict, difficulty: int = CHAIN_DIFFICULTY) -> dict:
    prefix = "0" * difficulty
    nonce = as_int(block.get("nonce"), 0)
    while True:
        block["nonce"] = nonce
        digest = hash_block(block)
        if digest.startswith(prefix):
            block["hash"] = digest
            return block
        nonce += 1


def genesis_block() -> dict:
    return mine_block(
        {
            "height": 0,
            "timestamp": "1970-01-01T00:00:00",
            "title": "Aperture",
            "caption": "Genesis plate",
            "file": "",
            "imageHash": GENESIS_PREV,
            "prevHash": GENESIS_PREV,
            "nonce": 0,
        }
    )


def save_chain(blocks: list[dict]) -> None:
    path = chain_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"blocks": blocks}, indent=2) + "\n", encoding="utf-8")


def load_chain() -> list[dict]:
    path = chain_file()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            blocks = data.get("blocks") if isinstance(data, dict) else data
            if isinstance(blocks, list) and blocks:
                return blocks
        except (OSError, json.JSONDecodeError):
            pass
    chain = [genesis_block()]
    save_chain(chain)
    return chain


def verify_chain(blocks: list[dict] | None = None, difficulty: int = CHAIN_DIFFICULTY) -> bool:
    chain = blocks if blocks is not None else load_chain()
    if not chain:
        return False
    prefix = "0" * difficulty
    for index, block in enumerate(chain):
        digest = hash_block(block)
        if digest != str(block.get("hash") or "") or not digest.startswith(prefix):
            return False
        if index == 0:
            if as_int(block.get("height"), -1) != 0 or str(block.get("prevHash") or "") != GENESIS_PREV:
                return False
            continue
        prev = chain[index - 1]
        if as_int(block.get("height"), -1) != as_int(prev.get("height"), 0) + 1:
            return False
        if str(block.get("prevHash") or "") != str(prev.get("hash") or ""):
            return False
    return True


def append_block(title: str, caption: str, filename: str, image_hash: str) -> dict:
    chain = load_chain()
    prev = chain[-1]
    block = mine_block(
        {
            "height": as_int(prev.get("height"), 0) + 1,
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "title": title or "",
            "caption": caption or "",
            "file": filename or "",
            "imageHash": image_hash or "",
            "prevHash": str(prev.get("hash") or ""),
            "nonce": 0,
        }
    )
    chain.append(block)
    save_chain(chain)
    return block


VAULT_MAGIC = b"APCH"
VAULT_EXT = ".apc"
VAULT_EXTS = {".apc", ".aplate"}


def default_vault_dir() -> Path:
    path = cache_home() / "blockchain"
    path.mkdir(parents=True, exist_ok=True)
    return path


def remember_vault(folder: Path) -> Path:
    resolved = folder.expanduser().resolve()
    resolved.mkdir(parents=True, exist_ok=True)
    save_disk_session({"blockchainFolder": str(resolved), "blockchainFolderName": resolved.name})
    return resolved


def load_vault_folder() -> Path:
    raw = str(load_disk_session().get("blockchainFolder") or "").strip()
    if raw:
        folder = Path(raw).expanduser()
        if folder.is_dir():
            return folder.resolve()
    return default_vault_dir()


def vault_key(block: dict) -> bytes:
    return hashlib.sha256(str(block.get("hash") or "").encode("utf-8")).digest()


def xor_bytes(data: bytes, key: bytes) -> bytes:
    if not key:
        return data
    return bytes(value ^ key[index % len(key)] for index, value in enumerate(data))


def vault_filename(block: dict, filename: str) -> str:
    height = as_int(block.get("height"), 0)
    stem = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in Path(filename).stem) or "plate"
    return f"{height:04d}-{stem}{VAULT_EXT}"


def lock_bytes(plain: bytes, block: dict, filename: str, title: str, caption: str, mime: str) -> bytes:
    header = json.dumps(
        {
            "v": 1,
            "height": as_int(block.get("height"), 0),
            "file": filename or "",
            "title": title or "",
            "caption": caption or "",
            "imageHash": hashlib.sha256(plain).hexdigest(),
            "mime": mime or "application/octet-stream",
        },
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    cipher = xor_bytes(plain, vault_key(block))
    return VAULT_MAGIC + bytes([1]) + len(header).to_bytes(4, "big") + header + cipher


def parse_envelope(data: bytes) -> tuple[dict, bytes] | None:
    if len(data) < 9 or data[:4] != VAULT_MAGIC or data[4] != 1:
        return None
    size = int.from_bytes(data[5:9], "big")
    if size < 2 or 9 + size > len(data):
        return None
    try:
        header = json.loads(data[9 : 9 + size].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(header, dict):
        return None
    return header, data[9 + size :]


def block_at_height(blocks: list[dict], height: int) -> dict | None:
    for block in blocks:
        if as_int(block.get("height"), -1) == height:
            return block
    return None


def unlock_bytes(data: bytes, blocks: list[dict] | None = None) -> tuple[dict, bytes] | None:
    parsed = parse_envelope(data)
    if not parsed:
        return None
    header, cipher = parsed
    chain = blocks if blocks is not None else load_chain()
    if not verify_chain(chain):
        return None
    block = block_at_height(chain, as_int(header.get("height"), -1))
    if not block:
        return None
    plain = xor_bytes(cipher, vault_key(block))
    if hashlib.sha256(plain).hexdigest() != str(header.get("imageHash") or ""):
        return None
    return header, plain


def save_locked_plate(plain: bytes, block: dict, filename: str, title: str, caption: str, mime: str) -> str:
    folder = load_vault_folder()
    folder.mkdir(parents=True, exist_ok=True)
    name = vault_filename(block, filename)
    (folder / name).write_bytes(lock_bytes(plain, block, filename, title, caption, mime))
    return name


def is_vault_file(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.suffix.lower() in VAULT_EXTS:
        return True
    try:
        with path.open("rb") as handle:
            return handle.read(4) == VAULT_MAGIC
    except OSError:
        return False


def vault_photo(name: str, header: dict, index: int = 0) -> dict:
    src = "/media/vault/" + quote(name)
    title = str(header.get("title") or Path(str(header.get("file") or name)).stem or "Plate")
    return {
        "id": f"vault/{name}",
        "title": title,
        "photographer": "Aperture chain",
        "location": str(header.get("caption") or "Unlocked plate"),
        "year": datetime.now().year,
        "category": "blockchain",
        "src": src,
        "thumb": src,
        "hero": src,
        "local": True,
        "featured": index == 0,
        "height": as_int(header.get("height"), 0),
    }


def list_vault(folder: Path | None = None) -> dict:
    root = folder if folder is not None else load_vault_folder()
    chain = load_chain()
    valid = verify_chain(chain)
    files: list[dict] = []
    photos: list[dict] = []
    if root.is_dir():
        for path in sorted(root.iterdir(), key=lambda item: item.name.lower()):
            if not is_vault_file(path):
                continue
            try:
                data = path.read_bytes()
            except OSError:
                continue
            parsed = parse_envelope(data)
            header = parsed[0] if parsed else {"file": path.name, "title": path.stem}
            unlocked = unlock_bytes(data, chain) if valid else None
            entry = {
                "name": path.name,
                "height": as_int(header.get("height"), 0),
                "title": str(header.get("title") or Path(str(header.get("file") or path.name)).stem),
                "caption": str(header.get("caption") or ""),
                "file": str(header.get("file") or path.name),
                "unlocked": bool(unlocked),
                "src": "/media/vault/" + quote(path.name) if unlocked else "",
                "error": "" if unlocked else ("locked" if parsed else "undecodable"),
            }
            files.append(entry)
            if unlocked:
                photos.append(vault_photo(path.name, unlocked[0], len(photos)))
    return {
        "ok": True,
        "valid": valid,
        "folder": root.name,
        "path": str(root),
        "height": as_int(chain[-1].get("height"), 0) if chain else 0,
        "files": files,
        "photos": photos,
        "blocks": chain,
    }


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
        if not is_image(path):
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
        if not is_image(path):
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
        if parsed.path == "/api/chain":
            blocks = load_chain()
            self._send_json({"ok": True, "valid": verify_chain(blocks), "blocks": blocks})
            return
        if parsed.path == "/api/vault":
            self._send_json(list_vault())
            return
        if parsed.path.startswith("/media/vault/"):
            self._send_vault_media(unquote(parsed.path[len("/media/vault/") :]))
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
        if parsed.path == "/api/chain":
            body = self._read_json()
            block = append_block(
                str(body.get("title") or ""),
                str(body.get("caption") or ""),
                str(body.get("file") or ""),
                str(body.get("imageHash") or ""),
            )
            blocks = load_chain()
            self._send_json({"ok": True, "valid": verify_chain(blocks), "block": block, "blocks": blocks})
            return
        if parsed.path == "/api/vault/open":
            body = self._read_json()
            folder = Path(str(body.get("path") or "")).expanduser()
            if not folder.is_dir():
                self.send_error(404, "Folder not found")
                return
            remember_vault(folder)
            self._send_json(list_vault(folder.resolve()))
            return
        if parsed.path == "/api/vault/lock":
            self._lock_vault_upload()
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
        image_hash = hashlib.sha256(payload).hexdigest()
        block = append_block(meta["title"], meta["caption"], image_path.name, image_hash)
        vault_name = save_locked_plate(payload, block, image_path.name, meta["title"], meta["caption"], ctype)
        self._send_json(
            {
                "ok": True,
                "file": image_path.name,
                "caption": meta["caption"],
                "block": block,
                "valid": verify_chain(),
                "vault": vault_name,
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

    def _lock_vault_upload(self) -> None:
        content_type = self.headers.get("Content-Type") or ""
        if "multipart/form-data" not in content_type:
            self.send_error(400, "Expected multipart form")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 25 * 1024 * 1024:
            self.send_error(400, "Invalid plate")
            return
        fields, files = self._parse_multipart(content_type, self.rfile.read(length))
        plate = files.get("plate") or files.get("file")
        if not plate or not plate[1]:
            self.send_error(400, "Missing plate")
            return
        filename, payload, ctype = plate
        chain = load_chain()
        block = chain[-1] if chain else genesis_block()
        name = save_locked_plate(
            payload,
            block,
            filename,
            fields.get("title") or "",
            fields.get("caption") or "",
            ctype,
        )
        payload_out = list_vault()
        payload_out["vault"] = name
        payload_out["block"] = block
        self._send_json(payload_out)

    def _send_vault_media(self, rel: str) -> None:
        folder = load_vault_folder()
        name = Path(rel).name
        path = (folder / name).resolve()
        if not safe_under(folder, path) or not path.is_file():
            self.send_error(404, "Not found")
            return
        try:
            unlocked = unlock_bytes(path.read_bytes())
        except OSError:
            unlocked = None
        if not unlocked:
            self.send_error(404, "Locked")
            return
        header, plain = unlocked
        ctype = str(header.get("mime") or mimetypes.guess_type(str(header.get("file") or name))[0] or "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(plain)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(plain)

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
