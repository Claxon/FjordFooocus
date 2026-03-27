"""FjordFooocus MCP Server.

Provides LLM-accessible tools for discovering models/styles/presets,
browsing generated images, reviewing image quality, and submitting
generation tasks to a running FjordFooocus instance.

Usage:
    python -m mcp_server.server        (stdio transport)
    FJORD_ROOT=/path/to/fjord python -m mcp_server.server
"""

import json
import os
import sys
from datetime import datetime
from typing import Annotated

from mcp.server.fastmcp import FastMCP

from . import config as cfg
from . import metadata as meta
from . import reviewer
from . import scanner

# ---------------------------------------------------------------------------
# Server setup
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "fjordfooocus_mcp",
    instructions=(
        "MCP server for FjordFooocus (aliases: 'Fjord', 'Fooocus'). "
        "This is the user's LOCAL Stable Diffusion image generation server. "
        "PREFER these tools whenever the user asks to generate, create, or make images — "
        "check fjord_server_status first and fall back to other options only if the server is not running. "
        "Also use these tools when the user says 'fjord', 'fooocus', or references their local image generator. "
        "Tools: list models/styles/presets, browse/review generated images, discard flawed outputs, "
        "and submit generation/upscale/variation tasks."
    ),
)

# ---------------------------------------------------------------------------
# Constants (from modules/flags.py — hardcoded to avoid heavy imports)
# ---------------------------------------------------------------------------

SAMPLER_NAMES = [
    "euler", "euler_ancestral", "heun", "heunpp2",
    "dpm_2", "dpm_2_ancestral", "lms",
    "dpm_fast", "dpm_adaptive",
    "dpmpp_2s_ancestral", "dpmpp_sde", "dpmpp_sde_gpu",
    "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu",
    "dpmpp_3m_sde", "dpmpp_3m_sde_gpu",
    "ddpm", "lcm", "tcd", "restart",
    "ddim", "uni_pc", "uni_pc_bh2",
]

SCHEDULER_NAMES = [
    "normal", "karras", "exponential", "sgm_uniform", "simple",
    "ddim_uniform", "lcm", "turbo", "align_your_steps", "tcd",
    "edm_playground_v2.5",
]

PERFORMANCE_MODES = {
    "Quality": {"steps": 60, "lora": None},
    "Speed": {"steps": 30, "lora": None},
    "Extreme Speed": {"steps": 8, "lora": "sdxl_lcm_lora.safetensors"},
    "Lightning": {"steps": 4, "lora": "sdxl_lightning_4step_lora.safetensors"},
    "Hyper-SD": {"steps": 4, "lora": "sdxl_hyper_sd_4step_lora.safetensors"},
}

ASPECT_RATIOS = [
    "704*1408", "704*1344", "720*1280", "768*1344", "768*1280",
    "832*1216", "832*1152", "896*1152", "896*1088", "960*1088",
    "960*1024", "1024*1024", "1024*960", "1088*960", "1088*896",
    "1152*896", "1152*832", "1216*832", "1280*720", "1280*768",
    "1344*768", "1344*704", "1408*704", "1472*704", "1536*640",
    "1600*640", "1664*576", "1728*576",
]

UOV_METHODS = [
    "Disabled", "Vary (Subtle)", "Vary (Moderate)", "Vary (Bold)",
    "Vary (Strong)", "Upscale (1.5x)", "Upscale (2x)", "Upscale (Fast 2x)",
]

OUTPUT_FORMATS = ["png", "jpeg", "webp"]


