"""REST API bridge for FjordFooocus.

Provides HTTP endpoints that accept generation parameters, construct
AsyncTask objects, push them to the worker queue, and poll for results.

Mount this into the running Gradio server by adding to webui.py:
    import api_bridge
    (after shared.gradio_root launch, mount on the underlying app)
"""

import base64
import json
import os
import time
import numpy as np
from io import BytesIO
from PIL import Image
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import modules.async_worker as worker
import modules.config as config

# Default counts from config (read at import time since config is already loaded)
MAX_LORA_NUMBER = getattr(config, 'default_max_lora_number', 5)
CN_IMAGE_COUNT = getattr(config, 'default_controlnet_image_count', 4)
ENHANCE_TABS = getattr(config, 'default_enhance_tabs', 3)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class LoraConfig(BaseModel):
    name: str = "None"
    weight: float = 1.0
    enabled: bool = True


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    styles: list[str] = Field(default_factory=lambda: ["Fooocus V2", "Fooocus Enhance", "Fooocus Sharp"])
    performance: str = "Speed"
    aspect_ratio: str = "1152*896"
    image_number: int = Field(default=1, ge=1, le=32)
    output_format: str = "png"
    seed: int = -1
    read_wildcards_in_order: bool = False
    sharpness: float = 2.0
    guidance_scale: float = 7.0
    base_model: str | None = None
    refiner_model: str = "None"
    refiner_switch: float = 0.8
    loras: list[LoraConfig] | None = None
    sampler: str | None = None
    scheduler: str | None = None
    profile: str = "default"
    topic: str = "general"


class UovRequest(BaseModel):
    image_path: str
    uov_method: str = "Upscale (2x)"
    prompt: str = ""
    negative_prompt: str = ""
    styles: list[str] = Field(default_factory=lambda: ["Fooocus V2", "Fooocus Enhance", "Fooocus Sharp"])
    performance: str = "Speed"
    output_format: str = "png"
    profile: str = "default"
    topic: str = "general"


class DescribeRequest(BaseModel):
    image_path: str
    mode: str = "Photograph"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_image_as_numpy(image_path: str) -> np.ndarray | None:
    """Load an image file and return as numpy array (RGB)."""
    if not os.path.isfile(image_path):
        return None
    try:
        img = Image.open(image_path).convert("RGB")
        return np.array(img)
    except Exception:
        return None


def _build_lora_args(loras: list[LoraConfig] | None) -> list:
    """Build the flat lora args list: [enabled, name, weight] * MAX_LORA_NUMBER."""
    result = []
    lora_list = loras or []
    for i in range(MAX_LORA_NUMBER):
        if i < len(lora_list):
            result.extend([lora_list[i].enabled, lora_list[i].name, lora_list[i].weight])
        else:
            result.extend([True, "None", 1.0])
    return result


def _build_default_args(req: GenerateRequest, uov_method: str = "Disabled",
                         uov_image: np.ndarray | None = None) -> list:
    """Build the full args list matching the ctrls order in webui.py."""
    import args_manager

    base_model = req.base_model or getattr(config, 'default_base_model_name', '')
    sampler = req.sampler or getattr(config, 'default_sampler', 'dpmpp_2m_sde_gpu')
    scheduler = req.scheduler or getattr(config, 'default_scheduler', 'karras')

    args = []
    # generate_image_grid (first ctrl after currentTask which is popped in get_task)
    args.append(False)
    # prompt, negative_prompt, style_selections
    args.append(req.prompt)
    args.append(req.negative_prompt)
    args.append(req.styles)
    # performance, aspect_ratio, image_number, output_format, seed
    args.append(req.performance)
    # The worker expects Unicode × (U+00D7) between dimensions, not *
    args.append(req.aspect_ratio.replace('*', '\u00d7'))
    args.append(req.image_number)
    args.append(req.output_format)
    args.append(req.seed)
    # read_wildcards_in_order, sharpness, guidance_scale
    args.append(req.read_wildcards_in_order)
    args.append(req.sharpness)
    args.append(req.guidance_scale)
    # base_model, refiner_model, refiner_switch
    args.append(base_model)
    args.append(req.refiner_model)
    args.append(req.refiner_switch)
    # lora_ctrls: [enabled, model, weight] * MAX_LORA_NUMBER
    args.extend(_build_lora_args(req.loras))
    # input_image_checkbox, current_tab
    has_input = uov_image is not None
    args.append(has_input)
    args.append("uov_tab" if has_input else "uov_tab")
    # uov_method, uov_input_image
    args.append(uov_method)
    args.append(uov_image)
    # outpaint_selections, outpaint_expansion
    args.append([])
    args.append(0.2)
    # inpaint_input_image, inpaint_additional_prompt, inpaint_mask_image
    args.append(None)
    args.append("")
    args.append(None)
    # disable_preview, disable_intermediate_results, disable_seed_increment, black_out_nsfw
    args.append(True)   # disable preview for API
    args.append(True)   # disable intermediate for API
    args.append(False)
    args.append(False)
    # adm_scaler_positive, adm_scaler_negative, adm_scaler_end, adaptive_cfg, clip_skip
    args.append(1.5)
    args.append(0.8)
    args.append(0.3)
    args.append(7.0)
    args.append(2)
    # sampler_name, scheduler_name, vae_name
    args.append(sampler)
    args.append(scheduler)
    args.append("Default (model)")
    # overwrite_step, overwrite_switch, overwrite_width, overwrite_height, overwrite_vary_strength
    args.append(-1)
    args.append(-1)
    args.append(-1)
    args.append(-1)
    args.append(-1)
    # overwrite_upscale_strength, mixing_image_prompt_and_vary_upscale, mixing_image_prompt_and_inpaint
    args.append(-1)
    args.append(False)
    args.append(False)
    # debugging_cn_preprocessor, skipping_cn_preprocessor, canny_low_threshold, canny_high_threshold
    args.append(False)
    args.append(False)
    args.append(64)
    args.append(128)
    # refiner_swap_method, controlnet_softness
    args.append("joint")
    args.append(0.25)
    # freeu: enabled, b1, b2, s1, s2
    args.append(False)
    args.append(1.01)
    args.append(1.02)
    args.append(0.99)
    args.append(0.95)
    # inpaint: debugging_preprocessor, disable_initial_latent, engine, strength, respective_field
    args.append(False)
    args.append(False)
    args.append("v2.6")
    args.append(1.0)
    args.append(0.618)
    # inpaint_advanced_masking_checkbox, invert_mask_checkbox, inpaint_erode_or_dilate
    args.append(False)
    args.append(False)
    args.append(0)

    # save_final_enhanced_image_only (conditional on args_manager)
    if not getattr(args_manager.args, 'disable_image_log', False):
        args.append(False)
    # save_metadata_to_images, metadata_scheme (conditional)
    if not getattr(args_manager.args, 'disable_metadata', False):
        args.append(True)
        args.append("fooocus")

    # ip_ctrls: [image, stop, weight, type] * CN_IMAGE_COUNT
    for _ in range(CN_IMAGE_COUNT):
        args.append(None)   # cn_img
        args.append(0.5)    # cn_stop
        args.append(0.6)    # cn_weight
        args.append("ImagePrompt")  # cn_type

    # debugging_dino, dino_erode_or_dilate, debugging_enhance_masks_checkbox
    args.append(False)
    args.append(0)
    args.append(False)

    # enhance_input_image, enhance_checkbox, enhance_uov_method, enhance_uov_processing_order, enhance_uov_prompt_type
    args.append(None)
    args.append(False)
    args.append("Disabled")
    args.append("Before First Enhancement")
    args.append("Original Prompts")

    # enhance_ctrls: 16 values per tab * ENHANCE_TABS
    for _ in range(ENHANCE_TABS):
        args.append(False)   # enhance_enabled
        args.append("")      # enhance_mask_dino_prompt_text
        args.append("")      # enhance_prompt
        args.append("")      # enhance_negative_prompt
        args.append("u2net")  # enhance_mask_model
        args.append("full")  # enhance_mask_cloth_category
        args.append("vit_b") # enhance_mask_sam_model
        args.append(0.25)    # enhance_mask_text_threshold
        args.append(0.3)     # enhance_mask_box_threshold
        args.append(0)       # enhance_mask_sam_max_detections
        args.append(False)   # enhance_inpaint_disable_initial_latent
        args.append("v2.6")  # enhance_inpaint_engine
        args.append(1.0)     # enhance_inpaint_strength
        args.append(0.618)   # enhance_inpaint_respective_field
        args.append(0)       # enhance_inpaint_erode_or_dilate
        args.append(False)   # enhance_mask_invert

    # removebg params
    args.append(None)        # removebg_input_image
    args.append("u2net")     # removebg_mask_model
    args.append("full")      # removebg_cloth_category
    args.append("")          # removebg_dino_prompt
    args.append("vit_b")     # removebg_sam_model
    args.append(0.3)         # removebg_box_threshold
    args.append(0.25)        # removebg_text_threshold
    args.append(0)           # removebg_sam_max_detections

    # profile, topic
    args.append(req.profile)
    args.append(req.topic)

    return args


def _submit_and_wait(args: list, timeout: float = 600.0) -> dict:
    """Create an AsyncTask, submit it, and wait for completion."""
    task = worker.AsyncTask(args=args)
    worker.async_tasks.append(task)

    start = time.time()
    while time.time() - start < timeout:
        if task.yields:
            flag, data = task.yields[-1]
            if flag == "finish":
                return {
                    "status": "completed",
                    "images": task.results,
                    "count": len(task.results),
                }
        time.sleep(0.5)

    return {
        "status": "timeout",
        "message": f"Generation did not complete within {timeout}s",
        "partial_results": task.results,
    }


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

def create_app() -> FastAPI:
    """Create the API bridge FastAPI application."""
    app = FastAPI(title="FjordFooocus API Bridge", version="1.0.0")

    @app.get("/status")
    async def status():
        queue_depth = len(worker.async_tasks)
        return {
            "status": "running",
            "queue_depth": queue_depth,
        }

    @app.post("/generate")
    async def generate(req: GenerateRequest):
        args = _build_default_args(req)
        # Run in thread to avoid blocking the event loop
        import asyncio
        result = await asyncio.to_thread(_submit_and_wait, args)
        return result

    @app.post("/upscale")
    async def upscale(req: UovRequest):
        img = _load_image_as_numpy(req.image_path)
        if img is None:
            raise HTTPException(status_code=400, detail=f"Cannot load image: {req.image_path}")

        gen_req = GenerateRequest(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            styles=req.styles,
            performance=req.performance,
            output_format=req.output_format,
            profile=req.profile,
            topic=req.topic,
        )
        args = _build_default_args(gen_req, uov_method=req.uov_method, uov_image=img)
        import asyncio
        result = await asyncio.to_thread(_submit_and_wait, args)
        return result

    @app.post("/vary")
    async def vary(req: UovRequest):
        img = _load_image_as_numpy(req.image_path)
        if img is None:
            raise HTTPException(status_code=400, detail=f"Cannot load image: {req.image_path}")

        gen_req = GenerateRequest(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            styles=req.styles,
            performance=req.performance,
            output_format=req.output_format,
            profile=req.profile,
            topic=req.topic,
        )
        args = _build_default_args(gen_req, uov_method=req.uov_method, uov_image=img)
        import asyncio
        result = await asyncio.to_thread(_submit_and_wait, args)
        return result

    @app.post("/describe")
    async def describe(req: DescribeRequest):
        # Describe requires loading the image and using the describe tab
        return {
            "status": "not_implemented",
            "message": "Image describe/interrogation via API is planned for a future release.",
        }

    return app


def start_bridge_server(port: int = 7866):
    """Start the API bridge as a standalone server in a daemon thread."""
    import threading
    import uvicorn

    app = create_app()

    def _run():
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    print(f"API bridge server started on http://127.0.0.1:{port}")
