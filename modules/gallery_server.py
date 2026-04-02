"""Gallery browser server for FjordFooocus.

Serves a standalone image gallery SPA with REST API endpoints for browsing,
searching, rating, starring, and managing generated images.

Runs as a daemon thread on port 7867 (configurable), same pattern as api_bridge.py.
"""

import json
import os
import hashlib
import re
import secrets
import shutil
import threading
import time
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI, Query, HTTPException, Request, Response as FastAPIResponse, Depends, Cookie
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel
from PIL import Image

import modules.config as config
import modules.auth as auth_module

# ---------------------------------------------------------------------------
# Session management (cookie-based auth)
# ---------------------------------------------------------------------------

_sessions = {}  # token -> username
_sessions_lock = threading.Lock()


def _create_session(username: str) -> str:
    """Create a new session token for the given username."""
    token = secrets.token_urlsafe(32)
    with _sessions_lock:
        _sessions[token] = username
    return token


def _get_session_user(token: str) -> str | None:
    """Get the username for a session token, or None if invalid."""
    if not token:
        return None
    with _sessions_lock:
        return _sessions.get(token)


def _destroy_session(token: str):
    """Remove a session token."""
    if not token:
        return
    with _sessions_lock:
        _sessions.pop(token, None)


def _extract_token(request: Request) -> str | None:
    """Extract session token from Authorization header, query param, or cookie.
    Checks in order: Bearer token header, ?token= query param, cookie.
    The query param is needed for <img src=...> URLs that can't send headers."""
    auth = request.headers.get('authorization', '')
    if auth.startswith('Bearer '):
        return auth[7:]
    token = request.query_params.get('token')
    if token:
        return token
    return request.cookies.get('gallery_session')


def _require_auth(request: Request) -> str:
    """FastAPI dependency: extract and validate gallery session token.
    Accepts Bearer token in Authorization header or gallery_session cookie.
    Returns the username. Raises 401 if not authenticated."""
    token = _extract_token(request)
    user = _get_session_user(token)
    if not user:
        raise HTTPException(status_code=401, detail='Not authenticated')
    return user


# ---------------------------------------------------------------------------
# Sidecar data manager (ratings, stars)
# ---------------------------------------------------------------------------

_gallery_data = {}
_gallery_data_lock = threading.Lock()
_gallery_data_path = None
_save_timer = None


def _get_data_path():
    global _gallery_data_path
    if _gallery_data_path is None:
        _gallery_data_path = os.path.join(config.path_outputs, 'gallery_data.json')
    return _gallery_data_path