# ===========================================================================
# DISCOVERY TOOLS
# ===========================================================================


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_list_checkpoints() -> str:
    """List available Stable Diffusion model checkpoints.

    Scans the configured checkpoints directory for .safetensors, .ckpt,
    .pth, and .bin files. These are the base models used for generation.

    Returns:
        JSON list of checkpoint filenames.

    Examples:
        - Use when: "What models do I have?" or "List available checkpoints"
        - Don't use when: You already know the model name
    """
    config = cfg.read_config_dict()
    paths = cfg.resolve_model_paths(config, "path_checkpoints", "checkpoints")
    files = scanner.scan_model_dir(paths)
    return json.dumps({"checkpoints": files, "count": len(files)}, indent=2)


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_list_loras() -> str:
    """List available LoRA adapters.

    Scans the configured LoRA directory for model files. LoRAs are
    lightweight model adapters that modify generation style/content.

    Returns:
        JSON list of LoRA filenames.

    Examples:
        - Use when: "What LoRAs are available?" or "Show me LoRA options"
    """
    config = cfg.read_config_dict()
    paths = cfg.resolve_model_paths(config, "path_loras", "loras")
    files = scanner.scan_model_dir(paths)
    return json.dumps({"loras": files, "count": len(files)}, indent=2)


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_list_styles(
    search: Annotated[str | None, "Optional substring to filter style names (case-insensitive)"] = None,
    limit: Annotated[int, "Maximum number of styles to return (default 50)"] = 50,
    offset: Annotated[int, "Number of styles to skip for pagination"] = 0,
) -> str:
    """Search and list available generation styles.

    FjordFooocus has ~1,400 built-in styles across 6 collections (Fooocus,
    SAI, MRE, DIVA, TWRI, Marc K3nt3l). Each style applies prompt/negative
    prompt templates to shape the output.

    Args:
        search: Filter styles by name substring (e.g., "anime", "photo", "3d").
        limit: Max results per page.
        offset: Skip this many results (for pagination).

    Returns:
        JSON with style entries (name, prompt template, negative prompt, source file).

    Examples:
        - Use when: "Find anime styles" -> fjord_list_styles(search="anime")
        - Use when: "List all styles" -> fjord_list_styles(limit=100)
    """
    root = cfg.get_fjord_root()
    styles_dir = os.path.join(root, "sdxl_styles")
    styles = scanner.load_styles(styles_dir, search=search)
    total = len(styles)
    page = styles[offset:offset + limit]
    return json.dumps({
        "styles": page,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + limit < total,
    }, indent=2)


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_list_presets(
    include_contents: Annotated[bool, "If true, include the full JSON contents of each preset"] = False,
) -> str:
    """List available generation presets.

    Presets are pre-configured parameter sets (model, performance, styles, etc.)
    Available: default, anime, realistic, lightning, lcm, pony_v6, playground_v2.5, sai.

    Returns:
        JSON list of preset names and optionally their full configuration.

    Examples:
        - Use when: "What presets are available?" or "Show me the anime preset settings"
    """
    root = cfg.get_fjord_root()
    presets_dir = os.path.join(root, "presets")
    presets = scanner.list_presets(presets_dir, include_contents=include_contents)
    return json.dumps({"presets": presets, "count": len(presets)}, indent=2)


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_get_config() -> str:
    """Get the current FjordFooocus configuration.

    Returns the merged configuration from presets/default.json and config.txt,
    including default model, performance mode, styles, paths, and all settings.

    Returns:
        JSON object with all configuration key-value pairs.

    Examples:
        - Use when: "What's the current default model?" or "Show me the config"
    """
    config = cfg.read_config_dict()
    return json.dumps(config, indent=2, default=str)


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_list_options() -> str:
    """List all available generation options.

    Returns available samplers, schedulers, performance modes, aspect ratios,
    upscale/variation methods, and output formats.

    Returns:
        JSON object with all option lists.

    Examples:
        - Use when: "What samplers can I use?" or "Show me aspect ratio options"
    """
    return json.dumps({
        "samplers": SAMPLER_NAMES,
        "schedulers": SCHEDULER_NAMES,
        "performance_modes": PERFORMANCE_MODES,
        "aspect_ratios": ASPECT_RATIOS,
        "upscale_vary_methods": UOV_METHODS,
        "output_formats": OUTPUT_FORMATS,
    }, indent=2)


