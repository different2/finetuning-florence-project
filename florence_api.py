# Version 4.3: Improved regex for multiple boxes per label
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
import base64
from io import BytesIO
import torch
import os
from transformers import AutoModelForCausalLM, AutoProcessor
from transformers.dynamic_module_utils import get_imports
from unittest.mock import patch
import logging
import re
import ast
from fastapi.middleware.cors import CORSMiddleware

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Pydantic Models ---
class BoundingBox(BaseModel):
    box: list[float]
    label: str

class ObjectDetectionRequest(BaseModel):
    image_b64: str

class ObjectDetectionResponse(BaseModel):
    objects: list[BoundingBox]
    caption: str

# --- Florence Model Loading ---
MODEL = None
PROCESSOR = None
DEVICE = "cpu"
TORCH_DTYPE = torch.float32

def fixed_get_imports(filename: str | os.PathLike) -> list[str]:
    if os.path.basename(str(filename)) == "modeling_florence2.py":
        imports = get_imports(filename)
        if "flash_attn" in imports:
            logger.info("Patching model file to remove 'flash_attn' requirement...")
            imports.remove("flash_attn")
        return imports
    return get_imports(filename)

def load_model():
    global MODEL, PROCESSOR, DEVICE, TORCH_DTYPE
    if torch.backends.mps.is_available():
        DEVICE = "mps"
        TORCH_DTYPE = torch.float16
        logger.info("Using Apple GPU (MPS) for acceleration.")
    else:
        logger.info("Using CPU.")

    model_id = "microsoft/Florence-2-large"
    logger.info(f"Loading model: {model_id}...")

    try:
        with patch("transformers.dynamic_module_utils.get_imports", fixed_get_imports):
            MODEL = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=TORCH_DTYPE, trust_remote_code=True).to(DEVICE)
            PROCESSOR = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        logger.info("Model and processor loaded successfully.")
    except Exception as e:
        logger.error(f"Fatal error during model loading: {e}")
        exit()

# --- FastAPI Application ---
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup_event():
    logger.info("Application startup...")
    load_model()

@app.get("/")
def read_root():
    return {"status": "Florence-2 API is running"}

def parse_grounding_output(text: str, task_prompt: str, image_size: tuple):
    """Parse Florence-2 output and convert to absolute coordinates"""
    logger.info(f"Raw model output:\n{text}")

    try:
        # Attempt to use the processor's post-processing first
        parsed = PROCESSOR.post_process_generation(
            text,
            task=task_prompt,
            image_size=image_size
        )
        logger.info(f"Processor-based parsed output: {parsed}")

        if task_prompt == "<CAPTION_TO_PHRASE_GROUNDING>":
            data = parsed.get("<CAPTION_TO_PHRASE_GROUNDING>", {})
            bboxes = data.get("bboxes", [])
            labels = data.get("labels", [])

            if bboxes and labels and len(bboxes) == len(labels):
                objects = [BoundingBox(box=box, label=label) for box, label in zip(bboxes, labels)]
                logger.info(f"Successfully parsed {len(objects)} objects using processor.")
                return {"objects": objects}
    except Exception as e:
        logger.warning(f"Processor-based parsing failed: {e}. Falling back to manual parsing.")

    # Fallback to manual regex-based parsing
    logger.info("Falling back to manual regex-based parsing.")
    try:
        text = text.replace(task_prompt, "").replace("<s>", "").replace("</s>", "").strip()

        # Regex to find all label and bbox groups iteratively
        pattern = re.compile(r"([a-zA-Z\s]+?)((?:<loc_\d+>){4,})")
        matches = pattern.findall(text)
        
        objects = []
        img_width, img_height = image_size
        loc_pattern = re.compile(r"<loc_(\d+)>")

        for match in matches:
            label = match[0].strip()
            all_locs_str = match[1]
            loc_values = [int(v) for v in loc_pattern.findall(all_locs_str)]
            
            # Group locs into sets of 4 for each bounding box
            boxes = [loc_values[i:i + 4] for i in range(0, len(loc_values), 4)]

            for box in boxes:
                if len(box) == 4:
                    x1 = float(box[0]) / 1000.0 * img_width
                    y1 = float(box[1]) / 1000.0 * img_height
                    x2 = float(box[2]) / 1000.0 * img_width
                    y2 = float(box[3]) / 1000.0 * img_height
                    
                    if label:
                        objects.append(BoundingBox(box=[x1, y1, x2, y2], label=label))
            
        logger.info(f"Successfully parsed {len(objects)} objects using manual regex.")
        return {"objects": objects}

    except Exception as e:
        logger.error(f"Manual regex parsing also failed: {e}")
        return {"objects": []}

@app.post("/detect-objects", response_model=ObjectDetectionResponse)
async def detect_objects(request: ObjectDetectionRequest):
    if not MODEL or not PROCESSOR:
        raise HTTPException(status_code=503, detail="Model not loaded.")

    try:
        image_bytes = base64.b64decode(request.image_b64)
        image = Image.open(BytesIO(image_bytes)).convert("RGB")
        image_size = (image.width, image.height)
        
        logger.info(f"Processing image with original size {image_size}.")

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image data: {e}")

    try:
        logger.info("Step 1: Generating detailed caption...")
        caption_prompt = "<MORE_DETAILED_CAPTION>"
        caption_inputs = PROCESSOR(text=caption_prompt, images=image, return_tensors="pt").to(DEVICE, TORCH_DTYPE)

        caption_ids = MODEL.generate(
            input_ids=caption_inputs["input_ids"],
            pixel_values=caption_inputs.get("pixel_values"),
            max_new_tokens=1024,
            num_beams=3,
            do_sample=False
        )
        
        caption_text = PROCESSOR.batch_decode(caption_ids, skip_special_tokens=False)[0]
        logger.info(f"Caption generation output: {caption_text}")
        
        caption_parsed = PROCESSOR.post_process_generation(
            caption_text,
            task="<MORE_DETAILED_CAPTION>",
            image_size=image_size
        )
        caption = caption_parsed.get("<MORE_DETAILED_CAPTION>", "")
        logger.info(f"Extracted caption: {caption}")
        
        logger.info("Step 2: Performing phrase grounding...")
        grounding_prompt = f"<CAPTION_TO_PHRASE_GROUNDING>{caption}"
        grounding_inputs = PROCESSOR(text=grounding_prompt, images=image, return_tensors="pt").to(DEVICE, TORCH_DTYPE)

        grounding_ids = MODEL.generate(
            input_ids=grounding_inputs["input_ids"],
            pixel_values=grounding_inputs.get("pixel_values"),
            max_new_tokens=1024,
            num_beams=3,
            do_sample=False
        )
        
        grounding_text = PROCESSOR.batch_decode(grounding_ids, skip_special_tokens=False)[0]
        logger.info(f"Grounding output: {grounding_text}")
        
        parsed_data = parse_grounding_output(grounding_text, "<CAPTION_TO_PHRASE_GROUNDING>", image_size)
        parsed_data["caption"] = caption

        return ObjectDetectionResponse(objects=parsed_data["objects"], caption=parsed_data["caption"])

    except Exception as e:
        logger.error(f"Error during object detection: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"An error occurred during object detection: {e}")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