def _load_gallery_data():
    global _gallery_data
    path = _get_data_path()
    if os.path.isfile(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                _gallery_data = json.load(f)
        except (json.JSONDecodeError, OSError):
            _gallery_data = {}
    else:
        _gallery_data = {}


def _save_gallery_data():
    """Save gallery data to disk (debounced — called after a short delay)."""
    path = _get_data_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(_gallery_data, f, indent=1)
    except OSError as e:
        print(f"Gallery: failed to save data: {e}")


def _schedule_save():
    """Debounce saves — write at most once per second."""
    global _save_timer
    if _save_timer is not None:
        _save_timer.cancel()
    _save_timer = threading.Timer(1.0, _save_gallery_data)
    _save_timer.daemon = True
    _save_timer.start()


def _rel_path(abs_path):
    """Convert absolute path to relative path from path_outputs."""
    try:
        return os.path.relpath(abs_path, config.path_outputs).replace('\\', '/')
    except ValueError:
        return abs_path.replace('\\', '/')


def _abs_path(rel_or_abs):
    """Convert relative-to-outputs path to absolute, or return as-is if already absolute."""
    if os.path.isabs(rel_or_abs):
        return rel_or_abs
    return os.path.join(config.path_outputs, rel_or_abs.replace('/', os.sep))


def get_image_data(rel_key):
    """Get rating/star data for an image."""
    with _gallery_data_lock:
        return _gallery_data.get(rel_key, {})


def set_image_data(rel_key, data):
    """Set rating/star data for an image."""
    with _gallery_data_lock:
        if rel_key not in _gallery_data:
            _gallery_data[rel_key] = {}
        _gallery_data[rel_key].update(data)
        _schedule_save()


def remove_image_data(rel_key):
    """Remove an image's data entry."""
    with _gallery_data_lock:
        _gallery_data.pop(rel_key, None)
        _schedule_save()


# ---------------------------------------------------------------------------
# Thumbnail cache
# ---------------------------------------------------------------------------

THUMB_DIR = None
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
VIDEO_EXTENSIONS = {'.mp4', '.webm', '.mov', '.avi', '.mkv'}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS


def _get_thumb_dir():
    global THUMB_DIR
    if THUMB_DIR is None:
        THUMB_DIR = os.path.join(config.path_outputs, '.thumbnails')
        os.makedirs(THUMB_DIR, exist_ok=True)
    return THUMB_DIR


def _thumb_path(abs_image_path, size=300):
    """Get cached thumbnail path. Uses hash of path + mtime for cache key."""
    try:
        stat = os.stat(abs_image_path)
        key = f"{abs_image_path}|{stat.st_mtime}|{size}"
    except OSError:
        key = f"{abs_image_path}|0|{size}"
    h = hashlib.md5(key.encode()).hexdigest()
    return os.path.join(_get_thumb_dir(), f"{h}.jpg")


def _extract_video_frame(video_path):
    """Extract a frame from a video file using ffmpeg. Returns PIL Image or None."""
    import subprocess
    import tempfile
    try:
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            tmp_path = tmp.name
        # Extract frame at 1 second (or first frame if video is shorter)
        subprocess.run(
            ['ffmpeg', '-y', '-i', video_path, '-ss', '1', '-vframes', '1',
             '-q:v', '2', tmp_path],
            capture_output=True, timeout=15,
        )
        if os.path.isfile(tmp_path) and os.path.getsize(tmp_path) > 0:
            img = Image.open(tmp_path)
            img.load()  # ensure fully loaded before we delete the temp file
            os.unlink(tmp_path)
            return img
        # Try again at t=0 if t=1 failed (very short video)
        subprocess.run(
            ['ffmpeg', '-y', '-i', video_path, '-vframes', '1',
             '-q:v', '2', tmp_path],
            capture_output=True, timeout=15,
        )
        if os.path.isfile(tmp_path) and os.path.getsize(tmp_path) > 0:
            img = Image.open(tmp_path)
            img.load()
            os.unlink(tmp_path)
            return img
        os.unlink(tmp_path)
    except Exception as e:
        print(f"Gallery: video frame extraction failed for {video_path}: {e}")
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    return None


def generate_thumbnail(abs_media_path, size=300):
    """Generate and cache a JPEG thumbnail. Supports images and videos. Returns bytes."""
    cached = _thumb_path(abs_media_path, size)
    if os.path.isfile(cached):
        with open(cached, 'rb') as f:
            return f.read()

    ext = os.path.splitext(abs_media_path)[1].lower()
    try:
        if ext in VIDEO_EXTENSIONS:
            img = _extract_video_frame(abs_media_path)
            if img is None:
                return None
        else:
            img = Image.open(abs_media_path)

        img.thumbnail((size, size), Image.LANCZOS)
        if img.mode in ('RGBA', 'P'):
            bg = Image.new('RGB', img.size, (32, 32, 32))
            bg.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        buf = BytesIO()
        img.save(buf, format='JPEG', quality=85)
        data = buf.getvalue()

        os.makedirs(os.path.dirname(cached), exist_ok=True)
        with open(cached, 'wb') as f:
            f.write(data)
        return data
    except Exception as e:
        print(f"Gallery: thumbnail error for {abs_media_path}: {e}")
        return None


# ---------------------------------------------------------------------------
# Metadata reader (lightweight, no torch/gradio)
# ---------------------------------------------------------------------------

def read_image_metadata(filepath):
    """Read generation metadata from image. Returns dict or None."""
    try:
        from mcp_server.metadata import read_image_metadata as _read
        return _read(filepath)
    except ImportError:
        pass

    # Inline fallback
    if not os.path.isfile(filepath):
        return None
    try:
        img = Image.open(filepath)
        info = img.info or {}
        params = info.get("parameters") or info.get("Comment")
        if params:
            try:
                return json.loads(params)
            except (json.JSONDecodeError, ValueError):
                return {"raw_parameters": params} if len(params) > 10 else None

        exif = img.getexif()
        if exif:
            uc = exif.get(0x9286)
            if uc:
                if isinstance(uc, bytes):
                    if uc.startswith(b"UNICODE\x00"):
                        uc = uc[8:].decode("utf-16-le", errors="ignore")
                    elif uc.startswith(b"ASCII\x00\x00\x00"):
                        uc = uc[8:].decode("ascii", errors="ignore")
                    else:
                        uc = uc.decode("utf-8", errors="ignore")
                try:
                    return json.loads(uc)
                except (json.JSONDecodeError, ValueError):
                    pass
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Browse-mode helpers (arbitrary directory browsing)
# ---------------------------------------------------------------------------

def _resolve_browse_path(path_param: str) -> str | None:
    """If path starts with ABS: prefix, return the resolved absolute path.
    Returns None if not a browse-mode path."""
    if path_param.startswith('ABS:'):
        return os.path.realpath(path_param[4:])
    return None


def _scan_directory_images(directory: str, offset: int = 0, limit: int = 200, max_scan: int = 10000):
    """Recursively scan a directory for images.
    Returns (images_list, total_count, truncated)."""
    directory = os.path.realpath(directory)
    all_files = []
    scanned = 0
    truncated = False

    for root, dirs, files in os.walk(directory):
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in MEDIA_EXTENSIONS:
                continue
            filepath = os.path.join(root, fname)
            try:
                stat = os.stat(filepath)
                all_files.append((filepath, stat.st_mtime, stat.st_size))
            except OSError:
                continue
            scanned += 1
            if scanned >= max_scan:
                truncated = True
                break
        if truncated:
            break

    # Sort by modification time descending (newest first)
    all_files.sort(key=lambda x: x[1], reverse=True)
    total = len(all_files)
    page = all_files[offset:offset + limit]

    images = []
    for filepath, mtime, size in page:
        ext = os.path.splitext(filepath)[1].lower()
        rel_from_dir = os.path.relpath(filepath, directory).replace('\\', '/')
        subfolder = os.path.dirname(rel_from_dir) if '/' in rel_from_dir else ''
        abs_key = 'ABS:' + filepath.replace('\\', '/')
        data = get_image_data(abs_key)
        images.append({
            "path": abs_key,
            "filename": os.path.basename(filepath),
            "subfolder": subfolder,
            "size_bytes": size,
            "modified_at": mtime,
            "rating": data.get("rating", 0),
            "starred": data.get("starred", False),
            "is_video": ext in VIDEO_EXTENSIONS,
        })

    return images, total, truncated


def _list_directory_children(directory: str):
    """List subdirectories of a given directory. Returns list of dicts."""
    directory = os.path.realpath(directory)
    results = []
    try:
        for name in sorted(os.listdir(directory)):
            full = os.path.join(directory, name)
            if os.path.isdir(full) and not name.startswith('.'):
                has_children = False
                try:
                    has_children = any(
                        os.path.isdir(os.path.join(full, c))
                        for c in os.listdir(full)
                        if not c.startswith('.')
                    )
                except OSError:
                    pass
                results.append({
                    "name": name,
                    "path": full.replace('\\', '/'),
                    "has_children": has_children,
                })
    except OSError:
        pass
    return results


def _get_drive_roots():
    """Get available drive roots (Windows) or filesystem roots."""
    import platform
    if platform.system() == 'Windows':
        import string
        drives = []
        for letter in string.ascii_uppercase:
            drive = f"{letter}:\\"
            if os.path.isdir(drive):
                drives.append({
                    "name": f"{letter}:",
                    "path": f"{letter}:/",
                    "has_children": True,
                })
        return drives
    else:
        return [{"name": "/", "path": "/", "has_children": True}]


def _pick_directory_dialog(initial_dir: str | None = None) -> str | None:
    """Open a native OS folder picker dialog. Returns selected path or None."""
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    kwargs = {'title': 'Select Folder'}
    if initial_dir and os.path.isdir(initial_dir):
        kwargs['initialdir'] = initial_dir
    result = filedialog.askdirectory(**kwargs)
    root.destroy()
    return result if result else None


# ---------------------------------------------------------------------------
# Directory scanning
# ---------------------------------------------------------------------------

def list_profiles():
    """List all profiles across TEMPORARY and APPROVED."""
    profiles = set()
    for cat in ('TEMPORARY', 'APPROVED', 'DISCARDED'):
        cat_dir = os.path.join(config.path_outputs, cat)
        if os.path.isdir(cat_dir):
            for name in os.listdir(cat_dir):
                if os.path.isdir(os.path.join(cat_dir, name)):
                    profiles.add(name)
    return sorted(profiles)


def list_topics(profiles=None):
    """List all topics for given profiles (or all if None)."""
    topics = set()
    all_profiles = profiles if profiles else list_profiles()
    for prof in all_profiles:
        for cat in ('TEMPORARY', 'APPROVED', 'DISCARDED'):
            prof_dir = os.path.join(config.path_outputs, cat, prof)
            if os.path.isdir(prof_dir):
                for name in os.listdir(prof_dir):
                    if os.path.isdir(os.path.join(prof_dir, name)):
                        topics.add(name)
    return sorted(topics)


def _iter_profile_topic_dirs(profiles=None, topics=None):
    """Yield (profile, topic_name, topic_path) for matching profiles/topics."""
    all_profiles = profiles if profiles else list_profiles()
    for prof in all_profiles:
        base = os.path.join(config.path_outputs, 'TEMPORARY', prof)
        if not os.path.isdir(base):
            continue
        if topics:
            for t in topics:
                td = os.path.join(base, t)
                if os.path.isdir(td):
                    yield prof, t, td
        else:
            for t in os.listdir(base):
                td = os.path.join(base, t)
                if os.path.isdir(td):
                    yield prof, t, td


def list_dates(profiles=None, topics=None, date_from=None, date_to=None):
    """List available dates with image counts. Supports multi-profile and date range."""
    dates = {}
    for prof, topic_name, topic_path in _iter_profile_topic_dirs(profiles, topics):
        for date_dir in os.listdir(topic_path):
            date_path = os.path.join(topic_path, date_dir)
            if not os.path.isdir(date_path):
                continue
            if date_from and date_dir < date_from:
                continue
            if date_to and date_dir > date_to:
                continue
            count = sum(1 for f in os.listdir(date_path)
                        if os.path.splitext(f)[1].lower() in MEDIA_EXTENSIONS)
            if count > 0:
                if date_dir not in dates:
                    dates[date_dir] = 0
                dates[date_dir] += count

    return [{"date": d, "count": c} for d, c in sorted(dates.items(), reverse=True)]


def list_images_for_date(date_str, profiles=None, topics=None):
    """List images for a date across multiple profiles/topics."""
    images = []
    for prof, topic_name, topic_path in _iter_profile_topic_dirs(profiles, topics):
        date_path = os.path.join(topic_path, date_str)
        if not os.path.isdir(date_path):
            continue
        for filename in os.listdir(date_path):
            ext = os.path.splitext(filename)[1].lower()
            if ext not in MEDIA_EXTENSIONS:
                continue
            filepath = os.path.join(date_path, filename)
            if not os.path.isfile(filepath):
                continue
            rel = _rel_path(filepath)
            data = get_image_data(rel)
            try:
                stat = os.stat(filepath)
                size = stat.st_size
                mtime = stat.st_mtime
            except OSError:
                size = 0
                mtime = 0
            images.append({
                "path": rel,
                "filename": filename,
                "profile": prof,
                "topic": topic_name,
                "date": date_str,
                "size_bytes": size,
                "modified_at": mtime,
                "rating": data.get("rating", 0),
                "starred": data.get("starred", False),
                "is_video": ext in VIDEO_EXTENSIONS,
            })

    images.sort(key=lambda x: x["modified_at"], reverse=True)
    return images


def search_images(query, profiles=None, topics=None, date_from=None, date_to=None, limit=100):
    """Search images by metadata content. Supports multi-profile and date range."""
    query_lower = query.lower()
    results = []

    for prof, topic_name, topic_path in _iter_profile_topic_dirs(profiles, topics):
        for date_dir in sorted(os.listdir(topic_path), reverse=True):
            date_path = os.path.join(topic_path, date_dir)
            if not os.path.isdir(date_path):
                continue
            if date_from and date_dir < date_from:
                continue
            if date_to and date_dir > date_to:
                continue
            for filename in os.listdir(date_path):
                ext = os.path.splitext(filename)[1].lower()
                if ext not in MEDIA_EXTENSIONS:
                    continue
                filepath = os.path.join(date_path, filename)
                if not os.path.isfile(filepath):
                    continue

                is_vid = ext in VIDEO_EXTENSIONS
                if query_lower in filename.lower():
                    rel = _rel_path(filepath)
                    data = get_image_data(rel)
                    results.append({
                        "path": rel, "filename": filename,
                        "profile": prof, "topic": topic_name, "date": date_dir,
                        "rating": data.get("rating", 0), "starred": data.get("starred", False),
                        "is_video": is_vid,
                    })
                    if len(results) >= limit:
                        return results
                    continue

                meta = read_image_metadata(filepath)
                if meta:
                    meta_str = json.dumps(meta, default=str).lower()
                    if query_lower in meta_str:
                        rel = _rel_path(filepath)
                        data = get_image_data(rel)
                        results.append({
                            "path": rel, "filename": filename,
                            "profile": prof, "topic": topic_name, "date": date_dir,
                            "rating": data.get("rating", 0), "starred": data.get("starred", False),
                            "is_video": is_vid,
                        })
                        if len(results) >= limit:
                            return results

    return results


# ---------------------------------------------------------------------------
# Pydantic models for POST endpoints
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# NSFW / Safe-mode filtering
# ---------------------------------------------------------------------------

_nsfw_pattern = None


def _get_nsfw_pattern():
    """Load the NSFW regex pattern from admin presets."""
    global _nsfw_pattern
    if _nsfw_pattern is None:
        try:
            from modules.admin import UNSAFE_PROMPT_PRESETS
            _nsfw_pattern = UNSAFE_PROMPT_PRESETS.get('NSFW / Sexual', '')
        except ImportError:
            _nsfw_pattern = r'(?i)\b(nude|naked|nsfw|explicit|pornograph|hentai|erotic|sexual|xxx|topless|bottomless|genitalia|lingerie|lewd)\b'
    return _nsfw_pattern


def is_nsfw(filepath):
    """Check if an image's metadata matches NSFW patterns."""
    pattern = _get_nsfw_pattern()
    if not pattern:
        return False
    meta = read_image_metadata(filepath)
    if not meta:
        return False
    meta_str = json.dumps(meta, default=str)
    return bool(re.search(pattern, meta_str))


# Metadata NSFW cache (path → bool) to avoid re-reading images
_nsfw_cache = {}
_nsfw_cache_lock = threading.Lock()


def is_nsfw_cached(filepath):
    """Cached NSFW check."""
    with _nsfw_cache_lock:
        if filepath in _nsfw_cache:
            return _nsfw_cache[filepath]
    result = is_nsfw(filepath)
    with _nsfw_cache_lock:
        _nsfw_cache[filepath] = result
    return result


# ---------------------------------------------------------------------------
# Pydantic models for POST endpoints
# ---------------------------------------------------------------------------

class RateRequest(BaseModel):
    path: str
    rating: int


class StarRequest(BaseModel):
    path: str
    starred: bool


class DeleteRequest(BaseModel):
    paths: list[str]


class BatchRequest(BaseModel):
    paths: list[str]
    action: str  # "rate", "star", "delete"
    value: int | bool | None = None


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str
    password: str


def _path_belongs_to_user(rel_path: str, username: str) -> bool:
    """Check if an image path belongs to the given user's profile.
    Paths are like: TEMPORARY/<profile>/<topic>/<date>/file.png"""
    parts = rel_path.replace('\\', '/').split('/')
    # Expected: category/profile/topic/date/filename
    if len(parts) >= 2:
        return parts[1].lower() == username.lower() or parts[0].lower() == username.lower()
    return False


def create_app():
    app = FastAPI(title="FjordFooocus Gallery")

    # Allow cross-origin requests from the Gradio UI (regenerate.js fetches from here).
    # Use allow_origin_regex to match any localhost port so credentials work cross-port.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=True,
    )

    @app.on_event("startup")
    async def startup():
        _load_gallery_data()

    # --- Serve gallery HTML (no auth — login page is inside the SPA) ---
    @app.get("/", response_class=HTMLResponse)
    async def serve_gallery():
        html_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'gallery', 'index.html')
        if not os.path.isfile(html_path):
            return HTMLResponse("<h1>Gallery not found</h1><p>gallery/index.html is missing.</p>", status_code=404)
        with open(html_path, 'r', encoding='utf-8') as f:
            return f.read()

    # --- Auth endpoints (no auth required) ---
    @app.post("/api/login")
    async def api_login(req: LoginRequest, response: FastAPIResponse):
        success, msg = auth_module.authenticate(req.username, req.password)
        if not success:
            raise HTTPException(status_code=401, detail=msg)
        # msg is the canonical username on success
        token = _create_session(msg)
        response.set_cookie(
            key='gallery_session', value=token,
            httponly=True, samesite='lax', max_age=86400 * 7,
        )
        # Return token in body so JS can use it in Authorization headers
        # (cookies may be blocked in cross-port iframe contexts)
        return {"ok": True, "username": msg, "token": token}

    @app.post("/api/guest")
    async def api_guest(response: FastAPIResponse):
        token = _create_session('guest')
        response.set_cookie(
            key='gallery_session', value=token,
            httponly=True, samesite='lax', max_age=86400 * 7,
        )
        return {"ok": True, "username": "guest", "token": token}

    @app.get("/embed-login")
    async def embed_login(request: Request, user: str = Query(...)):
        """Server-side login for iframe embedding. Passes auth token via URL
        fragment so the gallery JS can use it in Authorization headers.
        Cookies alone are unreliable in cross-port iframes due to browser
        third-party cookie partitioning."""
        host = request.client.host if request.client else ''
        if host not in ('127.0.0.1', '::1', 'localhost'):
            raise HTTPException(status_code=403, detail='Embed auth only from localhost')
        if not user or not user.strip():
            raise HTTPException(status_code=400, detail='User required')
        token = _create_session(user.strip())
        # Pass token in URL query param; the gallery JS will extract it and
        # use it as a Bearer token in Authorization headers for API calls.
        response = FastAPIResponse(status_code=302)
        response.headers['location'] = f'/?embed=1&token={token}'
        # Also set cookie as fallback for same-origin access
        response.set_cookie(
            key='gallery_session', value=token,
            httponly=True, samesite='lax', max_age=86400 * 7,
        )
        return response

    @app.post("/api/logout")
    async def api_logout(request: Request, response: FastAPIResponse):
        token = _extract_token(request)
        _destroy_session(token)
        response.delete_cookie('gallery_session')
        return {"ok": True}

    @app.get("/api/me")
    async def api_me(request: Request):
        token = _extract_token(request)
        user = _get_session_user(token)
        if not user:
            return {"authenticated": False}
        return {"authenticated": True, "username": user}

    # --- API: Topics (scoped to user's profile) ---
    @app.get("/api/topics")
    async def api_topics(user: str = Depends(_require_auth)):
        return list_topics([user])

    # --- API: Dates (scoped to user's profile) ---
    @app.get("/api/dates")
    async def api_dates(topics: str = Query(None),
                        date_from: str = Query(None), date_to: str = Query(None),
                        user: str = Depends(_require_auth)):
        t = [x.strip() for x in topics.split(',') if x.strip()] if topics else None
        return list_dates([user], t, date_from, date_to)

    # --- API: NSFW pattern (for client-side reference) ---
    @app.get("/api/nsfw-pattern")
    async def api_nsfw_pattern(user: str = Depends(_require_auth)):
        return {"pattern": _get_nsfw_pattern()}

    # --- API: Images for a date (scoped to user's profile) ---
    @app.get("/api/images")
    async def api_images(date: str = Query(...), topics: str = Query(None),
                         safe_mode: bool = Query(False),
                         user: str = Depends(_require_auth)):
        t = [x.strip() for x in topics.split(',') if x.strip()] if topics else None
        images = list_images_for_date(date, [user], t)
        if safe_mode:
            images = [i for i in images if not is_nsfw_cached(_abs_path(i['path']))]
        return images

    # --- API: Metadata (supports profile-scoped and ABS: browse paths) ---
    @app.get("/api/metadata")
    async def api_metadata(path: str = Query(...), user: str = Depends(_require_auth)):
        browse_abs = _resolve_browse_path(path)
        if browse_abs:
            abs_p = browse_abs
            ext = os.path.splitext(abs_p)[1].lower()
            if ext not in MEDIA_EXTENSIONS:
                raise HTTPException(status_code=400, detail="Not an image file")
            data_key = path.replace('\\', '/')
        else:
            rel = path.replace('\\', '/')
            if not _path_belongs_to_user(rel, user):
                raise HTTPException(status_code=403, detail="Access denied")
            abs_p = _abs_path(path)
            data_key = None
        if not os.path.isfile(abs_p):
            raise HTTPException(status_code=404, detail="Image not found")
        meta = read_image_metadata(abs_p)
        rel = data_key if data_key else _rel_path(abs_p)
        data = get_image_data(rel)
        try:
            img = Image.open(abs_p)
            w, h = img.size
            fmt = img.format
        except Exception:
            w = h = 0
            fmt = "unknown"
        return {
            "path": rel,
            "filename": os.path.basename(abs_p),
            "width": w,
            "height": h,
            "format": fmt,
            "size_bytes": os.path.getsize(abs_p),
            "metadata": meta,
            "rating": data.get("rating", 0),
            "starred": data.get("starred", False),
        }

    # --- API: Search (scoped to user's profile) ---
    @app.get("/api/search")
    async def api_search(q: str = Query(...), topics: str = Query(None),
                         date_from: str = Query(None), date_to: str = Query(None),
                         limit: int = Query(100), safe_mode: bool = Query(False),
                         user: str = Depends(_require_auth)):
        t = [x.strip() for x in topics.split(',') if x.strip()] if topics else None
        results = search_images(q, [user], t, date_from, date_to, limit if not safe_mode else limit * 2)
        if safe_mode:
            results = [i for i in results if not is_nsfw_cached(_abs_path(i['path']))]
            results = results[:limit]
        return results

    # --- API: Browse directory (arbitrary path) ---
    @app.get("/api/browse")
    async def api_browse(dir: str = Query(...), offset: int = Query(0),
                         limit: int = Query(200), safe_mode: bool = Query(False),
                         user: str = Depends(_require_auth)):
        resolved = os.path.realpath(dir)
        if not os.path.isdir(resolved):
            raise HTTPException(status_code=404, detail="Directory not found")
        limit = min(max(limit, 1), 500)
        offset = max(offset, 0)
        images, total, truncated = _scan_directory_images(resolved, offset, limit)
        if safe_mode:
            images = [i for i in images if not is_nsfw_cached(
                _resolve_browse_path(i['path']) or '')]
        return {"images": images, "total": total, "dir": resolved.replace('\\', '/'),
                "truncated": truncated, "offset": offset, "limit": limit}

    # --- API: List directories (for folder picker) ---
    @app.get("/api/list-dirs")
    async def api_list_dirs(dir: str = Query(None),
                            user: str = Depends(_require_auth)):
        if not dir:
            return _get_drive_roots()
        resolved = os.path.realpath(dir)
        if not os.path.isdir(resolved):
            raise HTTPException(status_code=404, detail="Directory not found")
        return _list_directory_children(resolved)

    # --- API: Pick directory (native OS dialog) ---
    @app.get("/api/pick-directory")
    async def api_pick_directory(current: str = Query(None),
                                 user: str = Depends(_require_auth)):
        import asyncio
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _pick_directory_dialog, current)
        if not result:
            return {"picked": False, "dir": None}
        return {"picked": True, "dir": result.replace('\\', '/')}

    # --- API: Thumbnail (supports profile-scoped and ABS: browse paths) ---
    @app.get("/api/thumbnail")
    async def api_thumbnail(path: str = Query(...), size: int = Query(300),
                            user: str = Depends(_require_auth)):
        browse_abs = _resolve_browse_path(path)
        if browse_abs:
            abs_p = browse_abs
            ext = os.path.splitext(abs_p)[1].lower()
            if ext not in MEDIA_EXTENSIONS:
                raise HTTPException(status_code=400, detail="Not an image file")
        else:
            rel = path.replace('\\', '/')
            if not _path_belongs_to_user(rel, user):
                raise HTTPException(status_code=403, detail="Access denied")
            abs_p = _abs_path(path)
        if not os.path.isfile(abs_p):
            raise HTTPException(status_code=404, detail="Image not found")
        size = min(max(size, 50), 800)
        data = generate_thumbnail(abs_p, size)
        if data is None:
            raise HTTPException(status_code=500, detail="Thumbnail generation failed")
        return Response(content=data, media_type="image/jpeg")

    # --- API: Full image (supports profile-scoped and ABS: browse paths) ---
    @app.get("/api/image")
    async def api_image(path: str = Query(...), user: str = Depends(_require_auth)):
        browse_abs = _resolve_browse_path(path)
        if browse_abs:
            abs_p = browse_abs
            ext = os.path.splitext(abs_p)[1].lower()
            if ext not in MEDIA_EXTENSIONS:
                raise HTTPException(status_code=400, detail="Not an image file")
        else:
            rel = path.replace('\\', '/')
            if not _path_belongs_to_user(rel, user):
                raise HTTPException(status_code=403, detail="Access denied")
            abs_p = _abs_path(path)
        if not os.path.isfile(abs_p):
            raise HTTPException(status_code=404, detail="Image not found")
        ext = os.path.splitext(abs_p)[1].lower()
        mime_map = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
            '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
            '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
        }
        mime = mime_map.get(ext, 'application/octet-stream')
        # For video files, use streaming response to support seeking
        if ext in VIDEO_EXTENSIONS:
            from starlette.responses import FileResponse
            return FileResponse(abs_p, media_type=mime)
        with open(abs_p, 'rb') as f:
            return Response(content=f.read(), media_type=mime)

    # --- API: Rate (supports profile-scoped and ABS: browse paths) ---
    @app.post("/api/rate")
    async def api_rate(req: RateRequest, user: str = Depends(_require_auth)):
        rel = req.path.replace('\\', '/')
        is_browse = _resolve_browse_path(rel) is not None
        if not is_browse and not _path_belongs_to_user(rel, user):
            raise HTTPException(status_code=403, detail="Access denied")
        if req.rating < 0 or req.rating > 5:
            raise HTTPException(status_code=400, detail="Rating must be 0-5")
        set_image_data(rel, {"rating": req.rating})
        return {"ok": True, "path": rel, "rating": req.rating}

    # --- API: Star (supports profile-scoped and ABS: browse paths) ---
    @app.post("/api/star")
    async def api_star(req: StarRequest, user: str = Depends(_require_auth)):
        rel = req.path.replace('\\', '/')
        browse_abs = _resolve_browse_path(rel)
        if browse_abs:
            abs_p = browse_abs
        else:
            if not _path_belongs_to_user(rel, user):
                raise HTTPException(status_code=403, detail="Access denied")
            abs_p = _abs_path(rel)
        if not os.path.isfile(abs_p):
            raise HTTPException(status_code=404, detail="Image not found")

        # Only copy to approved folder for profile-scoped images, not browse-mode
        if not browse_abs:
            if req.starred:
                approved_path = config.get_approved_output_path(abs_p)
                if approved_path:
                    os.makedirs(os.path.dirname(approved_path), exist_ok=True)
                    shutil.copy2(abs_p, approved_path)
                    print(f"Gallery: Approved: {abs_p} -> {approved_path}")
            else:
                approved_path = config.get_approved_output_path(abs_p)
                if approved_path and os.path.isfile(approved_path):
                    os.remove(approved_path)
                    print(f"Gallery: Unapproved: {approved_path}")

        set_image_data(rel, {"starred": req.starred})
        return {"ok": True, "path": rel, "starred": req.starred}

    # --- API: Delete (supports profile-scoped and ABS: browse paths) ---
    @app.post("/api/delete")
    async def api_delete(req: DeleteRequest, user: str = Depends(_require_auth)):
        deleted = []
        for p in req.paths:
            rel = p.replace('\\', '/')
            browse_abs = _resolve_browse_path(rel)
            if browse_abs:
                abs_p = browse_abs
            else:
                if not _path_belongs_to_user(rel, user):
                    continue
                abs_p = _abs_path(rel)
            if os.path.isfile(abs_p):
                try:
                    os.remove(abs_p)
                    print(f"Gallery: Deleted: {abs_p}")
                    remove_image_data(rel)
                    if not browse_abs:
                        approved = config.get_approved_output_path(abs_p)
                        if approved and os.path.isfile(approved):
                            os.remove(approved)
                    thumb = _thumb_path(abs_p)
                    if os.path.isfile(thumb):
                        os.remove(thumb)
                    deleted.append(rel)
                except OSError as e:
                    print(f"Gallery: Delete failed for {abs_p}: {e}")
        return {"ok": True, "deleted": deleted}

    # --- API: Batch (supports profile-scoped and ABS: browse paths) ---
    @app.post("/api/batch")
    async def api_batch(req: BatchRequest, user: str = Depends(_require_auth)):
        results = []
        for p in req.paths:
            rel = p.replace('\\', '/')
            browse_abs = _resolve_browse_path(rel)
            if not browse_abs and not _path_belongs_to_user(rel, user):
                continue
            abs_p = browse_abs if browse_abs else _abs_path(rel)
            if req.action == "rate" and isinstance(req.value, int):
                set_image_data(rel, {"rating": req.value})
                results.append({"path": rel, "action": "rated", "value": req.value})
            elif req.action == "star" and isinstance(req.value, bool):
                if os.path.isfile(abs_p):
                    if not browse_abs:
                        if req.value:
                            approved = config.get_approved_output_path(abs_p)
                            if approved:
                                os.makedirs(os.path.dirname(approved), exist_ok=True)
                                shutil.copy2(abs_p, approved)
                        else:
                            approved = config.get_approved_output_path(abs_p)
                            if approved and os.path.isfile(approved):
                                os.remove(approved)
                    set_image_data(rel, {"starred": req.value})
                    results.append({"path": rel, "action": "starred", "value": req.value})
            elif req.action == "delete":
                if os.path.isfile(abs_p):
                    try:
                        os.remove(abs_p)
                        remove_image_data(rel)
                        if not browse_abs:
                            approved = config.get_approved_output_path(abs_p)
                            if approved and os.path.isfile(approved):
                                os.remove(approved)
                        thumb = _thumb_path(abs_p)
                        if os.path.isfile(thumb):
                            os.remove(thumb)
                        results.append({"path": rel, "action": "deleted"})
                    except OSError:
                        pass
        return {"ok": True, "results": results}

    return app


# ---------------------------------------------------------------------------
# Server start
# ---------------------------------------------------------------------------

def start_gallery_server(port=7867):
    """Start the gallery server as a standalone daemon thread."""
    import uvicorn

    _load_gallery_data()
    app = create_app()

    def _run():
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    print(f"Gallery browser started on http://127.0.0.1:{port}")
