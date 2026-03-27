"""Configuration for the FjordFooocus MCP server.

Resolves paths to FjordFooocus installation, models, outputs, etc.
Reads config.txt and preset JSON files without importing heavy FjordFooocus modules.
"""

import json
import os
from pathlib import Path

# Default FjordFooocus root — override via FJORD_ROOT env var
FJORD_ROOT = os.environ.get("FJORD_ROOT", str(Path(__file__).parent.parent))
SERVER_URL = os.environ.get("FJORD_SERVER_URL", "http://localhost:7865")
API_URL = os.environ.get("FJORD_API_URL", "http://localhost:7866")


def get_fjord_root() -> str:
    return os.path.abspath(FJORD_ROOT)


def get_server_url() -> str:
    return SERVER_URL


def get_api_url() -> str:
    return API_URL


def read_config_dict() -> dict:
    """Read merged config from presets/default.json + config.txt."""
    root = get_fjord_root()
    config = {}

    default_preset = os.path.join(root, "presets", "default.json")
    if os.path.exists(default_preset):
        with open(default_preset, "r", encoding="utf-8") as f:
            config.update(json.load(f))

    config_path = os.path.join(root, "config.txt")
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            config.update(json.load(f))

    return config


def resolve_model_paths(config: dict, key: str, default_subdir: str) -> list[str]:
    """Resolve model directory paths from config, falling back to default."""
    root = get_fjord_root()
    val = config.get(key)

    if isinstance(val, str):
        if os.path.isabs(val) and os.path.isdir(val):
            return [val]
        abs_path = os.path.abspath(os.path.join(root, val))
        if os.path.isdir(abs_path):
            return [abs_path]
    elif isinstance(val, list):
        resolved = []
        for v in val:
            if os.path.isabs(v) and os.path.isdir(v):
                resolved.append(v)
            else:
                abs_path = os.path.abspath(os.path.join(root, v))
                if os.path.isdir(abs_path):
                    resolved.append(abs_path)
        if resolved:
            return resolved

    # Fall back to default
    default = os.path.abspath(os.path.join(root, "models", default_subdir))
    return [default] if os.path.isdir(default) else []


def get_output_path(config: dict | None = None) -> str:
    """Get the outputs directory path."""
    if config is None:
        config = read_config_dict()
    root = get_fjord_root()
    val = config.get("path_outputs")
    if isinstance(val, str):
        if os.path.isabs(val):
            return val
        return os.path.abspath(os.path.join(root, val))
    return os.path.abspath(os.path.join(root, "..", "outputs"))
