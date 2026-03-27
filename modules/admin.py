"""Admin panel backend: account stats, image search, cleanup, and unsafe-prompt presets."""

import os
import re
import json
import time
from datetime import datetime, timedelta

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}

# ---------------------------------------------------------------------------
# Unsafe prompt preset filters (regex patterns)
# ---------------------------------------------------------------------------

UNSAFE_PROMPT_PRESETS = {
    'NSFW / Sexual': r'(?i)\b(nude|naked|nsfw|explicit|pornograph|hentai|erotic|sexual|xxx|topless|bottomless|genitalia|lingerie|lewd)\b',
    'Violence / Gore': r'(?i)\b(gore|gory|bloody|violence|violent|mutilat|dismember|decapitat|torture|murder|corpse|wound|stab|shoot|execution)\b',
    'Minors + Sexual': r'(?i)\b(child|underage|minor|loli|shota|young\s*girl|young\s*boy)\b.*\b(nude|naked|nsfw|sexual|erotic|explicit)\b',
    'Hate / Extremism': r'(?i)\b(nazi|white\s*supremac|racial\s*slur|swastika|kkk|hate\s*symbol|fascist\s*symbol)\b',
    'Drugs / Illegal': r'(?i)\b(cocaine|heroin|meth|drug\s*use|inject\s*drug|illegal\s*substance|crack\s*pipe)\b',
    'Weapons': r'(?i)\b(gun|firearm|rifle|pistol|assault\s*weapon|bomb|explosive|grenade|knife\s*attack)\b',
}


def get_unsafe_preset_names() -> list[str]:
    """Return list of preset filter names for UI dropdown."""
    return ['(none)'] + list(UNSAFE_PROMPT_PRESETS.keys())


def get_unsafe_preset_pattern(name: str) -> str:
    """Return the regex pattern for a given preset name."""
    return UNSAFE_PROMPT_PRESETS.get(name, '')


# ---------------------------------------------------------------------------
# Account statistics
# ---------------------------------------------------------------------------

def get_account_stats(output_dir: str, username: str | None = None) -> list[dict]:
    """Walk output tree and compute per-profile statistics.

    Returns: [{username, image_count, total_bytes, categories: {TEMPORARY: {count, bytes}, ...}}]
    """
    stats = {}  # profile_name -> {image_count, total_bytes, categories}
    categories = ['TEMPORARY', 'APPROVED', 'DISCARDED']

    for cat in categories:
        cat_dir = os.path.join(output_dir, cat)
        if not os.path.isdir(cat_dir):
            continue
        for prof_name in os.listdir(cat_dir):
            if username and prof_name.lower() != username.lower():
                continue
            prof_dir = os.path.join(cat_dir, prof_name)
            if not os.path.isdir(prof_dir):
                continue

            if prof_name not in stats:
                stats[prof_name] = {
                    'username': prof_name,
                    'image_count': 0,
                    'total_bytes': 0,
                    'categories': {},
                }

            cat_count = 0
            cat_bytes = 0
            for root, _, files in os.walk(prof_dir):
                for f in files:
                    _, ext = os.path.splitext(f)
                    if ext.lower() in IMAGE_EXTENSIONS:
                        filepath = os.path.join(root, f)
                        try:
                            size = os.path.getsize(filepath)
                        except OSError:
                            size = 0
                        cat_count += 1
                        cat_bytes += size

            stats[prof_name]['image_count'] += cat_count
            stats[prof_name]['total_bytes'] += cat_bytes
            stats[prof_name]['categories'][cat] = {
                'count': cat_count,
                'bytes': cat_bytes,
            }

    result = sorted(stats.values(), key=lambda x: x['username'].lower())
    return result


def format_bytes(size_bytes: int) -> str:
    """Human-readable file size."""
    if size_bytes < 1024:
        return f'{size_bytes} B'
    elif size_bytes < 1024 * 1024:
        return f'{size_bytes / 1024:.1f} KB'
    elif size_bytes < 1024 * 1024 * 1024:
        return f'{size_bytes / (1024 * 1024):.1f} MB'
    else:
        return f'{size_bytes / (1024 * 1024 * 1024):.2f} GB'


# ---------------------------------------------------------------------------
# Image prompt search
# ---------------------------------------------------------------------------

def _extract_prompt_text(metadata: dict | None) -> str:
    """Extract searchable prompt text from image metadata dict."""
    if metadata is None:
        return ''

    parts = []
    # Fooocus scheme stores full_prompt / raw_prompt
    for key in ('full_prompt', 'raw_prompt', 'prompt', 'Prompt',
                'full_negative_prompt', 'negative_prompt', 'Negative prompt'):
        val = metadata.get(key)
        if val and isinstance(val, str):
            parts.append(val)

    # Also check raw_parameters (A1111 format)
    raw = metadata.get('raw_parameters', '')
    if raw:
        parts.append(raw)

    return '\n'.join(parts)


