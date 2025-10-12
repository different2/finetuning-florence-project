    #!/usr/bin/env python3
# improved_florence_api.py
import os
# Prefer to disable FlashAttention early (extra safety)
os.environ["FLASH_ATTENTION_DISABLED"] = "1"

import logging
import re
from io import BytesIO
from unittest.mock import patch

import base64
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
import torch

from transformers import AutoModelForCausalLM, AutoProcessor
from transformers.dynamic_module_utils import get_imports as _original_get_imports

# ---------- logging ----------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------- Pydantic models ----------
class BoundingBox(BaseModel):
    box: list[float]
    label: str

class ObjectDetectionRequest(BaseModel):
    image_b64: str

class ObjectDetectionResponse(BaseModel):
    objects: list[BoundingBox]
    caption: str

# ---------- globals ----------
MODEL = None
PROCESSOR = None
DEVICE = torch.device("cpu")
TORCH_DTYPE = torch.float32

# ---------- helper: safe get_imports patch ----------
def fixed_get_imports(filename: str | os.PathLike) -> list[str]:
    """
    Calls the original get_imports but removes any flash-attn related imports.
    We import the original function as _original_get_imports above to avoid recursion.
    """
    try:
        imports = _original_get_imports(filename)
    except Exception:
        return []
    # remove anything mentioning flash or flash_attn
    imports = [imp for imp in imports if "flash" not in imp.lower() and "flash_attn" not in imp.lower()]
    if len(imports) != 0 and any("flash" in imp.lower() for imp in _original_get_imports(filename)):
        logger.info("Removed flash-attn from import list for %s", filename)
    return imports

# ---------- helper: move tensors to device/dtype ----------
def move_batch_to_device(batch: dict, device: torch.device, dtype: torch.dtype | None = None) -> dict:
    for k, v in list(batch.items()):
        if isinstance(v, torch.Tensor):
            # input_ids and attention_mask should stay as integer types
            if k in ("input_ids", "attention_mask") or not v.is_floating_point():
                batch[k] = v.to(device=device)
            elif dtype is not None:
                batch[k] = v.to(device=device, dtype=dtype)
            else:
                batch[k] = v.to(device=device)
    return batch

# ---------- load model ----------
def load_model():
    global MODEL, PROCESSOR, DEVICE, TORCH_DTYPE

    # pick device + dtype
    if torch.cuda.is_available():
        DEVICE = torch.device("cuda")
        TORCH_DTYPE = torch.float16  # can use fp16 on CUDA
        logger.info("Using CUDA device for acceleration.")
    elif torch.backends.mps.is_available():
        DEVICE = torch.device("mps")
        TORCH_DTYPE = torch.float32  # MPS is more stable with float32
        logger.info("Using Apple MPS device for acceleration (float32).")
    else:
        DEVICE = torch.device("cpu")
        TORCH_DTYPE = torch.float32
        logger.info("Using CPU (float32).")

    model_id = "thwri/CogFlorence-2.2-Large"
    logger.info("Loading model %s ...", model_id)

    try:
        # Patch get_imports to avoid trying to import flash-attn on platforms that don't support it.
        with patch("transformers.dynamic_module_utils.get_imports", fixed_get_imports):
            # low_cpu_mem_usage reduces peak RAM on load (helpful for local testing)
            MODEL = AutoModelForCausalLM.from_pretrained(
                model_id, torch_dtype=TORCH_DTYPE, trust_remote_code=True, low_cpu_mem_usage=True
            )
            MODEL.to(DEVICE)
            MODEL.eval()  # Set to evaluation mode
            PROCESSOR = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        logger.info("Model and processor loaded successfully on %s (dtype=%s).", DEVICE, TORCH_DTYPE)
    except Exception as e:
        logger.exception("Fatal error during model loading: %s", e)
        raise

