"""Filesystem scanning for models, styles, and presets.

Replicates lightweight logic from modules/config.py and modules/sdxl_styles.py
without importing torch, gradio, or other heavy dependencies.
"""

import json
import os
from pathlib import Path

MODEL_EXTENSIONS = {".pth", ".ckpt", ".bin", ".safetensors", ".fooocus.patch"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def scan_model_dir(folders: list[str], extensions: set[str] | None = None) -> list[str]:
    """Walk folder trees and return relative paths of model files.

    Replicates get_files_from_folder() from modules/extra_utils.py.
    """
    if extensions is None:
        extensions = MODEL_EXTENSIONS

    files = []
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        for root, _, filenames in os.walk(folder, topdown=False):
            relative_path = os.path.relpath(root, folder)
            if relative_path == ".":
                relative_path = ""
            for filename in sorted(filenames, key=lambda s: s.casefold()):
                _, ext = os.path.splitext(filename)
                if ext.lower() in extensions:
                    path = os.path.join(relative_path, filename) if relative_path else filename
                    files.append(path)
    return files


def load_styles(sdxl_styles_dir: str, search: str | None = None) -> list[dict]:
    """Parse all sdxl_styles_*.json files and return style entries.

    Each entry has: name, prompt, negative_prompt, source_file.
    Optional substring filter via `search`.
    """
    styles = []
    if not os.path.isdir(sdxl_styles_dir):
        return styles

    for filename in sorted(os.listdir(sdxl_styles_dir)):
        if not filename.startswith("sdxl_styles_") or not filename.endswith(".json"):
            continue
        filepath = os.path.join(sdxl_styles_dir, filename)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list):
                continue
            for entry in data:
                name = entry.get("name", "")
                if search and search.lower() not in name.lower():
                    continue
                styles.append({
                    "name": name,
                    "prompt": entry.get("prompt", ""),
                    "negative_prompt": entry.get("negative_prompt", ""),
                    "source_file": filename,
                })
        except (json.JSONDecodeError, OSError):
            continue

    return styles


def list_presets(presets_dir: str, include_contents: bool = False) -> list[dict]:
    """List available preset JSON files.

    Returns: [{name, path, contents?}]
    """
    presets = []
    if not os.path.isdir(presets_dir):
        return presets

    for filename in sorted(os.listdir(presets_dir)):
        if not filename.endswith(".json"):
            continue
        name = filename[:-5]  # strip .json
        filepath = os.path.join(presets_dir, filename)
        entry = {"name": name, "path": filepath}
        if include_contents:
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    entry["contents"] = json.load(f)
            except (json.JSONDecodeError, OSError):
                entry["contents"] = None
        presets.append(entry)

    return presets


def scan_images(output_dir: str, profile: str | None = None, topic: str | None = None,
                category: str | None = None, date_from: str | None = None,
                date_to: str | None = None, limit: int = 50, offset: int = 0) -> list[dict]:
    """Scan output directories for generated images.

    Returns: [{path, filename, profile, topic, category, date, size_bytes, modified_at}]
    """
    images = []
    categories = [category] if category else ["TEMPORARY", "APPROVED", "DISCARDED"]

    for cat in categories:
        cat_dir = os.path.join(output_dir, cat)
        if not os.path.isdir(cat_dir):
            continue

        for prof_name in sorted(os.listdir(cat_dir)):
            if profile and prof_name.lower() != profile.lower():
                continue
            prof_dir = os.path.join(cat_dir, prof_name)
            if not os.path.isdir(prof_dir):
                continue

            for topic_name in sorted(os.listdir(prof_dir)):
                if topic and topic_name.lower() != topic.lower():
                    continue
                topic_dir = os.path.join(prof_dir, topic_name)
                if not os.path.isdir(topic_dir):
                    continue

                # For TEMPORARY/DISCARDED, images are in date subdirs
                # For APPROVED, images are directly in topic dir
                if cat in ("TEMPORARY", "DISCARDED"):
                    _scan_dated_dir(topic_dir, images, cat, prof_name, topic_name, date_from, date_to)
                else:
                    _scan_flat_dir(topic_dir, images, cat, prof_name, topic_name)

    # Sort by modified time descending (newest first)
    images.sort(key=lambda x: x["modified_at"], reverse=True)

    # Apply pagination
    return images[offset:offset + limit]


def _scan_dated_dir(topic_dir: str, images: list, category: str,
                    profile: str, topic: str, date_from: str | None, date_to: str | None):
    """Scan date-organized subdirectories (YYYY-MM-DD)."""
    for date_dir in sorted(os.listdir(topic_dir), reverse=True):
        date_path = os.path.join(topic_dir, date_dir)
        if not os.path.isdir(date_path):
            continue
        # Filter by date range
        if date_from and date_dir < date_from:
            continue
        if date_to and date_dir > date_to:
            continue
        _collect_images(date_path, images, category, profile, topic, date_dir)


def _scan_flat_dir(topic_dir: str, images: list, category: str, profile: str, topic: str):
    """Scan flat directory (no date subdirs)."""
    _collect_images(topic_dir, images, category, profile, topic, None)


def _collect_images(directory: str, images: list, category: str,
                    profile: str, topic: str, date: str | None):
    """Collect image files from a directory."""
    if not os.path.isdir(directory):
        return
    for filename in os.listdir(directory):
        _, ext = os.path.splitext(filename)
        if ext.lower() not in IMAGE_EXTENSIONS:
            continue
        filepath = os.path.join(directory, filename)
        if not os.path.isfile(filepath):
            continue
        stat = os.stat(filepath)
        images.append({
            "path": filepath,
            "filename": filename,
            "profile": profile,
            "topic": topic,
            "category": category,
            "date": date or "",
            "size_bytes": stat.st_size,
            "modified_at": stat.st_mtime,
        })
