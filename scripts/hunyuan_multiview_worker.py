import argparse
import gc
import os
import shutil
import sys
import time
from pathlib import Path


def progress(value, stage, message):
    print(f"NEXA_PROGRESS|{int(value)}|{stage}|{message}", flush=True)


def ensure_backend_compat(root: Path):
    """Apply only the two compatibility changes already proven necessary for Paint on this local install."""
    mv = root / 'hy3dgen' / 'texgen' / 'utils' / 'multiview_utils.py'
    dl = root / 'hy3dgen' / 'texgen' / 'utils' / 'dehighlight_utils.py'
    for path in (mv, dl):
        if not path.exists():
            raise FileNotFoundError(f"Missing Hunyuan backend file: {path}")
        backup = path.with_suffix(path.suffix + '.nexa_before_worker_180.bak')
        if not backup.exists():
            shutil.copy2(path, backup)

    text = mv.read_text(encoding='utf-8')
    if 'trust_remote_code=True' not in text:
        old = "custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16)"
        if old not in text:
            raise RuntimeError('Hunyuan Paint custom pipeline call changed; refusing an unsafe automatic patch.')
        text = text.replace(old, "custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16, trust_remote_code=True)", 1)
    text = text.replace('self.pipeline = pipeline.to(self.device)', 'self.pipeline = pipeline')
    mv.write_text(text, encoding='utf-8')

    text = dl.read_text(encoding='utf-8')
    text = text.replace('self.pipeline = pipeline.to(self.device, torch.float16)', 'self.pipeline = pipeline')
    dl.write_text(text, encoding='utf-8')


def load_image(Image, file):
    if not file:
        return None
    image = Image.open(file)
    if image.mode not in ('RGB', 'RGBA'):
        image = image.convert('RGBA')
    return image


