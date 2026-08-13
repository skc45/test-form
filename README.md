# Aperture — full-screen image catalog

A cinematic, full-viewport photography catalog and lightbox. Open any plate to view it edge-to-edge, then browse with the keyboard, a filmstrip, or a swipe.

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8080
```

Then visit [http://localhost:8080](http://localhost:8080).

## What it does

- Full-screen catalog with a featured hero plate and a masonry or uniform grid
- Category filters, search, and local image upload (plus drag-and-drop)
- Full-screen viewer with fit/fill, zoom, pan, slideshow, and a filmstrip
- Deep links: `#photo/solstice` opens that plate directly

## Shortcuts

| Key | Action |
| --- | --- |
| `←` `→` | Previous / next |
| `Space` | Slideshow |
| `F` | Browser fullscreen |
| `C` | Fit or fill |
| `Z` / `0` | Zoom in / reset |
| `Esc` | Close viewer |
| `?` | Shortcut overlay |

Demo photographs are loaded from Unsplash, with a Picsum fallback if a remote image fails.
