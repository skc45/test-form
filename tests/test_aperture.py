import json
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


if __name__ == "__main__":
    unittest.main()
