import argparse
import gc
import json
import os
import random
import shutil
import sys
import time
from pathlib import Path


MAX_SEED = int(1e7)

# These values intentionally mirror the NON-TURBO Hunyuan3D-2mv Gradio UI
# used locally at 127.0.0.1:8082.
GRADIO_8082_STEPS = 30
GRADIO_8082_GUIDANCE = 5.0
GRADIO_8082_OCTREE = 256
GRADIO_8082_CHUNKS = 8000
GRADIO_8082_REMOVE_BACKGROUND = True
GRADIO_8082_RANDOMIZE_SEED = True


def progress(value, stage, message):
    print(f"NEXA_PROGRESS|{int(value)}|{stage}|{message}", flush=True)


def ensure_backend_compat(root: Path):
    """
    Preserve the exact two Paint compatibility changes that were required by the
    already-successful local run_paint_fixed.py flow.
    """
    multiview = root / "hy3dgen" / "texgen" / "utils" / "multiview_utils.py"
    dehighlight = root / "hy3dgen" / "texgen" / "utils" / "dehighlight_utils.py"

    for path in (multiview, dehighlight):
        if not path.exists():
            raise FileNotFoundError(f"Missing Hunyuan backend file: {path}")
        backup = path.with_suffix(path.suffix + ".before_low_vram_fix.bak")
        if not backup.exists():
            shutil.copy2(path, backup)

    text = multiview.read_text(encoding="utf-8")
    if "trust_remote_code=True" not in text:
        old = "custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16)"
        new = "custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16, trust_remote_code=True)"
        if old not in text:
            raise RuntimeError(
                "Could not find the expected Hunyuan Paint custom-pipeline call. "
                "The local backend was not modified."
            )
        text = text.replace(old, new, 1)
    text = text.replace(
        "self.pipeline = pipeline.to(self.device)",
        "self.pipeline = pipeline",
    )
    multiview.write_text(text, encoding="utf-8")

    text = dehighlight.read_text(encoding="utf-8")
    text = text.replace(
        "self.pipeline = pipeline.to(self.device, torch.float16)",
        "self.pipeline = pipeline",
    )
    dehighlight.write_text(text, encoding="utf-8")