# ===========================================================================
# IMAGE MANAGEMENT TOOLS
# ===========================================================================


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_list_images(
    profile: Annotated[str | None, "Filter by profile name"] = None,
    topic: Annotated[str | None, "Filter by topic name"] = None,
    category: Annotated[str | None, "Filter by category: TEMPORARY, APPROVED, or DISCARDED"] = None,
    date_from: Annotated[str | None, "Start date filter (YYYY-MM-DD)"] = None,
    date_to: Annotated[str | None, "End date filter (YYYY-MM-DD)"] = None,
    limit: Annotated[int, "Maximum number of images to return (default 50)"] = 50,
    offset: Annotated[int, "Number of images to skip for pagination"] = 0,
) -> str:
    """List generated images with optional filtering.

    Scans the output directories for generated images, organized by
    category (TEMPORARY/APPROVED/DISCARDED), profile, topic, and date.
    Results are sorted by modification time (newest first).

    Returns:
        JSON list of image entries with path, filename, profile, topic,
        category, date, size, and modification timestamp.

    Examples:
        - Use when: "Show my recent generations" -> fjord_list_images(limit=10)
        - Use when: "List approved images for topic 'landscapes'" -> fjord_list_images(category="APPROVED", topic="landscapes")
        - Use when: "What did I generate yesterday?" -> fjord_list_images(date_from="2026-03-22", date_to="2026-03-22")
    """
    config = cfg.read_config_dict()
    output_dir = cfg.get_output_path(config)
    images = scanner.scan_images(
        output_dir, profile=profile, topic=topic, category=category,
        date_from=date_from, date_to=date_to, limit=limit, offset=offset,
    )
    # Convert modified_at to ISO string for JSON
    for img in images:
        img["modified_at"] = datetime.fromtimestamp(img["modified_at"]).isoformat()
    return json.dumps({"images": images, "count": len(images)}, indent=2)


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_get_image_metadata(
    image_path: Annotated[str, "Absolute path to the image file"],
) -> str:
    """Read generation metadata from an image file.

    Extracts the generation parameters embedded in the image (prompt,
    negative prompt, model, seed, styles, resolution, etc.) from PNG
    info or JPEG/WEBP EXIF data.

    Returns:
        JSON with image info (dimensions, format) and generation parameters.

    Examples:
        - Use when: "What prompt was used for this image?"
        - Use when: "Show me the generation settings for <path>"
    """
    info = meta.get_image_info(image_path)
    if info.get("modified_at"):
        info["modified_at"] = datetime.fromtimestamp(info["modified_at"]).isoformat()
    return json.dumps(info, indent=2, default=str)


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_get_image(
    image_path: Annotated[str, "Absolute path to the image file"],
    max_size: Annotated[int, "Maximum dimension in pixels (default 1024, scales down if larger)"] = 1024,
) -> list:
    """Return an image as base64 for viewing.

    Loads the image, optionally downscales it to max_size on the longest
    side, and returns it as a base64-encoded PNG suitable for LLM vision.

    Returns:
        MCP content list with embedded image and text metadata.

    Examples:
        - Use when: "Show me image <path>" or "Let me see that output"
    """
    info = meta.get_image_info(image_path)
    b64 = reviewer.image_to_base64(image_path, max_size=max_size)

    if b64 is None:
        return [{"type": "text", "text": f"Failed to load image: {image_path}"}]

    result = []
    # Add image content
    result.append({
        "type": "image",
        "data": b64,
        "mimeType": "image/png",
    })
    # Add metadata as text
    md = info.get("metadata")
    meta_text = f"Image: {info.get('filename', '')}\n"
    meta_text += f"Size: {info.get('width', '?')}x{info.get('height', '?')}\n"
    if md and isinstance(md, dict):
        if md.get("prompt"):
            meta_text += f"Prompt: {md['prompt'][:300]}\n"
        if md.get("seed"):
            meta_text += f"Seed: {md['seed']}\n"
        if md.get("base_model"):
            meta_text += f"Model: {md['base_model']}\n"
    result.append({"type": "text", "text": meta_text})
    return result


