"""Image metadata reading using only Pillow.

Replicates read_info_from_image() from modules/meta_parser.py
without importing gradio, torch, or other heavy dependencies.
"""

import json
import os

from PIL import Image


def is_json(s: str) -> bool:
    """Check if a string is valid JSON."""
    if not isinstance(s, str):
        return False
    s = s.strip()
    if not s:
        return False
    try:
        json.loads(s)
        return True
    except (json.JSONDecodeError, ValueError):
        return False


def read_image_metadata(filepath: str) -> dict | None:
    """Read generation metadata from an image file.

    Supports:
    - PNG: parameters field in img.info
    - JPEG/WEBP: EXIF UserComment (0x9286)

    Returns parsed dict or None if no metadata found.
    """
    if not os.path.isfile(filepath):
        return None

    try:
        img = Image.open(filepath)
    except Exception:
        return None

    # Try PNG info first
    info = img.info or {}
    params = info.get("parameters") or info.get("Comment")
    if params and is_json(params):
        try:
            return json.loads(params)
        except (json.JSONDecodeError, ValueError):
            pass

    # Try EXIF
    try:
        exif = img.getexif()
        if exif:
            # UserComment (0x9286)
            user_comment = exif.get(0x9286)
            if user_comment:
                if isinstance(user_comment, bytes):
                    # Strip EXIF encoding prefix if present
                    if user_comment.startswith(b"UNICODE\x00"):
                        user_comment = user_comment[8:].decode("utf-16-le", errors="ignore")
                    elif user_comment.startswith(b"ASCII\x00\x00\x00"):
                        user_comment = user_comment[8:].decode("ascii", errors="ignore")
                    else:
                        user_comment = user_comment.decode("utf-8", errors="ignore")
                if is_json(user_comment):
                    return json.loads(user_comment)

            # MakerNote (0x927C) — some versions store here
            maker_note = exif.get(0x927C)
            if maker_note:
                if isinstance(maker_note, bytes):
                    maker_note = maker_note.decode("utf-8", errors="ignore")
                if is_json(maker_note):
                    return json.loads(maker_note)
    except Exception:
        pass

    # Return raw parameters string if it exists but isn't JSON
    if params and isinstance(params, str) and len(params) > 10:
        return {"raw_parameters": params}

    return None


def get_image_info(filepath: str) -> dict:
    """Get basic image info (dimensions, format, size) plus metadata."""
    result = {
        "path": filepath,
        "filename": os.path.basename(filepath),
        "exists": os.path.isfile(filepath),
    }

    if not result["exists"]:
        return result

    stat = os.stat(filepath)
    result["size_bytes"] = stat.st_size
    result["modified_at"] = stat.st_mtime

    try:
        img = Image.open(filepath)
        result["width"] = img.width
        result["height"] = img.height
        result["format"] = img.format
        result["mode"] = img.mode
    except Exception:
        pass

    result["metadata"] = read_image_metadata(filepath)
    return result