# ---------- parsing function ----------
def parse_grounding_output(text: str, task_prompt: str, image_size: tuple):
    """
    Attempt processor.post_process_generation first (preferred).
    If that fails, fallback to robust manual parsing of tokens like:
        label <loc_12><loc_34><loc_56><loc_78> label2 <loc_90>...
    This version:
      - strips common special tokens
      - uses a tolerant regex to capture labels followed by one-or-more <loc_...> groups
      - supports multiple boxes per label
    """
    logger.info("Raw model output:\n%s", text)
    img_w, img_h = image_size
    objects = []

    # Try the processor first (if available)
    try:
        parsed = PROCESSOR.post_process_generation(text, task=task_prompt, image_size=image_size)
        logger.info("Processor parsing succeeded.")
        if task_prompt == "<CAPTION_TO_PHRASE_GROUNDING>":
            data = parsed.get("<CAPTION_TO_PHRASE_GROUNDING>", {})
            bboxes = data.get("bboxes", [])
            labels = data.get("labels", [])
            if bboxes and labels and len(bboxes) == len(labels):
                for box, label in zip(bboxes, labels):
                    objects.append(BoundingBox(box=box, label=label))
                return {"objects": objects}
    except Exception as e:
        logger.warning("Processor parsing failed: %s. Falling back to manual parsing.", e)

    # Manual fallback parsing
    try:
        s = text.replace(task_prompt, "")
        # remove standard tokens
        s = s.replace("<s>", "").replace("</s>", "").strip()

        # greedy-but-safe pattern: capture minimal text up to the following <loc_ token(s)
        pattern = re.compile(r"(.+?)((?:<loc_\d+>)+)", flags=re.DOTALL)
        loc_pattern = re.compile(r"<loc_(\d+)>")

        for m in pattern.finditer(s):
            label_raw = m.group(1).strip()
            # normalize label: remove trailing punctuation and repeated whitespace
            label = re.sub(r"[:;,\.]+$", "", label_raw).strip()
            locs_str = m.group(2)
            loc_vals = [int(v) for v in loc_pattern.findall(locs_str)]

            # group into sets of 4 (x1,y1,x2,y2) – supports N*4 values
            boxes = [loc_vals[i:i + 4] for i in range(0, len(loc_vals), 4)]
            for b in boxes:
                if len(b) != 4:
                    continue
                # original Florence tokens are often in 0..1000 normalized space in many repos;
                # keep the same scaling as your previous code (divide by 1000)
                x1 = float(b[0]) / 1000.0 * img_w
                y1 = float(b[1]) / 1000.0 * img_h
                x2 = float(b[2]) / 1000.0 * img_w
                y2 = float(b[3]) / 1000.0 * img_h
                objects.append(BoundingBox(box=[x1, y1, x2, y2], label=label))

        logger.info("Manual parsing produced %d objects.", len(objects))
        return {"objects": objects}
    except Exception as e:
        logger.exception("Manual regex parsing failed: %s", e)
        return {"objects": []}

# ---------- FastAPI app ----------
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
async def startup_event():
    logger.info("startup: loading model...")
    load_model()

@app.get("/")
def read_root():
    return {"status": "CogFlorence-2.2 API is running"}

@app.post("/detect-objects", response_model=ObjectDetectionResponse)
async def detect_objects(request: ObjectDetectionRequest):
    if MODEL is None or PROCESSOR is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    # decode image
    try:
        image_bytes = base64.b64decode(request.image_b64)
        image = Image.open(BytesIO(image_bytes)).convert("RGB")
        img_size = (image.width, image.height)
        logger.info("Processing image size: %s", img_size)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image: {e}")

    try:
        # 1) caption
        caption_prompt = "<MORE_DETAILED_CAPTION>"
        caption_inputs = PROCESSOR(text=caption_prompt, images=image, return_tensors="pt")
        caption_inputs = move_batch_to_device(caption_inputs, DEVICE, TORCH_DTYPE)

        caption_ids = MODEL.generate(
            input_ids=caption_inputs.get("input_ids"),
            pixel_values=caption_inputs.get("pixel_values"),
            max_new_tokens=1024,
            num_beams=3,
            do_sample=True
        )
        caption_text = PROCESSOR.batch_decode(caption_ids, skip_special_tokens=True)[0]
        logger.info("Caption text (raw): %s", caption_text)

        # prefer using processor post_process if it works
        try:
            caption_parsed = PROCESSOR.post_process_generation(caption_text, task=caption_prompt, image_size=img_size)
            caption = caption_parsed.get("<MORE_DETAILED_CAPTION>", caption_text)
        except Exception:
            caption = caption_text

        # 2) grounding
        grounding_prompt = f"<CAPTION_TO_PHRASE_GROUNDING>{caption}"
        grounding_inputs = PROCESSOR(text=grounding_prompt, images=image, return_tensors="pt")
        grounding_inputs = move_batch_to_device(grounding_inputs, DEVICE, TORCH_DTYPE)

        grounding_ids = MODEL.generate(
            input_ids=grounding_inputs.get("input_ids"),
            pixel_values=grounding_inputs.get("pixel_values"),
            max_new_tokens=512,
            num_beams=3,
            do_sample=False
        )
        grounding_text = PROCESSOR.batch_decode(grounding_ids, skip_special_tokens=False)[0]
        logger.info("Grounding text (raw): %s", grounding_text)

        parsed = parse_grounding_output(grounding_text, "<CAPTION_TO_PHRASE_GROUNDING>", img_size)
        parsed["caption"] = caption

        return ObjectDetectionResponse(objects=parsed["objects"], caption=parsed["caption"])

    except Exception as e:
        logger.exception("Error during detect_objects: %s", e)
        raise HTTPException(status_code=500, detail=f"Error during object detection: {e}")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)