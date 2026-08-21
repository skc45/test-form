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
        self.root = Path(self.tmp.name) / "photos"
        self.root.mkdir()
        (self.root / "plate.png").write_bytes(TINY_PNG)
        self.cache_dir = Path(self.tmp.name) / "cache"
        self.old_cache = os.environ.get("APERTURE_CACHE_DIR")
        os.environ["APERTURE_CACHE_DIR"] = str(self.cache_dir)
        self.server = app.run_server(self.root, 0)
        self.host, self.port = self.server.server_address

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        if self.old_cache is None:
            os.environ.pop("APERTURE_CACHE_DIR", None)
        else:
            os.environ["APERTURE_CACHE_DIR"] = self.old_cache
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
        self.assertIn(b"Tap to download", body)
        self.assertIn(b'id="postForm"', body)
        self.assertIn(b"New post", body)
        self.assertNotIn(b'id="chainLedger"', body)
        self.assertNotIn(b"Send folder", body)
        self.assertNotIn(b"Receive folder", body)
        self.assertNotIn(b'id="sendBar"', body)
        self.assertNotIn(b'id="syncInput"', body)
        self.assertIn(b"Theme editor", body)
        self.assertIn(b'id="skinEditor"', body)
        self.assertIn(b'id="themeBtn"', body)
        self.assertIn(b'id="xrpLedger"', body)
        self.assertIn(b"Encode onto XRP", body)
        self.assertIn(b'id="xrpBar"', body)

    def test_post_saves_plate_and_caption(self):
        boundary = "----ApertureBoundary7"
        payload = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="title"\r\n\r\n'
            "Ridge\r\n"
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="caption"\r\n\r\n'
            "Golden hour\r\n"
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="plate"; filename="ridge.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode("utf-8") + TINY_PNG + f"\r\n--{boundary}--\r\n".encode("utf-8")
        conn = HTTPConnection(self.host, self.port, timeout=5)
        conn.request(
            "POST",
            "/api/post",
            payload,
            {"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        response = conn.getresponse()
        data = json.loads(response.read())
        conn.close()
        self.assertEqual(response.status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["caption"], "Golden hour")
        posted = app.cache_home() / "posts" / data["file"]
        self.assertTrue(posted.is_file())
        self.assertEqual(posted.read_bytes(), TINY_PNG)
        metas = list((app.cache_home() / "posts").glob("*.json"))
        self.assertEqual(len(metas), 1)
        meta = json.loads(metas[0].read_text(encoding="utf-8"))
        self.assertEqual(meta["caption"], "Golden hour")
        self.assertEqual(meta["title"], "Ridge")
        self.assertEqual(meta["file"], data["file"])
        self.assertNotIn("block", data)
        self.assertNotIn("vault", data)

    def test_scan_skips_leftover_blockchain_dir(self):
        vault = self.root / "blockchain"
        vault.mkdir()
        (vault / "hidden.png").write_bytes(TINY_PNG)
        photos = app.scan_folder(self.root)
        self.assertEqual([photo["id"] for photo in photos], ["plate.png"])


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

    def test_recent_cover_slides(self):
        (self.photos / "next.png").write_bytes(TINY_PNG)
        app.remember_folder(self.photos, 2)
        server = app.run_server(self.photos, 0)
        host, port = server.server_address
        try:
            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/api/cache")
            payload = json.loads(conn.getresponse().read())
            conn.close()
            self.assertEqual(len(payload["recents"][0]["covers"]), 2)
            self.assertEqual(payload["recents"][0]["covers"][1], "/api/recent-cover?i=0&p=1")

            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/api/recent-cover?i=0&p=0")
            first = conn.getresponse()
            first_body = first.read()
            conn.close()
            self.assertEqual(first.status, 200)
            self.assertEqual(first_body[:8], b"\x89PNG\r\n\x1a\n")

            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/api/recent-cover?i=0&p=1")
            second = conn.getresponse()
            second_body = second.read()
            conn.close()
            self.assertEqual(second.status, 200)
            self.assertEqual(second_body[:8], b"\x89PNG\r\n\x1a\n")
        finally:
            server.shutdown()
            server.server_close()

    def test_open_multiple_folders(self):
        other = Path(self.tmp.name) / "other"
        other.mkdir()
        (other / "b.png").write_bytes(TINY_PNG)
        runtime = app.Runtime(self.photos)
        server = app.run_server(self.photos, 0, runtime=runtime)
        host, port = server.server_address
        try:
            conn = HTTPConnection(host, port, timeout=5)
            payload = json.dumps({"paths": [str(self.photos), str(other)]})
            conn.request("POST", "/api/open", payload, {"Content-Type": "application/json"})
            response = conn.getresponse()
            data = json.loads(response.read())
            conn.close()
            self.assertEqual(response.status, 200)
            self.assertEqual(data["folder"], f"{self.photos.name} + {other.name}")
            self.assertEqual(len(data["photos"]), 2)
            self.assertEqual(len(runtime.folders), 2)
            ids = [photo["id"] for photo in data["photos"]]
            self.assertTrue(any(item.startswith("0/") for item in ids))
            self.assertTrue(any(item.startswith("1/") for item in ids))

            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/media/" + data["photos"][0]["id"])
            media = conn.getresponse()
            body = media.read()
            conn.close()
            self.assertEqual(media.status, 200)
            self.assertEqual(body[:8], b"\x89PNG\r\n\x1a\n")
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
            self.assertTrue(payload["recents"][0]["covers"][0].startswith("/api/recent-cover"))

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


class SkinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("APERTURE_CACHE_DIR")
        os.environ["APERTURE_CACHE_DIR"] = str(Path(self.tmp.name) / "cache")

    def tearDown(self):
        if self.old is None:
            os.environ.pop("APERTURE_CACHE_DIR", None)
        else:
            os.environ["APERTURE_CACHE_DIR"] = self.old
        self.tmp.cleanup()

    def test_normalize_rejects_bad_hex_and_clamps_sheen(self):
        skin = app.normalize_skin({"skyMid": "blue", "sheen": 4, "id": "midnight"})
        self.assertEqual(skin["skyMid"], app.default_skin()["skyMid"])
        self.assertEqual(skin["sheen"], 1.0)
        self.assertEqual(skin["id"], "midnight")

    def test_skin_http_roundtrip(self):
        photos = Path(self.tmp.name) / "album"
        photos.mkdir()
        (photos / "keep.png").write_bytes(TINY_PNG)
        server = app.run_server(photos, 0)
        host, port = server.server_address
        try:
            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/api/skin")
            response = conn.getresponse()
            payload = json.loads(response.read())
            conn.close()
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["id"], "aero")
            self.assertEqual(payload["skyMid"], "#3d8fd4")

            conn = HTTPConnection(host, port, timeout=5)
            body = json.dumps({**payload, "id": "sunset", "skyMid": "#e07858", "sheen": 0.4})
            conn.request("POST", "/api/skin", body, {"Content-Type": "application/json"})
            posted = conn.getresponse()
            saved = json.loads(posted.read())
            conn.close()
            self.assertEqual(posted.status, 200)
            self.assertEqual(saved["skyMid"], "#e07858")
            self.assertEqual(app.load_skin()["skyMid"], "#e07858")
            self.assertEqual(app.load_skin()["sheen"], 0.4)
        finally:
            server.shutdown()
            server.server_close()


class XrpCipherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("APERTURE_CACHE_DIR")
        os.environ["APERTURE_CACHE_DIR"] = str(Path(self.tmp.name) / "cache")

    def tearDown(self):
        if self.old is None:
            os.environ.pop("APERTURE_CACHE_DIR", None)
        else:
            os.environ["APERTURE_CACHE_DIR"] = self.old
        self.tmp.cleanup()

    def test_seal_roundtrip_and_classic_address(self):
        result = app.encode_plate(TINY_PNG, "Ridge", "ridge.png", "image/png")
        self.assertTrue(result["ok"])
        address = result["address"]
        self.assertTrue(address.startswith("r"))
        self.assertGreaterEqual(len(address), 25)
        self.assertTrue(all(ch in app.XRP_ALPHABET for ch in address))
        cert = result["certificate"]
        self.assertEqual(cert["kind"], "aperture-xrp")
        self.assertEqual(cert["tx"]["Destination"], address)
        self.assertEqual(cert["tx"]["Account"], result["catalogAddress"])
        self.assertTrue(cert["memoData"])
        vault = app.xrp_vault_dir() / result["vault"]
        self.assertTrue(vault.is_file())
        self.assertTrue(vault.read_bytes().startswith(app.XRP_MAGIC))
        unlocked = app.decode_plate(vault.read_bytes())
        self.assertIsNotNone(unlocked)
        self.assertEqual(unlocked[1], TINY_PNG)
        listing = app.list_xrp()
        self.assertEqual(listing["count"], 1)
        self.assertEqual(listing["plates"][0]["address"], address)

    def test_tamper_rejects_decode(self):
        result = app.encode_plate(TINY_PNG, "Ridge", "ridge.png", "image/png")
        packed = (app.xrp_vault_dir() / result["vault"]).read_bytes()
        mutated = packed[:-1] + bytes([packed[-1] ^ 1])
        self.assertIsNone(app.decode_plate(mutated))

    def test_xrp_http_encodes_plate(self):
        photos = Path(self.tmp.name) / "album"
        photos.mkdir()
        (photos / "keep.png").write_bytes(TINY_PNG)
        server = app.run_server(photos, 0)
        host, port = server.server_address
        try:
            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/api/xrp")
            listed = json.loads(conn.getresponse().read())
            conn.close()
            self.assertTrue(listed["ok"])
            self.assertTrue(listed["catalogAddress"].startswith("r"))

            boundary = "----ApertureXrp7"
            payload = (
                f"--{boundary}\r\n"
                'Content-Disposition: form-data; name="title"\r\n\r\n'
                "Ridge\r\n"
                f"--{boundary}\r\n"
                'Content-Disposition: form-data; name="plate"; filename="ridge.png"\r\n'
                "Content-Type: image/png\r\n\r\n"
            ).encode("utf-8") + TINY_PNG + f"\r\n--{boundary}--\r\n".encode("utf-8")
            conn = HTTPConnection(host, port, timeout=5)
            conn.request(
                "POST",
                "/api/xrp",
                payload,
                {"Content-Type": f"multipart/form-data; boundary={boundary}"},
            )
            posted = json.loads(conn.getresponse().read())
            conn.close()
            self.assertTrue(posted["ok"])
            self.assertTrue(posted["address"].startswith("r"))
            self.assertEqual(posted["certificate"]["title"], "Ridge")

            conn = HTTPConnection(host, port, timeout=5)
            conn.request("POST", "/api/xrp", json.dumps({"path": str(photos)}), {"Content-Type": "application/json"})
            foldered = json.loads(conn.getresponse().read())
            conn.close()
            self.assertGreaterEqual(foldered["count"], 1)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