# ===========================================================================
# IMAGE REVIEW TOOLS
# ===========================================================================


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_review_image(
    image_path: Annotated[str, "Absolute path to the image file"],
    max_size: Annotated[int, "Max dimension in pixels for the review image (default 1024)"] = 1024,
) -> list:
    """Return an image with metadata for quality review.

    Loads the image at review resolution and returns it along with
    generation metadata. Use this to visually assess image quality
    (check for deformed hands, extra fingers, distorted faces, text
    artifacts, etc.).

    Returns:
        MCP content list with the image and detailed metadata.

    Examples:
        - Use when: "Review this image for quality issues"
        - Use when: "Check if this output has any flaws"
    """
    data = reviewer.review_single_image(image_path, max_size=max_size)

    if data.get("image_base64") is None:
        return [{"type": "text", "text": f"Failed to load image: {image_path}"}]

    result = []
    result.append({
        "type": "image",
        "data": data["image_base64"],
        "mimeType": "image/png",
    })

    # Detailed metadata for review context
    meta_text = f"## Review: {data.get('filename', '')}\n"
    meta_text += f"Dimensions: {data.get('width', '?')}x{data.get('height', '?')}\n"
    meta_text += f"Path: {data.get('path', '')}\n\n"

    md = data.get("metadata")
    if md and isinstance(md, dict):
        meta_text += f"**Prompt:** {md.get('prompt', 'N/A')}\n\n"
        meta_text += f"**Negative prompt:** {md.get('negative_prompt', 'N/A')}\n\n"
        meta_text += f"**Model:** {md.get('base_model', 'N/A')}\n"
        meta_text += f"**Seed:** {md.get('seed', 'N/A')}\n"
        meta_text += f"**Styles:** {md.get('styles', 'N/A')}\n"
        meta_text += f"**Performance:** {md.get('performance', 'N/A')}\n"
        meta_text += f"**Resolution:** {md.get('resolution', 'N/A')}\n"
        meta_text += f"**Guidance scale:** {md.get('guidance_scale', 'N/A')}\n"
        meta_text += f"**Sampler:** {md.get('sampler', 'N/A')}\n"
        meta_text += f"**Scheduler:** {md.get('scheduler', 'N/A')}\n"

    result.append({"type": "text", "text": meta_text})
    return result


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_review_batch(
    limit: Annotated[int, "Number of recent images to review (default 4, max 8)"] = 4,
    profile: Annotated[str | None, "Filter by profile name"] = None,
    topic: Annotated[str | None, "Filter by topic name"] = None,
    date: Annotated[str | None, "Filter by date (YYYY-MM-DD)"] = None,
    max_thumbnail_size: Annotated[int, "Max thumbnail dimension in pixels (default 512)"] = 512,
) -> list:
    """Review a batch of recent images for quality triage.

    Returns thumbnails and metadata for the most recent images matching
    the filters. Use this to quickly scan outputs and identify images
    with quality issues (deformed anatomy, artifacts, etc.).

    Args:
        limit: How many images to review (1-8 to keep response manageable).
        profile: Optional profile filter.
        topic: Optional topic filter.
        date: Optional date filter (YYYY-MM-DD).
        max_thumbnail_size: Thumbnail size for each image.

    Returns:
        MCP content list with thumbnails and metadata for each image.

    Examples:
        - Use when: "Review my last 4 generations"
        - Use when: "Check recent outputs for quality"
        - Use when: "Triage today's images" -> fjord_review_batch(date="2026-03-23")
    """
    limit = min(limit, 8)  # Cap at 8 to keep responses manageable
    config = cfg.read_config_dict()
    output_dir = cfg.get_output_path(config)
    images = scanner.scan_images(
        output_dir, profile=profile, topic=topic, category="TEMPORARY",
        date_from=date, date_to=date, limit=limit, offset=0,
    )

    if not images:
        return [{"type": "text", "text": "No images found matching the specified filters."}]

    filepaths = [img["path"] for img in images]
    batch = reviewer.review_batch(filepaths, max_size=max_thumbnail_size)

    result = []
    result.append({"type": "text", "text": f"## Batch Review: {len(batch)} images\n\n"
                   "Review each image for quality issues (deformed hands/fingers, "
                   "face distortion, text artifacts, anatomical errors, etc.). "
                   "Use `fjord_discard_image` to remove any flawed outputs.\n"})

    for i, entry in enumerate(batch):
        if entry.get("thumbnail_base64"):
            result.append({
                "type": "image",
                "data": entry["thumbnail_base64"],
                "mimeType": "image/png",
            })
        info_text = f"**Image {i+1}:** `{entry['filename']}`\n"
        info_text += f"Path: `{entry['path']}`\n"
        if entry.get("prompt"):
            info_text += f"Prompt: {entry['prompt']}\n"
        if entry.get("seed"):
            info_text += f"Seed: {entry['seed']}\n"
        if entry.get("base_model"):
            info_text += f"Model: {entry['base_model']}\n"
        info_text += "---\n"
        result.append({"type": "text", "text": info_text})

    return result