def face_priority_reference(Image, ImageEnhance, ImageFilter, image, output: Path):
    """Create a higher-detail head/upper-torso reference; it is extra Paint evidence, not a destructive mesh edit."""
    import numpy as np
    work = image.convert('RGBA')
    arr = np.asarray(work)
    alpha = arr[:, :, 3]
    pts = np.argwhere(alpha > 8)
    if pts.size:
        y0, x0 = pts.min(axis=0)
        y1, x1 = pts.max(axis=0)
    else:
        x0, y0, x1, y1 = 0, 0, work.width - 1, work.height - 1
    bw, bh = max(1, x1 - x0 + 1), max(1, y1 - y0 + 1)
    cx = (x0 + x1) / 2.0
    crop_w = max(64, int(bw * 0.58))
    crop_h = max(64, int(bh * 0.34))
    left = max(0, int(cx - crop_w / 2))
    right = min(work.width, int(cx + crop_w / 2))
    top = max(0, int(y0 - bh * 0.015))
    bottom = min(work.height, top + crop_h)
    crop = work.crop((left, top, right, bottom))
    side = max(crop.size)
    canvas = Image.new('RGBA', (side, side), (255, 255, 255, 0))
    canvas.alpha_composite(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
    canvas = canvas.resize((768, 768), Image.Resampling.LANCZOS)
    canvas = canvas.filter(ImageFilter.UnsharpMask(radius=0.9, percent=115, threshold=2))
    canvas = ImageEnhance.Contrast(canvas).enhance(1.02)
    canvas.save(output)
    return canvas


def get_texture_image(material):
    for attr in ('image', 'baseColorTexture'):
        value = getattr(material, attr, None)
        if value is None:
            continue
        if hasattr(value, 'filter') and hasattr(value, 'save'):
            return attr, value
        nested = getattr(value, 'image', None)
        if nested is not None and hasattr(nested, 'filter'):
            return (attr, value, nested)
    return None


def texture_polish(ImageEnhance, ImageFilter, mesh):
    material = getattr(getattr(mesh, 'visual', None), 'material', None)
    if material is None:
        return False
    found = get_texture_image(material)
    if not found:
        return False
    image = found[-1]
    polished = image.filter(ImageFilter.UnsharpMask(radius=1.0, percent=110, threshold=3))
    polished = ImageEnhance.Contrast(polished).enhance(1.018)
    polished = ImageEnhance.Color(polished).enhance(1.018)
    if len(found) == 2:
        setattr(material, found[0], polished)
    else:
        found[1].image = polished
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hunyuan-root', required=True)
    ap.add_argument('--output-dir', required=True)
    ap.add_argument('--front', required=True)
    ap.add_argument('--back', default='')
    ap.add_argument('--left', default='')
    ap.add_argument('--right', default='')
    ap.add_argument('--quality-profile', choices=['vram_safe', 'balanced', 'high'], default='high')
    ap.add_argument('--face-polish', action='store_true')
    ap.add_argument('--texture-polish', action='store_true')
    ap.add_argument('--shape-only', action='store_true')
    ap.add_argument('--cache-dir', default='')
    ap.add_argument('--temp-dir', default='')
    args = ap.parse_args()

    root = Path(args.hunyuan_root).resolve()
    out = Path(args.output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)

    if args.cache_dir:
        cache = str(Path(args.cache_dir).resolve())
        os.environ['HF_HOME'] = cache
        os.environ['HF_HUB_CACHE'] = str(Path(cache) / 'hub')
        os.environ['HUGGINGFACE_HUB_CACHE'] = str(Path(cache) / 'hub')
        os.environ['TRANSFORMERS_CACHE'] = str(Path(cache) / 'transformers')
        os.environ['TORCH_HOME'] = str(Path(cache) / 'torch')
    if args.temp_dir:
        temp = str(Path(args.temp_dir).resolve())
        Path(temp).mkdir(parents=True, exist_ok=True)
        os.environ['TEMP'] = temp
        os.environ['TMP'] = temp

    sys.path.insert(0, str(root))
    progress(5, 'Preparing Hunyuan backend', 'Using the existing Hunyuan installation and the proven low-VRAM Paint compatibility fix.')
    ensure_backend_compat(root)

    import torch
    from PIL import Image, ImageEnhance, ImageFilter
    from hy3dgen.rembg import BackgroundRemover
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    from hy3dgen.shapegen.pipelines import export_to_trimesh

    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is not available to Hunyuan3D.')
    progress(8, 'GPU ready', torch.cuda.get_device_name(0))

    views = {k: load_image(Image, v) for k, v in {
        'front': args.front, 'back': args.back, 'left': args.left, 'right': args.right
    }.items() if v}
    if 'front' not in views:
        raise RuntimeError('Front reference is required.')

    rembg = BackgroundRemover()
    for key, image in list(views.items()):
        if image.mode == 'RGB':
            views[key] = rembg(image)
    progress(12, 'References prepared', ' + '.join(k.upper() for k in ('front','back','left','right') if k in views))

    profiles = {
        'vram_safe': (35, 256, 20000),
        'balanced': (50, 256, 50000),
        'high': (50, 320, 40000),
    }
    fallback_order = {'high':['high','balanced','vram_safe'], 'balanced':['balanced','vram_safe'], 'vram_safe':['vram_safe']}

    progress(16, 'Loading Hunyuan3D-2mv shape', 'Native multi-view geometry model.')
    shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        'tencent/Hunyuan3D-2mv', subfolder='hunyuan3d-dit-v2-mv', use_safetensors=True, device='cuda'
    )
    mesh = None
    used_profile = None
    order = fallback_order[args.quality_profile]
    for index, profile in enumerate(order):
        steps, octree, chunks = profiles[profile]
        try:
            progress(22, 'Generating native multi-view shape', f'{steps} steps · octree {octree} · profile {profile}.')
            generator = torch.Generator().manual_seed(12345)
            outputs = shape(image=views, num_inference_steps=steps, guidance_scale=7.5, generator=generator,
                            octree_resolution=octree, num_chunks=chunks, output_type='mesh')
            mesh = export_to_trimesh(outputs)[0]
            used_profile = profile
            break
        except RuntimeError as exc:
            if 'out of memory' not in str(exc).lower() or index == len(order)-1:
                raise
            print(f'[Nexa] CUDA OOM on {profile}; retrying with {order[index+1]}.', flush=True)
            torch.cuda.empty_cache(); gc.collect()
    if mesh is None:
        raise RuntimeError('Hunyuan3D did not return a mesh.')

    white = out / 'white_mesh.glb'
    mesh.export(str(white))
    progress(55, 'Shape complete', f'{mesh.faces.shape[0]} faces · profile {used_profile}.')
    if args.shape_only:
        print(f'NEXA_RESULT|{white}', flush=True)
        return

    del shape, rembg
    gc.collect(); torch.cuda.empty_cache()

    progress(60, 'Loading Hunyuan Paint Turbo', 'Shape model released; Paint loads separately with CPU offload.')
    from hy3dgen.texgen import Hunyuan3DPaintPipeline
    paint = Hunyuan3DPaintPipeline.from_pretrained('tencent/Hunyuan3D-2', subfolder='hunyuan3d-paint-v2-0-turbo')
    paint.enable_model_cpu_offload()
    torch.cuda.empty_cache()

    ordered = [views[k] for k in ('front','left','back','right') if k in views]
    if args.face_polish:
        detail = face_priority_reference(Image, ImageEnhance, ImageFilter, views['front'], out / 'face_priority_reference.png')
        ordered.append(detail)
        progress(68, 'Face Priority reference', 'A sharpened head/upper-torso reference was added as extra Paint evidence.')
    else:
        progress(68, 'Paint references ready', f'{len(ordered)} multi-view references.')

    progress(72, 'Hunyuan Paint Multi-View', 'Generating one coherent UV texture from all available references.')
    started = time.time()
    textured = paint(mesh, image=ordered)
    textured_path = out / 'textured.glb'
    textured.export(str(textured_path))
    progress(90, 'Paint complete', f'{time.time()-started:.1f}s texture generation.')

    if args.texture_polish:
        changed = texture_polish(ImageEnhance, ImageFilter, textured)
        progress(94, 'Texture Polish', 'Conservative texture sharpening applied.' if changed else 'No safe atlas image handle was exposed; original Hunyuan Paint texture was preserved.')

    final = out / 'final.glb'
    textured.export(str(final))
    progress(98, 'Final GLB ready', final.name)
    print(f'NEXA_RESULT|{final}', flush=True)


if __name__ == '__main__':
    main()
