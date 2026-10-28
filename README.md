# MilkDrop Visualizer — IINA plugin

MilkDrop music visualizations for [IINA](https://iina.io), in a dedicated
full-resolution window that opens automatically when IINA plays an audio
file. Audio-reactive in sync with playback (play / pause / seek / speed),
with a built-in preset picker, favorites, auto-cycling, and diagnostics.

- **1,927 unique presets** built in — the classic MilkDrop catalog, plus the
  **MilkDrop Originals** (551) and **Geiss' Favorites** (1,352) collections
  (collections keep their own full lists; "All" is deduplicated)
- Renders at your display's native resolution (Retina-aware), fullscreen
  supported
- Runs **100% locally**: no network calls, everything bundled
- Live FPS readout; diagnostics panel shows the audio pipeline state

## Install

**From IINA (once published):** Preferences → Plugins → enter this
repository's URL, or find "MilkDrop Visualizer" in the plugin list.

**From a package:** download `MilkDrop-Visualizer-<version>.iinaplgz` from
[Releases](../../releases), then IINA → Settings → Plugins → *Install from
file…* and restart IINA (or disable/re-enable the plugin).

Requires a recent IINA with plugin support. DRM-protected files (e.g. Apple
Music downloads) can't be decoded — use the picker's **Audio → Mic** mode
for those.

## Usage

Play any audio file and the visualizer window opens on its own. Inside the
window: **P** opens the preset picker (collections, search, favorites),
**D** toggles diagnostics, **F** fullscreen; the bottom bar has Random,
Cycle (with interval), Favorite ★ and source controls. The Plugin menu in
IINA mirrors these controls, and Settings → Plugins → MilkDrop Visualizer
holds the preferences (auto-open, auto-cycle, credits).

## How it works

IINA plugins are JavaScript/WebView only, so the engine is
[Butterchurn](https://github.com/jberg/butterchurn) (Jordan Berg's WebGL
port of MilkDrop). The plugin streams the playing file's bytes to the
visualizer window, which decodes them with WebAudio and plays the buffer
in sync with IINA's playback position; streams fall back to a media tap,
then microphone, then ambient motion.

## Credits

- Original Winamp Milkdrop Visualizer by Ryan Geiss.
- Presets created by the MilkDrop community authors. MilkDrop Originals and
  the MilkDrop Texture Pack via the projectM project. Geiss' Favorites
  selected by Ryan Geiss (geisswerks.com).
- Butterchurn (a WebGL implementation of the Milkdrop Visualizer), preset
  packs and .milk preset converter by Jordan Berg (jberg).

## License

Plugin code: MIT (see `LICENSE`). The bundled engine and preset packs are
the work of their respective authors above and remain under their own
terms (Butterchurn and butterchurn-presets are MIT).