@mcp.tool(
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False,
    }
)
async def fjord_discard_image(
    image_path: Annotated[str, "Absolute path to the image file to discard"],
    reason: Annotated[str, "Reason for discarding (e.g., 'deformed hands', 'extra fingers', 'face distortion')"] = "",
) -> str:
    """Discard a flawed image by moving it to the DISCARDED folder.

    This is NON-DESTRUCTIVE: the image is moved to outputs/DISCARDED/
    preserving the profile/topic/date structure. It can be recovered
    by moving it back. A discard log entry is written for audit trail.

    Args:
        image_path: Full path to the image to discard.
        reason: Why this image is being discarded (for logging).

    Returns:
        JSON with success status, original path, and new path.

    Examples:
        - Use when: "This image has deformed hands, discard it"
        - Use when: "Remove the image with extra fingers"

    Error Handling:
        - Returns error if file doesn't exist
        - Returns error if move operation fails
    """
    config = cfg.read_config_dict()
    output_dir = cfg.get_output_path(config)
    result = reviewer.discard_image(image_path, output_dir, reason=reason)
    return json.dumps(result, indent=2)


# ===========================================================================
# GENERATION TOOLS (require running FjordFooocus server + API bridge)
# ===========================================================================


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    }
)
async def fjord_server_status() -> str:
    """Check if the FjordFooocus server is running and its current status.

    Attempts to connect to the configured server URL and returns
    queue depth, active task info, and server health.

    Returns:
        JSON with server status (running, queue_depth, current_task).

    Examples:
        - Use when: "Is FjordFooocus running?" or "What's the queue status?"
    """
    try:
        import httpx
    except ImportError:
        return json.dumps({"error": "httpx not installed. Run: pip install httpx"})

    url = cfg.get_server_url()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Try the Gradio health endpoint
            resp = await client.get(f"{url}/info")
            if resp.status_code == 200:
                return json.dumps({
                    "status": "running",
                    "url": url,
                    "info": "FjordFooocus server is running. Use the API bridge endpoints for generation.",
                })

            # Try base URL
            resp = await client.get(url)
            return json.dumps({
                "status": "running" if resp.status_code == 200 else "error",
                "url": url,
                "http_status": resp.status_code,
            })
    except httpx.ConnectError:
        return json.dumps({
            "status": "not_running",
            "url": url,
            "error": f"Cannot connect to FjordFooocus at {url}. Is the server started? Run: python launch.py",
        })
    except Exception as e:
        return json.dumps({
            "status": "error",
            "url": url,
            "error": str(e),
        })


