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
        self.assertIn(b'id="chainLedger"', body)
        self.assertIn(b"Unlock folder", body)
        self.assertIn(b"Blockchain monitor", body)
        self.assertIn(b"Send sync", body)
        self.assertIn(b"Receive sync", body)
        self.assertIn(b'id="syncInput"', body)

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
        self.assertTrue(data["block"]["hash"].startswith("0" * app.CHAIN_DIFFICULTY))
        self.assertEqual(data["block"]["height"], 1)
        self.assertTrue(data["valid"])
        vault = app.cache_home() / "blockchain" / data["vault"]
        self.assertTrue(vault.is_file())
        unlocked = app.unlock_bytes(vault.read_bytes())
        self.assertIsNotNone(unlocked)
        self.assertEqual(unlocked[1], TINY_PNG)

    def test_chain_endpoint_lists_blocks(self):
        conn = HTTPConnection(self.host, self.port, timeout=5)
        conn.request("GET", "/api/chain")
        response = conn.getresponse()
        payload = json.loads(response.read())
        conn.close()
        self.assertEqual(response.status, 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["valid"])
        self.assertGreaterEqual(len(payload["blocks"]), 1)
        self.assertEqual(payload["blocks"][0]["title"], "Aperture")

        conn = HTTPConnection(self.host, self.port, timeout=5)
        body = json.dumps({"title": "Ridge", "caption": "On chain", "file": "ridge.png", "imageHash": "abc"})
        conn.request("POST", "/api/chain", body, {"Content-Type": "application/json"})
        posted = json.loads(conn.getresponse().read())
        conn.close()
        self.assertTrue(posted["ok"])
        self.assertEqual(posted["block"]["caption"], "On chain")
        self.assertTrue(posted["valid"])

    def test_vault_lists_and_serves_unlocked_plate(self):
        self.test_post_saves_plate_and_caption()
        conn = HTTPConnection(self.host, self.port, timeout=5)
        conn.request("GET", "/api/vault")
        payload = json.loads(conn.getresponse().read())
        conn.close()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["valid"])
        self.assertGreaterEqual(len(payload["files"]), 1)
        self.assertTrue(payload["files"][0]["unlocked"])
        self.assertGreaterEqual(len(payload["photos"]), 1)
        name = payload["files"][0]["name"]
        status, ctype, body = self._get("/media/vault/" + name)
        self.assertEqual(status, 200)
        self.assertTrue(ctype.startswith("image/"))
        self.assertEqual(body, TINY_PNG)

    def test_vault_encode_endpoint_seals_open_folder(self):
        conn = HTTPConnection(self.host, self.port, timeout=5)
        conn.request(
            "POST",
            "/api/vault/encode",
            json.dumps({"path": str(self.root)}),
            {"Content-Type": "application/json"},
        )
        payload = json.loads(conn.getresponse().read())
        conn.close()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["encoded"], 1)
        self.assertTrue((self.root / "blockchain").is_dir())
        self.assertTrue(any((self.root / "blockchain").glob("*.apc")))
        again = HTTPConnection(self.host, self.port, timeout=5)
        again.request(
            "POST",
            "/api/vault/encode",
            json.dumps({"path": str(self.root)}),
            {"Content-Type": "application/json"},
        )
        repeated = json.loads(again.getresponse().read())
        again.close()
        self.assertEqual(repeated["encoded"], 0)


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