def load_rgba(Image, file_path: str):
    with Image.open(file_path) as image:
        return image.convert("RGBA").copy()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hunyuan-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--front", required=True)
    parser.add_argument("--back", default="")
    parser.add_argument("--left", default="")
    parser.add_argument("--right", default="")
    parser.add_argument("--shape-only", action="store_true")
    parser.add_argument("--cache-dir", default="")
    parser.add_argument("--temp-dir", default="")
    args = parser.parse_args()

    root = Path(args.hunyuan_root).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.cache_dir:
        cache = Path(args.cache_dir).resolve()
        cache.mkdir(parents=True, exist_ok=True)
        os.environ["HF_HOME"] = str(cache)
        os.environ["HF_HUB_CACHE"] = str(cache / "hub")
        os.environ["HUGGINGFACE_HUB_CACHE"] = str(cache / "hub")
        os.environ["TRANSFORMERS_CACHE"] = str(cache / "transformers")
        os.environ["TORCH_HOME"] = str(cache / "torch")

    if args.temp_dir:
        temp = Path(args.temp_dir).resolve()
        temp.mkdir(parents=True, exist_ok=True)
        os.environ["TEMP"] = str(temp)
        os.environ["TMP"] = str(temp)

    sys.path.insert(0, str(root))
    progress(4, "8082 parity check", "Using the existing local Hunyuan installation; no model reinstall.")

    # Patch before importing Paint/native modules, exactly as the successful Paint run did.
    ensure_backend_compat(root)

    import torch
    import trimesh
    from PIL import Image
    from hy3dgen.rembg import BackgroundRemover
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    from hy3dgen.shapegen.pipelines import export_to_trimesh

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available to Hunyuan3D.")

    progress(7, "GPU ready", torch.cuda.get_device_name(0))

    source_paths = {
        "front": args.front,
        "back": args.back,
        "left": args.left,
        "right": args.right,
    }
    raw_views = {
        key: load_rgba(Image, file_path)
        for key, file_path in source_paths.items()
        if file_path
    }
    if "front" not in raw_views:
        raise RuntimeError("Front reference is required.")

    # IMPORTANT: the Gradio 8082 UI had Remove Background=ON.
    # That means every supplied view is converted to RGB and passed through rmbg,
    # even when the uploaded file already has RGBA transparency.
    rmbg_worker = BackgroundRemover()
    shape_views = {}
    for key in ("front", "back", "left", "right"):
        if key in raw_views:
            shape_views[key] = rmbg_worker(raw_views[key].convert("RGB"))

    seed = random.randint(0, MAX_SEED)
    progress(
        12,
        "8082 references prepared",
        "Remove Background ON · Randomize Seed ON · "
        + " + ".join(key.upper() for key in ("front", "back", "left", "right") if key in shape_views),
    )

    progress(
        16,
        "Loading Hunyuan3D-2mv",
        "Model tencent/Hunyuan3D-2mv / hunyuan3d-dit-v2-mv",
    )
    shape_pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        "tencent/Hunyuan3D-2mv",
        subfolder="hunyuan3d-dit-v2-mv",
        use_safetensors=True,
        device="cuda",
    )

    # Exact NON-TURBO Gradio 8082 Advanced Options:
    # steps=30, CFG=5.0, octree=256, chunks=8000, randomized seed.
    progress(
        22,
        "Generating shape — exact 8082 preset",
        f"steps={GRADIO_8082_STEPS} · cfg={GRADIO_8082_GUIDANCE} · "
        f"octree={GRADIO_8082_OCTREE} · chunks={GRADIO_8082_CHUNKS} · seed={seed}",
    )
    generator = torch.Generator()
    generator = generator.manual_seed(seed)

    started = time.time()
    outputs = shape_pipeline(
        image=shape_views,
        num_inference_steps=GRADIO_8082_STEPS,
        guidance_scale=GRADIO_8082_GUIDANCE,
        generator=generator,
        octree_resolution=GRADIO_8082_OCTREE,
        num_chunks=GRADIO_8082_CHUNKS,
        output_type="mesh",
    )
    mesh = export_to_trimesh(outputs)[0]
    shape_seconds = time.time() - started

    # Match Gradio's raw "Gen Shape" output: do NOT simplify/reduce the mesh here.
    white_mesh = output_dir / "white_mesh.glb"
    mesh.export(str(white_mesh), include_normals=False)

    debug = {
        "preset": "gradio_8082_exact",
        "model": "tencent/Hunyuan3D-2mv",
        "subfolder": "hunyuan3d-dit-v2-mv",
        "steps": GRADIO_8082_STEPS,
        "guidance_scale": GRADIO_8082_GUIDANCE,
        "octree_resolution": GRADIO_8082_OCTREE,
        "num_chunks": GRADIO_8082_CHUNKS,
        "remove_background": GRADIO_8082_REMOVE_BACKGROUND,
        "randomize_seed": GRADIO_8082_RANDOMIZE_SEED,
        "seed": seed,
        "faces": int(mesh.faces.shape[0]),
        "vertices": int(mesh.vertices.shape[0]),
        "shape_seconds": round(shape_seconds, 3),
        "paint_view_order": ["front", "left", "back", "right"],
    }
    (output_dir / "nexa_8082_parity.json").write_text(
        json.dumps(debug, indent=2),
        encoding="utf-8",
    )

    progress(
        54,
        "Shape complete",
        f"{debug['faces']} faces · {debug['vertices']} vertices · seed={seed}",
    )

    if args.shape_only:
        print(f"NEXA_RESULT|{white_mesh}", flush=True)
        return

    # IMPORTANT: the proven successful Paint test loaded the exported GLB back
    # with trimesh before Paint. Do the same instead of passing the in-memory
    # shape object directly.
    del outputs, mesh, shape_pipeline, rmbg_worker, shape_views
    gc.collect()
    torch.cuda.empty_cache()

    progress(59, "Reloading proven shape GLB", "Reloading white_mesh.glb before Paint, matching the successful local Paint test.")
    paint_mesh = trimesh.load(str(white_mesh), force="mesh")

    progress(63, "Loading Hunyuan Paint Turbo", "Using the same low-VRAM Paint path that produced girl_textured.glb.")
    from hy3dgen.texgen import Hunyuan3DPaintPipeline

    paint_pipeline = Hunyuan3DPaintPipeline.from_pretrained(
        "tencent/Hunyuan3D-2",
        subfolder="hunyuan3d-paint-v2-0-turbo",
    )
    paint_pipeline.enable_model_cpu_offload()
    torch.cuda.empty_cache()

    # IMPORTANT: Paint uses the ORIGINAL RGBA references, not the rembg versions.
    # This exactly mirrors run_paint_fixed.py:
    # FRONT -> LEFT -> BACK -> RIGHT.
    paint_images = [
        raw_views[key]
        for key in ("front", "left", "back", "right")
        if key in raw_views
    ]
    progress(
        70,
        "Paint references ready",
        "Original RGBA order: " + " → ".join(
            key.upper() for key in ("front", "left", "back", "right") if key in raw_views
        ),
    )

    paint_started = time.time()
    progress(73, "Hunyuan Paint Multi-View", "Running the already-proven four-reference Paint pipeline.")
    textured_mesh = paint_pipeline(paint_mesh, image=paint_images)
    paint_seconds = time.time() - paint_started

    final_glb = output_dir / "final.glb"
    textured_mesh.export(str(final_glb))

    debug["paint_seconds"] = round(paint_seconds, 3)
    debug["final_glb"] = str(final_glb)
    (output_dir / "nexa_8082_parity.json").write_text(
        json.dumps(debug, indent=2),
        encoding="utf-8",
    )

    progress(96, "Paint complete", f"{paint_seconds:.1f}s · no Blender · no Face Polish · no Texture Polish.")
    progress(99, "Final GLB ready", final_glb.name)
    print(f"NEXA_RESULT|{final_glb}", flush=True)


if __name__ == "__main__":
    main()
