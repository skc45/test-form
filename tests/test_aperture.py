import json
import os
import tempfile
import unittest
from http.client import HTTPConnection
from pathlib import Path
from sys import path as sys_path

sys_path.insert(0, str(Path(__file__).resolve().parents[1]))

import aperture as app


TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
)


class ScanFolderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "Landscapes").mkdir()
        (self.root / "Landscapes" / "ridge.png").write_bytes(TINY_PNG)
        (self.root / "notes.txt").write_text("ignore", encoding="utf-8")
        (self.root / "cover.jpg").write_bytes(TINY_PNG)

    def tearDown(self):
        self.tmp.cleanup()

    def test_scan_skips_non_images_and_uses_subfolders(self):
        photos = app.scan_folder(self.root)
        ids = [photo["id"] for photo in photos]
        self.assertEqual(ids, ["cover.jpg", "Landscapes/ridge.png"])
        self.assertTrue(photos[0]["featured"])
        self.assertEqual(photos[1]["category"], "landscapes")
        self.assertTrue(photos[0]["src"].startswith("/media/"))

    def test_safe_under_rejects_escape(self):
        self.assertTrue(app.safe_under(self.root, self.root / "cover.jpg"))
        self.assertFalse(app.safe_under(self.root, Path("/etc/passwd")))


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "plate.png").write_bytes(TINY_PNG)
        self.server = app.run_server(self.root, 0)
        self.host, self.port = self.server.server_address

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def _get(self, path: str):
        conn = HTTPConnection(self.host, self.port, timeout=5)
        conn.request("GET", path)
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, response.getheader("Content-Type"), body

    def test_catalog_and_media(self):
        status, ctype, body = self._get("/api/catalog")
        self.assertEqual(status, 200)
        self.assertIn("application/json", ctype)
        payload = json.loads(body)
        self.assertEqual(payload["folder"], self.root.name)
        self.assertEqual(len(payload["photos"]), 1)

        status, ctype, body = self._get("/media/plate.png")
        self.assertEqual(status, 200)
        self.assertTrue(ctype.startswith("image/"))
        self.assertEqual(body[:8], b"\x89PNG\r\n\x1a\n")

    def test_media_rejects_path_escape(self):
        status, _, _ = self._get("/media/../../aperture.py")
        self.assertEqual(status, 404)

    def test_index_served(self):
        status, ctype, body = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Open folder", body)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache_dir = Path(self.tmp.name) / "cache"
        self.photos = Path(self.tmp.name) / "photos"
        self.photos.mkdir()
        (self.photos / "keep.png").write_bytes(TINY_PNG)
        self.old = os.environ.get("APERTURE_CACHE_DIR")
        os.environ["APERTURE_CACHE_DIR"] = str(self.cache_dir)

    def tearDown(self):
        if self.old is None:
            os.environ.pop("APERTURE_CACHE_DIR", None)
        else:
            os.environ["APERTURE_CACHE_DIR"] = self.old
        self.tmp.cleanup()

    def test_remembers_and_restores_last_folder(self):
        app.remember_folder(self.photos, 1)
        session = app.load_disk_session()
        self.assertEqual(session["lastFolder"], str(self.photos))
        self.assertEqual(session["lastFolderName"], self.photos.name)
        self.assertEqual(session["photoCount"], 1)
        restored = app.resolve_startup_folder(None)
        self.assertEqual(restored, self.photos.resolve())

    def test_recents_keep_latest_first(self):
        other = Path(self.tmp.name) / "other"
        other.mkdir()
        app.remember_folder(self.photos)
        app.remember_folder(other)
        recents = app.load_disk_session()["recents"]
        self.assertEqual(recents[0]["path"], str(other))
        self.assertEqual(recents[1]["path"], str(self.photos))
        self.assertEqual(recents[0]["name"], other.name)

    def test_recents_cap_at_three(self):
        folders = []
        for index in range(5):
            folder = Path(self.tmp.name) / f"album-{index}"
            folder.mkdir()
            (folder / "plate.png").write_bytes(TINY_PNG)
            app.remember_folder(folder, 1)
            folders.append(folder)
        recents = app.load_disk_session()["recents"]
        self.assertEqual(len(recents), 3)
        self.assertEqual(
            [item["path"] for item in recents],
            [str(folders[4]), str(folders[3]), str(folders[2])],
        )

    def test_migrates_string_recents(self):
        app.save_disk_session({"lastFolder": str(self.photos), "recents": [str(self.photos)]})
        recents = app.load_disk_session()["recents"]
        self.assertEqual(recents[0]["path"], str(self.photos))
        self.assertEqual(recents[0]["name"], self.photos.name)
        self.assertLessEqual(len(recents), 3)

    def test_recent_cover_and_open(self):
        other = Path(self.tmp.name) / "other"
        other.mkdir()
        (other / "b.png").write_bytes(TINY_PNG)
        app.remember_folder(self.photos, 1)
        runtime = app.Runtime(self.photos)
        server = app.run_server(self.photos, 0, runtime=runtime)
        host, port = server.server_address
        try:
            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/api/recent-cover?i=0")
            response = conn.getresponse()
            body = response.read()
            ctype = response.getheader("Content-Type")
            conn.close()
            self.assertEqual(response.status, 200)
            self.assertTrue(ctype.startswith("image/"))
            self.assertEqual(body[:8], b"\x89PNG\r\n\x1a\n")

            conn = HTTPConnection(host, port, timeout=5)
            payload = json.dumps({"path": str(other)})
            conn.request("POST", "/api/open", payload, {"Content-Type": "application/json"})
            response = conn.getresponse()
            data = json.loads(response.read())
            conn.close()
            self.assertEqual(response.status, 200)
            self.assertEqual(data["folder"], other.name)
            self.assertEqual(runtime.folder, other.resolve())

            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/api/catalog")
            catalog = json.loads(conn.getresponse().read())
            conn.close()
            self.assertEqual(catalog["folder"], other.name)
            self.assertEqual(len(catalog["photos"]), 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_missing_cached_folder_is_ignored(self):
        missing = Path(self.tmp.name) / "gone"
        app.save_disk_session({"lastFolder": str(missing), "lastFolderName": "gone", "source": "folder"})
        self.assertIsNone(app.resolve_startup_folder(None))

    def test_forget_clears_session(self):
        app.remember_folder(self.photos)
        app.clear_disk_session()
        self.assertEqual(app.load_disk_session(), {})

    def test_cache_http_endpoints(self):
        app.remember_folder(self.photos, 1)
        server = app.run_server(self.photos, 0)
        host, port = server.server_address
        try:
            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/api/cache")
            response = conn.getresponse()
            payload = json.loads(response.read())
            conn.close()
            self.assertEqual(response.status, 200)
            self.assertTrue(payload["exists"])
            self.assertEqual(payload["lastFolderName"], self.photos.name)
            self.assertEqual(payload["recents"][0]["path"], str(self.photos))
            self.assertTrue(payload["recents"][0]["cover"].startswith("/api/recent-cover"))

            conn = HTTPConnection(host, port, timeout=5)
            conn.request("DELETE", "/api/cache")
            response = conn.getresponse()
            body = json.loads(response.read())
            conn.close()
            self.assertEqual(response.status, 200)
            self.assertTrue(body["cleared"])
            self.assertEqual(app.load_disk_session(), {})
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
