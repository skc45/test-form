#!/usr/bin/env python3
"""Aperture — full-screen image catalog desktop launcher.

Open a folder of photographs in the Aperture GUI:

    ./aperture
    ./aperture ~/Pictures
    ./aperture --install-launcher
"""

from __future__ import annotations

import argparse
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
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
CACHE_ENV = "APERTURE_CACHE_DIR"
MAX_RECENTS = 3
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


def chrome_profile_dir() -> Path:
    path = cache_home() / "chrome-profile"
    path.mkdir(parents=True, exist_ok=True)
    return path


class Runtime:
    """Mutable server state so recent plates can switch the open folder."""

    def __init__(self, folder: Path | None = None):
        self.folder = folder.resolve() if folder else None


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
    return [{**item, "cover": f"/api/recent-cover?i={index}"} for index, item in enumerate(recents)]


def first_image_in(folder: Path) -> Path | None:
    if not folder.is_dir():
        return None
    for path in sorted(folder.rglob("*"), key=lambda item: item.as_posix().lower()):
        if is_image(path):
            return path
    return None


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
            photos = scan_folder(self.folder) if self.folder else []
            session = load_disk_session()
            self._send_json(
                {
                    "folder": self.folder.name if self.folder else "",
                    "path": str(self.folder) if self.folder else "",
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
        if parsed.path.startswith("/media/"):
            self._send_media(unquote(parsed.path[len("/media/") :]))
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/open":
            self.send_error(404, "Not found")
            return
        body = self._read_json()
        raw = str(body.get("path") or "").strip()
        folder = Path(raw).expanduser() if raw else None
        if not folder or not folder.is_dir():
            self.send_error(404, "Folder not found")
            return
        folder = folder.resolve()
        photos = scan_folder(folder)
        remember_folder(folder, len(photos))
        self.runtime.folder = folder
        self._send_json(
            {
                "ok": True,
                "folder": folder.name,
                "path": str(folder),
                "photos": photos,
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
        try:
            index = int((parse_qs(query).get("i") or ["0"])[0])
        except ValueError:
            self.send_error(404, "Not found")
            return
        recents = load_disk_session().get("recents") or []
        if index < 0 or index >= len(recents):
            self.send_error(404, "Not found")
            return
        folder = Path(recents[index]["path"]).expanduser()
        cover = first_image_in(folder)
        if not cover:
            self.send_error(404, "Not found")
            return
        self._send_image_file(cover)

    def _send_media(self, rel: str) -> None:
        if not self.folder:
            self.send_error(404, "No folder open")
            return
        rel = posixpath.normpath(rel).lstrip("/")
        path = (self.folder / rel).resolve()
        if not safe_under(self.folder, path) or not is_image(path):
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