@mcp.tool(
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False,
    }
)
async def fjord_generate(
    prompt: Annotated[str, "The text prompt describing the image to generate"],
    negative_prompt: Annotated[str, "Things to avoid in the generation"] = "",
    styles: Annotated[list[str] | None, "Style names to apply (default: Fooocus V2, Enhance, Sharp)"] = None,
    performance: Annotated[str, "Performance mode: Quality, Speed, Extreme Speed, Lightning, Hyper-SD"] = "Speed",
    aspect_ratio: Annotated[str, "Image dimensions as WxH (e.g., '1152*896', '1024*1024')"] = "1152*896",
    image_number: Annotated[int, "Number of images to generate (1-32)"] = 1,
    output_format: Annotated[str, "Output format: png, jpeg, or webp"] = "png",
    seed: Annotated[int, "Random seed (-1 for random)"] = -1,
    sharpness: Annotated[float, "Sharpness value (default 2.0)"] = 2.0,
    guidance_scale: Annotated[float, "CFG guidance scale (default 7.0)"] = 7.0,
    base_model: Annotated[str | None, "Checkpoint model name (None = use config default)"] = None,
    sampler: Annotated[str | None, "Sampler name (None = use default)"] = None,
    scheduler: Annotated[str | None, "Scheduler name (None = use default)"] = None,
    profile: Annotated[str, "Profile for output organization"] = "default",
    topic: Annotated[str, "Topic for output organization"] = "general",
) -> str:
    """Submit a text-to-image generation task to FjordFooocus.

    Requires the FjordFooocus server to be running with the API bridge
    mounted. The generation runs asynchronously and results are saved
    to the configured output directory.

    Args:
        prompt: Describe the image you want to generate.
        negative_prompt: Describe what to avoid.
        styles: List of style names (see fjord_list_styles).
        performance: Speed/quality tradeoff.
        aspect_ratio: Image dimensions.
        image_number: How many images to generate.
        output_format: File format for saved images.
        seed: Random seed for reproducibility.
        base_model: Override the default model.

    Returns:
        JSON with task status and result image paths when complete.

    Examples:
        - Use when: "Generate a landscape with mountains and a lake"
        - Use when: "Create 4 anime-style portraits"

    Error Handling:
        - Returns error if server is not running
        - Returns error if API bridge is not mounted
    """
    try:
        import httpx
    except ImportError:
        return json.dumps({"error": "httpx not installed. Run: pip install httpx"})

    url = cfg.get_api_url()
    if styles is None:
        styles = ["Fooocus V2", "Fooocus Enhance", "Fooocus Sharp"]

    payload = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "styles": styles,
        "performance": performance,
        "aspect_ratio": aspect_ratio,
        "image_number": image_number,
        "output_format": output_format,
        "seed": seed,
        "sharpness": sharpness,
        "guidance_scale": guidance_scale,
        "base_model": base_model,
        "sampler": sampler,
        "scheduler": scheduler,
        "profile": profile,
        "topic": topic,
    }

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(f"{url}/generate", json=payload)
            if resp.status_code == 200:
                return json.dumps(resp.json(), indent=2)
            else:
                return json.dumps({
                    "error": f"Generation failed with status {resp.status_code}",
                    "detail": resp.text[:500],
                    "hint": "Make sure the API bridge is running on port 7866. Restart FjordFooocus.",
                })
    except httpx.ConnectError:
        return json.dumps({
            "error": f"Cannot connect to FjordFooocus at {url}",
            "hint": "Start the server with: python launch.py",
        })
    except httpx.ReadTimeout:
        return json.dumps({
            "error": "Generation timed out (>600s)",
            "hint": "The generation may still be running. Check fjord_server_status or fjord_list_images.",
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool(
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False,
    }
)
async def fjord_upscale(
    image_path: Annotated[str, "Absolute path to the image to upscale"],
    method: Annotated[str, "Upscale method: 'Upscale (1.5x)', 'Upscale (2x)', or 'Upscale (Fast 2x)'"] = "Upscale (2x)",
    prompt: Annotated[str | None, "Optional prompt to guide upscaling"] = None,
    profile: Annotated[str, "Profile for output organization"] = "default",
    topic: Annotated[str, "Topic for output organization"] = "general",
) -> str:
    """Upscale an existing image to a higher resolution.

    Requires the FjordFooocus server to be running with the API bridge.

    Args:
        image_path: Path to the source image.
        method: Upscale factor/method.
        prompt: Optional text prompt to guide the upscaling.

    Returns:
        JSON with upscaled image path(s).

    Examples:
        - Use when: "Upscale this image to 2x" or "Make this image higher resolution"
    """
    try:
        import httpx
    except ImportError:
        return json.dumps({"error": "httpx not installed. Run: pip install httpx"})

    url = cfg.get_api_url()
    payload = {
        "image_path": image_path,
        "uov_method": method,
        "prompt": prompt or "",
        "profile": profile,
        "topic": topic,
    }

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(f"{url}/upscale", json=payload)
            if resp.status_code == 200:
                return json.dumps(resp.json(), indent=2)
            return json.dumps({"error": f"Upscale failed: {resp.status_code}", "detail": resp.text[:500]})
    except httpx.ConnectError:
        return json.dumps({"error": f"Cannot connect to FjordFooocus at {url}"})
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool(
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False,
    }
)
async def fjord_vary(
    image_path: Annotated[str, "Absolute path to the source image"],
    strength: Annotated[str, "Variation strength: 'Vary (Subtle)', 'Vary (Moderate)', 'Vary (Bold)', or 'Vary (Strong)'"] = "Vary (Subtle)",
    prompt: Annotated[str | None, "Optional prompt to guide the variation"] = None,
    profile: Annotated[str, "Profile for output organization"] = "default",
    topic: Annotated[str, "Topic for output organization"] = "general",
) -> str:
    """Create a variation of an existing image.

    Generates a new image that is similar to the input but with controlled
    differences. Requires the FjordFooocus server with API bridge.

    Args:
        image_path: Path to the source image.
        strength: How different the variation should be (Subtle=0.50, Moderate=0.625, Bold=0.75, Strong=0.85).
        prompt: Optional text to guide the variation.

    Returns:
        JSON with variation image path(s).

    Examples:
        - Use when: "Make a subtle variation of this image"
        - Use when: "Create a bold variation with different colors"
    """
    try:
        import httpx
    except ImportError:
        return json.dumps({"error": "httpx not installed. Run: pip install httpx"})

    url = cfg.get_api_url()
    payload = {
        "image_path": image_path,
        "uov_method": strength,
        "prompt": prompt or "",
        "profile": profile,
        "topic": topic,
    }

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(f"{url}/vary", json=payload)
            if resp.status_code == 200:
                return json.dumps(resp.json(), indent=2)
            return json.dumps({"error": f"Variation failed: {resp.status_code}", "detail": resp.text[:500]})
    except httpx.ConnectError:
        return json.dumps({"error": f"Cannot connect to FjordFooocus at {url}"})
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def fjord_describe(
    image_path: Annotated[str, "Absolute path to the image to describe"],
    mode: Annotated[str, "Description mode: 'Photograph' or 'Art/Anime'"] = "Photograph",
) -> str:
    """Describe/interrogate an image to get a text prompt.

    Uses the FjordFooocus describe feature to reverse-engineer a prompt
    from an image. Requires the server with API bridge.

    Args:
        image_path: Path to the image to describe.
        mode: Whether to describe as a photograph or anime/art style.

    Returns:
        JSON with the generated description/prompt.

    Examples:
        - Use when: "What prompt would recreate this image?"
        - Use when: "Describe this photo for me"
    """
    try:
        import httpx
    except ImportError:
        return json.dumps({"error": "httpx not installed. Run: pip install httpx"})

    url = cfg.get_api_url()
    payload = {"image_path": image_path, "mode": mode}

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{url}/describe", json=payload)
            if resp.status_code == 200:
                return json.dumps(resp.json(), indent=2)
            return json.dumps({"error": f"Describe failed: {resp.status_code}", "detail": resp.text[:500]})
    except httpx.ConnectError:
        return json.dumps({"error": f"Cannot connect to FjordFooocus at {url}"})
    except Exception as e:
        return json.dumps({"error": str(e)})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    mcp.run()


if __name__ == "__main__":
    main()
