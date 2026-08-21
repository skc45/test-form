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
        self.assertIn("is-selected", app_js)
        self.assertIn("downloadCurrent", app_js)
        self.assertIn("apertureDownloadProgress", app_js)
        self.assertIn("openPostForm", app_js)
        self.assertIn("attachLongPress", app_js)
        self.assertIn("ApertureAndroid.share", app_js)
        self.assertIn("aperturePostProgress", app_js)
        self.assertIn("/api/post", app_js)

    def test_recent_plates_in_opener(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        css = (ROOT / "css" / "styles.css").read_text(encoding="utf-8")
        data = (ROOT / "js" / "data.js").read_text(encoding="utf-8")
        self.assertIn('id="recentRow"', html)
        self.assertIn('id="recentTabs"', html)
        self.assertIn('id="downloadBar"', html)
        self.assertIn('id="postForm"', html)
        self.assertIn("Tap to download", html)
        self.assertIn("Long-press", html)
        self.assertIn("Send as a post", html)
        self.assertIn("recent-tabs", css)
        self.assertIn("download-bar", css)
        self.assertIn("post-form", css)
        self.assertIn("is-selected", css)
        self.assertIn("is-together", css)
        self.assertIn("recent-slideshow", css)
        self.assertIn("flex: 1 1 0", css)
        self.assertIn("grid-template-columns: 1fr", css)
        self.assertIn("header-plate", css)
        self.assertIn("MAX_RECENTS = 3", data)
        self.assertIn("MAX_RECENT_SLIDES = 8", data)
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("toggleRecentSelection", app_js)
        self.assertIn("aria-multiselectable", app_js)
        self.assertIn("startRecentSlideshow", app_js)
        self.assertIn("recent-slideshow", app_js)

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
        self.assertIn("fun download", store)
        self.assertIn("fun recentCoverResponse", store)
        self.assertIn("nthImage", store)
        self.assertIn("MAX_RECENT_SLIDES", store)
        self.assertIn('getQueryParameter("p")', main)
        self.assertIn("fun download", main)
        self.assertIn("fun exportToFile", store)
        self.assertIn("fun share", main)
        self.assertIn("FileProvider", main)
        manifest = (ROOT / "android" / "app" / "src" / "main" / "AndroidManifest.xml").read_text(encoding="utf-8")
        self.assertIn("WRITE_EXTERNAL_STORAGE", manifest)
        self.assertIn("androidx.core.content.FileProvider", manifest)
        self.assertTrue((ROOT / "android" / "app" / "src" / "main" / "res" / "xml" / "file_paths.xml").is_file())


if __name__ == "__main__":
    unittest.main()
