"""Image review and discard utilities.

Provides thumbnail generation and non-destructive image discard
(move to DISCARDED/ folder) for LLM-driven quality review.
"""

import base64
import io
import json
import os
import shutil
from datetime import datetime

from PIL import Image

from . import metadata as meta


def image_to_base64(filepath: str, max_size: int = 1024) -> str | None:
    """Load image, resize to max_size on longest side, return base64 PNG string."""
    if not os.path.isfile(filepath):
        return None

    try:
        img = Image.open(filepath)
        img = img.convert("RGB")

        # Resize if needed
        w, h = img.size
        if max(w, h) > max_size:
            scale = max_size / max(w, h)
            new_w = int(w * scale)
            new_h = int(h * scale)
            img = img.resize((new_w, new_h), Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None


def review_single_image(filepath: str, max_size: int = 1024) -> dict:
    """Prepare a single image for LLM review.

    Returns image as base64 along with metadata for quality assessment.
    """
    info = meta.get_image_info(filepath)
    b64 = image_to_base64(filepath, max_size=max_size)
    info["image_base64"] = b64
    info["mime_type"] = "image/png"
    return info


def review_batch(filepaths: list[str], max_size: int = 512) -> list[dict]:
    """Prepare a batch of images as thumbnails for triage.

    Returns smaller thumbnails (default 512px) with metadata summaries.
    """
    results = []
    for filepath in filepaths:
        info = meta.get_image_info(filepath)
        b64 = image_to_base64(filepath, max_size=max_size)

        entry = {
            "path": filepath,
            "filename": info.get("filename", ""),
            "width": info.get("width"),
            "height": info.get("height"),
            "thumbnail_base64": b64,
            "mime_type": "image/png",
        }

        # Extract key metadata fields for quick triage
        md = info.get("metadata")
        if md and isinstance(md, dict):
            entry["prompt"] = md.get("prompt", "")[:200]
            entry["seed"] = md.get("seed", "")
            entry["base_model"] = md.get("base_model", "")
        else:
            entry["prompt"] = ""
            entry["seed"] = ""
            entry["base_model"] = ""

        results.append(entry)

    return results


def discard_image(filepath: str, output_dir: str, reason: str = "") -> dict:
    """Move an image to the DISCARDED/ folder structure.

    Non-destructive: the image is moved, not deleted.
    Preserves the profile/topic/date structure under DISCARDED/.

    Returns: {success, original_path, new_path, reason}
    """
    filepath = os.path.abspath(filepath)
    output_dir = os.path.abspath(output_dir)

    if not os.path.isfile(filepath):
        return {"success": False, "error": f"File not found: {filepath}"}

    # Determine where this file sits relative to the outputs directory
    temp_base = os.path.join(output_dir, "TEMPORARY")
    approved_base = os.path.join(output_dir, "APPROVED")

    rel = None
    source_category = None

    if filepath.startswith(temp_base + os.sep):
        rel = os.path.relpath(filepath, temp_base)
        source_category = "TEMPORARY"
    elif filepath.startswith(approved_base + os.sep):
        rel = os.path.relpath(filepath, approved_base)
        source_category = "APPROVED"
    else:
        # File is outside known output dirs — use filename only with today's date
        rel = os.path.join("unknown", "other", datetime.now().strftime("%Y-%m-%d"),
                           os.path.basename(filepath))
        source_category = "UNKNOWN"

    # Build discard destination
    discard_path = os.path.join(output_dir, "DISCARDED", rel)
    discard_dir = os.path.dirname(discard_path)
    os.makedirs(discard_dir, exist_ok=True)

    # Handle name collision
    if os.path.exists(discard_path):
        name, ext = os.path.splitext(os.path.basename(discard_path))
        counter = 1
        while os.path.exists(discard_path):
            discard_path = os.path.join(discard_dir, f"{name}_{counter}{ext}")
            counter += 1

    # Move the file
    try:
        shutil.move(filepath, discard_path)
    except Exception as e:
        return {"success": False, "error": f"Failed to move file: {e}"}

    # Write a discard log entry
    _log_discard(output_dir, filepath, discard_path, reason, source_category)

    return {
        "success": True,
        "original_path": filepath,
        "new_path": discard_path,
        "reason": reason,
        "source_category": source_category,
    }


def _log_discard(output_dir: str, original: str, new_path: str, reason: str, category: str):
    """Append a line to the discard log for audit trail."""
    log_path = os.path.join(output_dir, "DISCARDED", "discard_log.jsonl")
    entry = {
        "timestamp": datetime.now().isoformat(),
        "original_path": original,
        "discarded_to": new_path,
        "reason": reason,
        "source_category": category,
    }
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass
