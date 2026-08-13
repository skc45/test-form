# Aperture — full-screen image catalog

A cinematic, full-viewport photography catalog. Run it as a desktop app and open any folder of images.

## Desktop app (executable)

Make the launcher executable once, then start it:

```bash
chmod +x aperture aperture.py
./aperture
```

A GUI window opens. Choose a folder of photographs, or drop a folder onto the window. Subfolders become catalog filters.

Open a folder directly:

```bash
./aperture ~/Pictures
```

Install a desktop menu entry (Linux) so Aperture appears in your app launcher and can open folders from the file manager:

```bash
./aperture --install-launcher
```

On Windows, run `aperture.bat`. The window uses Chrome/Chromium in app mode when available; otherwise it opens in your default browser.

## Browser

```bash
python3 -m http.server 8080
```

Then visit [http://localhost:8080](http://localhost:8080) and click **Open folder**.

## What it does

- Full-screen catalog with a featured hero plate and a masonry or uniform grid
- Native folder picker, drag-and-drop folders, and local file upload
- Category filters from subfolders, plus search
- Full-screen viewer with fit/fill, zoom, pan, slideshow, and a filmstrip
- Deep links: `#photo/solstice` opens that demo plate directly

## Shortcuts

| Key | Action |
| --- | --- |
| `O` | Open folder |
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
