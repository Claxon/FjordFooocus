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


def _require_auth(request: Request) -> str:
    """FastAPI dependency: extract and validate gallery session cookie.
    Returns the username. Raises 401 if not authenticated."""
    token = request.cookies.get('gallery_session')
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


def generate_thumbnail(abs_image_path, size=300):
    """Generate and cache a JPEG thumbnail. Returns bytes."""
    cached = _thumb_path(abs_image_path, size)
    if os.path.isfile(cached):
        with open(cached, 'rb') as f:
            return f.read()

    try:
        img = Image.open(abs_image_path)
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
        print(f"Gallery: thumbnail error for {abs_image_path}: {e}")
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
                        if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS)
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
            if ext not in IMAGE_EXTENSIONS:
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
                if ext not in IMAGE_EXTENSIONS:
                    continue
                filepath = os.path.join(date_path, filename)
                if not os.path.isfile(filepath):
                    continue

                if query_lower in filename.lower():
                    rel = _rel_path(filepath)
                    data = get_image_data(rel)
                    results.append({
                        "path": rel, "filename": filename,
                        "profile": prof, "topic": topic_name, "date": date_dir,
                        "rating": data.get("rating", 0), "starred": data.get("starred", False),
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
        return {"ok": True, "username": msg}

    @app.post("/api/guest")
    async def api_guest(response: FastAPIResponse):
        token = _create_session('guest')
        response.set_cookie(
            key='gallery_session', value=token,
            httponly=True, samesite='lax', max_age=86400 * 7,
        )
        return {"ok": True, "username": "guest"}

    @app.post("/api/logout")
    async def api_logout(request: Request, response: FastAPIResponse):
        token = request.cookies.get('gallery_session')
        _destroy_session(token)
        response.delete_cookie('gallery_session')
        return {"ok": True}

    @app.get("/api/me")
    async def api_me(request: Request):
        token = request.cookies.get('gallery_session')
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

    # --- API: Metadata (scoped to user's profile) ---
    @app.get("/api/metadata")
    async def api_metadata(path: str = Query(...), user: str = Depends(_require_auth)):
        rel = path.replace('\\', '/')
        if not _path_belongs_to_user(rel, user):
            raise HTTPException(status_code=403, detail="Access denied")
        abs_p = _abs_path(path)
        if not os.path.isfile(abs_p):
            raise HTTPException(status_code=404, detail="Image not found")
        meta = read_image_metadata(abs_p)
        rel = _rel_path(abs_p)
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

    # --- API: Thumbnail (scoped to user's profile) ---
    @app.get("/api/thumbnail")
    async def api_thumbnail(path: str = Query(...), size: int = Query(300),
                            user: str = Depends(_require_auth)):
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

    # --- API: Full image (scoped to user's profile) ---
    @app.get("/api/image")
    async def api_image(path: str = Query(...), user: str = Depends(_require_auth)):
        rel = path.replace('\\', '/')
        if not _path_belongs_to_user(rel, user):
            raise HTTPException(status_code=403, detail="Access denied")
        abs_p = _abs_path(path)
        if not os.path.isfile(abs_p):
            raise HTTPException(status_code=404, detail="Image not found")
        ext = os.path.splitext(abs_p)[1].lower()
        mime_map = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}
        mime = mime_map.get(ext, 'application/octet-stream')
        with open(abs_p, 'rb') as f:
            return Response(content=f.read(), media_type=mime)

    # --- API: Rate (scoped to user's profile) ---
    @app.post("/api/rate")
    async def api_rate(req: RateRequest, user: str = Depends(_require_auth)):
        rel = req.path.replace('\\', '/')
        if not _path_belongs_to_user(rel, user):
            raise HTTPException(status_code=403, detail="Access denied")
        if req.rating < 0 or req.rating > 5:
            raise HTTPException(status_code=400, detail="Rating must be 0-5")
        set_image_data(rel, {"rating": req.rating})
        return {"ok": True, "path": rel, "rating": req.rating}

    # --- API: Star (scoped to user's profile) ---
    @app.post("/api/star")
    async def api_star(req: StarRequest, user: str = Depends(_require_auth)):
        rel = req.path.replace('\\', '/')
        if not _path_belongs_to_user(rel, user):
            raise HTTPException(status_code=403, detail="Access denied")
        abs_p = _abs_path(rel)
        if not os.path.isfile(abs_p):
            raise HTTPException(status_code=404, detail="Image not found")

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

    # --- API: Delete (scoped to user's profile) ---
    @app.post("/api/delete")
    async def api_delete(req: DeleteRequest, user: str = Depends(_require_auth)):
        deleted = []
        for p in req.paths:
            rel = p.replace('\\', '/')
            if not _path_belongs_to_user(rel, user):
                continue
            abs_p = _abs_path(rel)
            if os.path.isfile(abs_p):
                try:
                    os.remove(abs_p)
                    print(f"Gallery: Deleted: {abs_p}")
                    remove_image_data(rel)
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

    # --- API: Batch (scoped to user's profile) ---
    @app.post("/api/batch")
    async def api_batch(req: BatchRequest, user: str = Depends(_require_auth)):
        results = []
        for p in req.paths:
            rel = p.replace('\\', '/')
            if not _path_belongs_to_user(rel, user):
                continue
            if req.action == "rate" and isinstance(req.value, int):
                set_image_data(rel, {"rating": req.value})
                results.append({"path": rel, "action": "rated", "value": req.value})
            elif req.action == "star" and isinstance(req.value, bool):
                abs_p = _abs_path(rel)
                if os.path.isfile(abs_p):
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
                abs_p = _abs_path(rel)
                if os.path.isfile(abs_p):
                    try:
                        os.remove(abs_p)
                        remove_image_data(rel)
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
