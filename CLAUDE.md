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
- `flags.py` — Feature flags, option lists, enums
- `gradio_hijack.py` — Gradio component customizations (Image with brush_color support)
- `ui_gradio_extensions.py` — Injects custom JS/CSS into Gradio HTML templates
- `meta_parser.py` — Image metadata reading/writing

### Frontend Files
- `javascript/script.js` — Core: `gradioApp()`, callback system (`onUiLoaded`, `onAfterUiUpdate`), keyboard shortcuts
- `javascript/imageviewer.js` — Fullscreen lightbox modal (click image to open, arrow keys to navigate, Delete to remove)
- `javascript/zoom.js` — Canvas zoom/pan with hotkeys
- `javascript/viewer.js` — Gallery grid layout, JS-to-Python bridge pattern
- `javascript/clipboard_paste.js` — Clipboard image paste support for input components
- `javascript/edit-attention.js` — Prompt attention editing
- `javascript/contextMenus.js` — Right-click context menus
- `javascript/localization.js` — i18n support
- `css/style.css` — All custom styling (progress bars, lightbox, mobile-responsive inpaint controls)

## Critical: `ctrls` ↔ `AsyncTask` Sync
The `ctrls` list in `webui.py` (around line 1020+) defines the ordered list of all UI controls passed to `get_task()`. The `AsyncTask.__init__()` in `async_worker.py` unpacks these with `args.pop()` in **reverse order**. These two must stay in perfect sync — any mismatch causes runtime errors.

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
- **Inpaint eraser/clear** — Toggle between draw/erase mode + clear all mask button
- **Delete images** — Trash button in lightbox + Delete key, removes file from disk
- **Prompt queue** — Queue multiple prompts, processes sequentially with current settings
- **Clipboard paste** — Paste buttons on all image input tabs using Clipboard API

## Running
```bash
python launch.py  # Full launch with dependency check
python webui.py   # Direct launch (dependencies must be installed)
```
Default URL: `http://localhost:7865`
