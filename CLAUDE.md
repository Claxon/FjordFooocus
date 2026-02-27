# Fooocus (FjordFooocus) - Developer Guide

## Overview
Fooocus is a Stable Diffusion image generation UI built on **Gradio 3.41.2**. It provides inpainting, upscaling, image prompts, style management, and more through a web interface.

## Architecture

### Entry Point
- `launch.py` — Main entry, installs dependencies, downloads models, imports `webui`
- `webui.py` — Defines the entire Gradio UI (~1200 lines), event handlers, and launches the server on port 7865

### Key Modules (`modules/`)
- `async_worker.py` — `AsyncTask` class and worker thread. Task queue is `async_tasks = []` (simple list, FIFO)
- `config.py` — Configuration management (presets, paths, defaults). Cascade: defaults → preset JSON → config.txt → CLI args
- `private_logger.py` — Image saving to disk. Output path: `path_outputs/YYYY-MM-DD/filename.{png|jpg|webp}`
- `util.py` — Utilities including `generate_temp_filename()` for output filenames
- `flags.py` — Feature flags, option lists, enums (including Vary presets and `uov_list`)
- `gradio_hijack.py` — Gradio component customizations (Image with `brush_color`, `brush_radius`, `mask_opacity` support)
- `ui_gradio_extensions.py` — Injects custom JS/CSS into Gradio HTML templates
- `meta_parser.py` — Image metadata reading/writing

### Frontend Files
- `javascript/script.js` — Core: `gradioApp()`, callback system (`onUiLoaded`, `onAfterUiUpdate`), keyboard shortcuts, inpaint eraser system, `saveInpaintCanvas()`
- `javascript/imageviewer.js` — Fullscreen lightbox modal (click image to open, arrow keys to navigate, Delete to remove)
- `javascript/zoom.js` — Canvas zoom/pan with hotkeys, touch gesture support (pinch zoom, two-finger pan), `adjustBrushSize()`
- `javascript/viewer.js` — Gallery grid layout, JS-to-Python bridge pattern
- `javascript/clipboard_paste.js` — Clipboard image paste with file picker fallback for mobile, global Ctrl+V paste listener
- `javascript/edit-attention.js` — Prompt attention editing
- `javascript/contextMenus.js` — Right-click context menus
- `javascript/localization.js` — i18n support
- `css/style.css` — All custom styling (progress bars, lightbox, inpaint toolbar, mobile-responsive controls)

## Critical: `ctrls` ↔ `AsyncTask` Sync
The `ctrls` list in `webui.py` (around line 1020+) defines the ordered list of all UI controls passed to `get_task()`. The `AsyncTask.__init__()` in `async_worker.py` unpacks these with `args.pop()` in **reverse order**. These two must stay in perfect sync — any mismatch causes runtime errors.

## Gradio Sketch Canvas Internals
The inpaint canvas (`grh.Image` with `tool='sketch'`, `source='upload'`) has four canvas layers:
- **interface** (z-index 15) — Brush cursor preview. **Do not patch.**
- **mask** (z-index 13, opacity 0.7) — Where strokes are drawn in mask mode (our inpaint). Strokes go here via `stroke()` and `fill()`.
- **temp** (z-index 12) — Where strokes go in sketch mode (not used for inpaint mask).
- **drawing** (z-index 11) — Composite/commit target. Holds the source image background.

Key behaviours:
- In mask mode, `stroke()` draws directly on the mask canvas (z=13), NOT through `drawImage(temp→drawing)`.
- On mouseup, Gradio calls `ft()` which commits and exports. The `drawImage` commit is irrelevant for mask mode.
- Undo (`Le()`) removes the last stroke from history array `R`, clears temp, redraws background, then replays remaining strokes via `Oe()`.

## Inpaint Eraser System (`script.js`)
The eraser patches `stroke()`, `fill()`, and `drawImage()` on all non-interface canvases (z < 15). When erasing is active, these methods temporarily switch `globalCompositeOperation` to `'destination-out'` to remove mask pixels instead of adding them.

Three ways to activate erasing:
1. **Right mouse button** — Sets `inpaintRightButtonDown` flag
2. **Erase toggle button** — Button text switches between "⬜ Erase" / "✏️ Draw"
3. **`inpaintCurrentStrokeIsErase`** — Delayed flag (200ms after mouseup) that survives through Gradio's async commit

## Inpaint Toolbar
The toolbar is a horizontal `gr.Row` (elem_id `inpaint_toolbar`) above the canvas with these buttons:
- **Erase/Draw** — Toggles eraser mode (JS canvas patching + button label swap)
- **Undo** — Clicks Gradio's built-in `button[aria-label="Undo"]`
- **Clear** — Clicks Undo 50 times to wipe entire mask
- **Save Source** — JS: exports drawing canvas (z=11) as PNG browser download
- **Save Mask** — JS: exports mask canvas (z=13) as white-on-black PNG browser download
- **Paste** — Clipboard paste with file picker fallback for mobile

All toolbar buttons are JS-only (no `ctrls` impact). The `inpaint_eraser_state` (`gr.State`) tracks toggle state but is not in `ctrls`.

## Vary (Upscale or Variation) Presets
Defined in `modules/flags.py`, matched in `async_worker.py` `apply_vary()` via substring:
| Option | Denoising | Substring |
|--------|-----------|-----------|
| Vary (Subtle) | 0.50 | `'subtle'` |
| Vary (Moderate) | 0.625 | `'moderate'` |
| Vary (Bold) | 0.75 | `'bold'` |
| Vary (Strong) | 0.85 | `'strong'` |

Both `uov_method` and `enhance_uov_method` radio buttons reference `flags.uov_list` dynamically.

## Touch Gesture Support (`zoom.js`)
Touch event listeners use `capture: true` + `stopPropagation()` to intercept before Gradio's paint handlers:
- **Single finger** — Default Gradio paint behaviour (no intervention)
- **Two fingers** — Pan + pinch zoom. When second finger arrives, Undo is clicked to cancel accidental first-finger paint stroke.
- Brush size: **Ctrl+scroll** adjusts via `adjustBrushSize()` (targets `input[aria-label='Brush radius']`)

## JS ↔ Python Communication Pattern
Use a hidden `gr.Textbox` with `.input()` handler. JavaScript sets `.value` and dispatches an `input` Event with `{bubbles: true}`. See:
- `gradio_receiver_style_selections` (style sorting)
- `delete_image_request` (image deletion)

## Adding New JavaScript
1. Create file in `javascript/`
2. Register in `modules/ui_gradio_extensions.py` → `javascript_html()` function
3. Use `webpath()` helper for cache-busted file URLs

## Custom Features Added
- **Mixing Image Prompt toggles on main UI** — Synced checkboxes in Input Image panel
- **Inpaint toolbar** — Horizontal bar with Erase/Undo/Clear/Save Source/Save Mask/Paste
- **Inpaint eraser** — Right-click to erase, toggle button, canvas composite patching
- **Inpaint touch gestures** — Pinch zoom, two-finger pan, single finger paint
- **Delete images** — Trash button in lightbox + Delete key, removes file from disk
- **Prompt queue** — Queue multiple prompts, processes sequentially with current settings
- **Clipboard paste** — Paste buttons on all image input tabs, file picker fallback for mobile, global Ctrl+V
- **Vary presets** — Subtle/Moderate/Bold/Strong variation strength options
- **Configurable outpaint expansion** — Slider for outpaint expansion percentage

## Running
```bash
python launch.py  # Full launch with dependency check
python webui.py   # Direct launch (dependencies must be installed)
```
Default URL: `http://localhost:7865`
