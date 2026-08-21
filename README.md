# Aperture — full-screen image catalog

A cinematic, full-viewport photography catalog. Run it as a desktop app and open any folder of images.

## Desktop app (executable)

Make the launcher executable once, then start it:

```bash
chmod +x aperture aperture.py
./aperture
```

A GUI window opens. Choose a folder of photographs, or drop a folder onto the window. Subfolders become catalog filters. The last folder is stored in local cache and reopened automatically next time.

Open a folder directly:

```bash
./aperture ~/Pictures
```

Clear the cached folder:

```bash
./aperture --forget
```

Install a desktop menu entry (Linux) so Aperture appears in your app launcher and can open folders from the file manager:

```bash
./aperture --install-launcher
```

On Windows, run `aperture.bat`. The window uses Chrome/Chromium in app mode when available; otherwise it opens in your default browser.

## Install the Android APK

Download the installable APK from this repository:

**[releases/Aperture.apk](releases/Aperture.apk)**

On a phone (Android 8.0 or later):

1. Open the downloaded APK.
2. Allow install from Chrome or Files if Android asks.
3. Open **Aperture**, tap **Choose folder**, and pick a photo directory.

Each GitHub Actions run also publishes `Aperture.apk` as a workflow artifact.

## Android source

The `android/` folder is a native app that wraps the same catalog in a WebView. It uses the system folder picker (Storage Access Framework) and keeps the last folder in app storage so it reopens on the next launch.

To rebuild the APK:

```bash
cd android
# set sdk.dir in local.properties, then:
./gradlew :app:assembleDebug
```

The Gradle output is `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to `releases/Aperture.apk` to update the GitHub download.


## Browser

```bash
python3 -m http.server 8080
```

Then visit [http://localhost:8080](http://localhost:8080) and click **Open folder**.

## What it does

- Full-screen catalog with a featured hero plate and a masonry or uniform grid
- Native folder picker, drag-and-drop folders, and local file upload
- Local cache remembers the last folder (IndexedDB + `~/.cache/aperture/session.json`) and restores it on the next launch
- Category filters from subfolders, plus search
- Full-screen viewer with fit/fill, zoom, pan, slideshow, and a filmstrip
- Deep links: `#photo/solstice` opens that demo plate directly
- Each sent post is sealed onto a local SHA-256 hash chain (difficulty 3). Open the ledger with the chain icon or **B**

## Shortcuts

| Key | Action |
| --- | --- |
| `O` | Open folder |
| `B` | Blockchain ledger |
| `←` `→` | Previous / next |
| `Space` | Slideshow |
| `F` | Browser fullscreen |
| `C` | Fit or fill |
| `Z` / `0` | Zoom in / reset |
| `Esc` | Close viewer |
| `?` | Shortcut overlay |

Without a local folder, the demo catalog loads photographs from Unsplash, with a Picsum fallback if a remote image fails.

## Tests

```bash
python3 -m unittest tests.test_aperture
```