def search_image_prompts(output_dir: str, query: str, profile: str | None = None,
                         date_from: str | None = None, date_to: str | None = None,
                         limit: int = 50, offset: int = 0,
                         use_regex: bool = True) -> tuple[list[dict], int]:
    """Search image prompts/metadata for matching terms.

    Returns: (results_list, total_matches)
    Each result: {path, filename, profile, topic, category, date, prompt_snippet, match}
    """
    # Lazy import to avoid circular dependencies
    import sys
    mcp_metadata_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'mcp_server')
    if mcp_metadata_path not in sys.path:
        sys.path.insert(0, mcp_metadata_path)
    from metadata import read_image_metadata

    # Compile regex pattern
    pattern = None
    if query:
        try:
            if use_regex:
                pattern = re.compile(query, re.IGNORECASE)
            else:
                pattern = re.compile(re.escape(query), re.IGNORECASE)
        except re.error:
            pattern = re.compile(re.escape(query), re.IGNORECASE)

    results = []
    total = 0
    categories = ['TEMPORARY', 'APPROVED', 'DISCARDED']

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
                topic_dir = os.path.join(prof_dir, topic_name)
                if not os.path.isdir(topic_dir):
                    continue

                # Collect all image files from this topic dir (handling dated subdirs)
                image_files = []
                if cat in ('TEMPORARY', 'DISCARDED'):
                    for date_dir in os.listdir(topic_dir):
                        if date_from and date_dir < date_from:
                            continue
                        if date_to and date_dir > date_to:
                            continue
                        date_path = os.path.join(topic_dir, date_dir)
                        if os.path.isdir(date_path):
                            for f in os.listdir(date_path):
                                _, ext = os.path.splitext(f)
                                if ext.lower() in IMAGE_EXTENSIONS:
                                    image_files.append((os.path.join(date_path, f), f, date_dir))
                else:
                    for f in os.listdir(topic_dir):
                        _, ext = os.path.splitext(f)
                        if ext.lower() in IMAGE_EXTENSIONS:
                            image_files.append((os.path.join(topic_dir, f), f, ''))

                for filepath, filename, date_str in image_files:
                    if not pattern:
                        # No query — return all
                        total += 1
                        if total > offset and len(results) < limit:
                            results.append({
                                'path': filepath,
                                'filename': filename,
                                'profile': prof_name,
                                'topic': topic_name,
                                'category': cat,
                                'date': date_str,
                                'prompt_snippet': '',
                                'match': '',
                            })
                        continue

                    # Read metadata and search
                    meta = read_image_metadata(filepath)
                    prompt_text = _extract_prompt_text(meta)
                    if not prompt_text:
                        continue

                    match = pattern.search(prompt_text)
                    if match:
                        total += 1
                        if total > offset and len(results) < limit:
                            # Create snippet around the match
                            start = max(0, match.start() - 60)
                            end = min(len(prompt_text), match.end() + 60)
                            snippet = prompt_text[start:end].replace('\n', ' ')
                            if start > 0:
                                snippet = '...' + snippet
                            if end < len(prompt_text):
                                snippet = snippet + '...'

                            results.append({
                                'path': filepath,
                                'filename': filename,
                                'profile': prof_name,
                                'topic': topic_name,
                                'category': cat,
                                'date': date_str,
                                'prompt_snippet': snippet,
                                'prompt_full': prompt_text[:500],
                                'match': match.group(0),
                            })

    return results, total


# ---------------------------------------------------------------------------
# Image cleanup
# ---------------------------------------------------------------------------

def cleanup_images(output_dir: str, profile: str | None = None,
                   max_age_days: int = 30, categories: list[str] | None = None,
                   dry_run: bool = True) -> tuple[list[str], int, int]:
    """Find and optionally delete old images.

    Returns: (deleted_paths, total_count, total_bytes)
    """
    if categories is None:
        categories = ['TEMPORARY', 'DISCARDED']

    cutoff_time = time.time() - (max_age_days * 86400)
    found_paths = []
    total_bytes = 0

    for cat in categories:
        cat_dir = os.path.join(output_dir, cat)
        if not os.path.isdir(cat_dir):
            continue

        for prof_name in os.listdir(cat_dir):
            if profile and prof_name.lower() != profile.lower():
                continue
            prof_dir = os.path.join(cat_dir, prof_name)
            if not os.path.isdir(prof_dir):
                continue

            for root, dirs, files in os.walk(prof_dir):
                for f in files:
                    _, ext = os.path.splitext(f)
                    if ext.lower() not in IMAGE_EXTENSIONS:
                        continue
                    filepath = os.path.join(root, f)
                    try:
                        stat = os.stat(filepath)
                    except OSError:
                        continue
                    if stat.st_mtime < cutoff_time:
                        found_paths.append(filepath)
                        total_bytes += stat.st_size

    if not dry_run:
        for filepath in found_paths:
            try:
                os.remove(filepath)
            except OSError:
                pass
        # Clean up empty directories
        for cat in categories:
            cat_dir = os.path.join(output_dir, cat)
            if not os.path.isdir(cat_dir):
                continue
            if profile:
                _remove_empty_dirs(os.path.join(cat_dir, profile))
            else:
                for prof_name in os.listdir(cat_dir):
                    _remove_empty_dirs(os.path.join(cat_dir, prof_name))

    return found_paths, len(found_paths), total_bytes


def _remove_empty_dirs(path: str):
    """Remove empty directories bottom-up."""
    if not os.path.isdir(path):
        return
    for root, dirs, files in os.walk(path, topdown=False):
        for d in dirs:
            dirpath = os.path.join(root, d)
            try:
                if not os.listdir(dirpath):
                    os.rmdir(dirpath)
            except OSError:
                pass