class ChainTests(unittest.TestCase):
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

    def test_chain_links_and_rejects_tamper(self):
        genesis = app.genesis_block()
        self.assertTrue(genesis["hash"].startswith("0" * app.CHAIN_DIFFICULTY))
        self.assertTrue(app.verify_chain([genesis]))
        block = app.append_block("Ridge", "Golden hour", "ridge.png", "abc123")
        loaded = app.load_chain()
        self.assertEqual(len(loaded), 2)
        self.assertEqual(loaded[-1]["hash"], block["hash"])
        self.assertEqual(loaded[-1]["prevHash"], loaded[0]["hash"])
        self.assertTrue(app.verify_chain(loaded))
        loaded[-1]["caption"] = "tampered"
        self.assertFalse(app.verify_chain(loaded))

    def test_vault_decodes_with_chain_and_rejects_tamper(self):
        block = app.append_block("Ridge", "Golden hour", "ridge.png", "abc123")
        packed = app.lock_bytes(TINY_PNG, block, "ridge.png", "Ridge", "Golden hour", "image/png")
        self.assertTrue(packed.startswith(app.VAULT_MAGIC))
        unlocked = app.unlock_bytes(packed)
        self.assertIsNotNone(unlocked)
        self.assertEqual(unlocked[1], TINY_PNG)
        self.assertEqual(unlocked[0]["title"], "Ridge")
        folder = app.remember_vault(Path(self.tmp.name) / "vault")
        name = app.vault_filename(block, "ridge.png")
        (folder / name).write_bytes(packed)
        listing = app.list_vault(folder)
        self.assertTrue(listing["valid"])
        self.assertEqual(listing["files"][0]["unlocked"], True)
        chain = app.load_chain()
        chain[-1]["caption"] = "tampered"
        app.save_chain(chain)
        self.assertIsNone(app.unlock_bytes(packed))
        listing = app.list_vault(folder)
        self.assertFalse(listing["valid"])
        self.assertFalse(listing["files"][0]["unlocked"])

    def test_encodes_local_folder_cheaply_and_skips_duplicates(self):
        self.assertEqual(app.CHAIN_DIFFICULTY, 1)
        photos = Path(self.tmp.name) / "album"
        photos.mkdir()
        (photos / "keep.png").write_bytes(TINY_PNG)
        first = app.encode_folders([photos])
        self.assertEqual(first["encoded"], 1)
        self.assertTrue(first["valid"])
        sidecars = list((photos / "blockchain").glob("*.apc"))
        self.assertEqual(len(sidecars), 1)
        unlocked = app.unlock_bytes(sidecars[0].read_bytes())
        self.assertIsNotNone(unlocked)
        self.assertEqual(unlocked[1], TINY_PNG)
        second = app.encode_folders([photos])
        self.assertEqual(second["encoded"], 0)
        self.assertGreaterEqual(second["skipped"], 1)
        self.assertTrue((photos / "blockchain" / "chain.json").is_file())

    def test_sync_pack_unlocks_on_another_device(self):
        photos = Path(self.tmp.name) / "album"
        photos.mkdir()
        (photos / "keep.png").write_bytes(TINY_PNG)
        encoded = app.encode_folders([photos])
        self.assertEqual(encoded["encoded"], 1)
        pack = app.build_sync_pack()
        self.assertTrue(pack.startswith(app.SYNC_MAGIC))
        parsed = app.parse_sync_pack(pack)
        self.assertIsNotNone(parsed)
        sender = app.load_chain()
        other = Path(self.tmp.name) / "other-cache"
        os.environ["APERTURE_CACHE_DIR"] = str(other)
        received = app.receive_sync_pack(pack)
        self.assertTrue(received["ok"])
        self.assertTrue(received["valid"])
        self.assertEqual(received["received"], 1)
        self.assertTrue(received["files"][0]["unlocked"])
        dest = app.load_vault_folder() / received["files"][0]["name"]
        unlocked = app.unlock_bytes(dest.read_bytes())
        self.assertIsNotNone(unlocked)
        self.assertEqual(unlocked[1], TINY_PNG)
        self.assertEqual([block["hash"] for block in app.load_chain()], [block["hash"] for block in sender])

    def test_copied_blockchain_folder_imports_chain(self):
        photos = Path(self.tmp.name) / "album"
        photos.mkdir()
        (photos / "keep.png").write_bytes(TINY_PNG)
        app.encode_folders([photos])
        sidecar = photos / "blockchain"
        other = Path(self.tmp.name) / "other-cache"
        os.environ["APERTURE_CACHE_DIR"] = str(other)
        listing = app.receive_sync_folder(sidecar)
        self.assertTrue(listing["ok"])
        self.assertTrue(listing["valid"])
        self.assertTrue(any(item["unlocked"] for item in listing["files"]))
        longer = app.load_chain()
        shorter = longer[:1]
        merged = app.merge_chains(shorter, longer)
        self.assertEqual(len(merged), len(longer))
        self.assertEqual(app.merge_chains(longer, shorter), longer)

    def test_sync_http_roundtrip(self):
        photos = Path(self.tmp.name) / "album"
        photos.mkdir()
        (photos / "keep.png").write_bytes(TINY_PNG)
        app.encode_folders([photos])
        server = app.run_server(photos, 0)
        host, port = server.server_address
        try:
            conn = HTTPConnection(host, port, timeout=5)
            conn.request("GET", "/api/sync")
            response = conn.getresponse()
            pack = response.read()
            conn.close()
            self.assertEqual(response.status, 200)
            self.assertTrue(pack.startswith(b"APSY"))

            other = Path(self.tmp.name) / "http-other"
            os.environ["APERTURE_CACHE_DIR"] = str(other)
            receiver = app.run_server(photos, 0)
            rhost, rport = receiver.server_address
            try:
                conn = HTTPConnection(rhost, rport, timeout=5)
                conn.request(
                    "POST",
                    "/api/sync/receive",
                    pack,
                    {"Content-Type": "application/octet-stream"},
                )
                posted = conn.getresponse()
                data = json.loads(posted.read())
                conn.close()
                self.assertEqual(posted.status, 200)
                self.assertTrue(data["ok"])
                self.assertTrue(data["valid"])
                self.assertGreaterEqual(data["received"], 1)
                self.assertTrue(data["files"][0]["unlocked"])
            finally:
                receiver.shutdown()
                receiver.server_close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
