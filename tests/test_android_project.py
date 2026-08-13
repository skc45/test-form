from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AndroidProjectTests(unittest.TestCase):
    def test_android_module_exists(self):
        self.assertTrue((ROOT / "android" / "app" / "src" / "main" / "AndroidManifest.xml").is_file())
        self.assertTrue((ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "aperture" / "catalog" / "MainActivity.kt").is_file())
        self.assertTrue((ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "aperture" / "catalog" / "CatalogStore.kt").is_file())
        self.assertTrue((ROOT / "android" / "gradlew").is_file())

    def test_web_bridge_hooks(self):
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("ApertureAndroid", app_js)
        self.assertIn("aperture-native-catalog", app_js)
        self.assertIn("apertureHandleBack", app_js)
        self.assertIn("openRecent", app_js)
        self.assertIn("recent-plate", app_js)
        self.assertIn("header-plate", app_js)
        self.assertIn("recent-tabs", app_js)
        self.assertIn("openRecents", app_js)
        self.assertIn("selectedIds", app_js)

    def test_recent_plates_in_opener(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        css = (ROOT / "css" / "styles.css").read_text(encoding="utf-8")
        data = (ROOT / "js" / "data.js").read_text(encoding="utf-8")
        self.assertIn('id="recentRow"', html)
        self.assertIn('id="recentTabs"', html)
        self.assertIn("recent-tabs", css)
        self.assertIn("is-together", css)
        self.assertIn("header-plate", css)
        self.assertIn("MAX_RECENTS = 3", data)

    def test_installable_apk_is_present(self):
        apk = ROOT / "releases" / "Aperture.apk"
        self.assertTrue(apk.is_file())
        self.assertGreater(apk.stat().st_size, 100_000)
        self.assertEqual(apk.read_bytes()[:4], b"PK\x03\x04")

    def test_native_cache_keys(self):
        store = (ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "aperture" / "catalog" / "CatalogStore.kt").read_text(encoding="utf-8")
        main = (ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "aperture" / "catalog" / "MainActivity.kt").read_text(encoding="utf-8")
        self.assertIn('KEY_URI = "lastFolder"', store)
        self.assertIn("takePersistableUriPermission", store)
        self.assertIn("KEY_RECENTS", store)
        self.assertIn("MAX_RECENTS = 3", store)
        self.assertIn("/api/catalog", main)
        self.assertIn("/api/recent-cover", main)
        self.assertIn("fun openRecent", main)
        self.assertIn("fun openRecents", main)
        self.assertIn("fun openRecents", store)

    def test_installable_apk_is_present(self):
        apk = ROOT / "releases" / "Aperture.apk"
        self.assertTrue(apk.is_file())
        self.assertGreater(apk.stat().st_size, 100_000)
        self.assertEqual(apk.read_bytes()[:4], b"PK\x03\x04")


if __name__ == "__main__":
    unittest.main()
