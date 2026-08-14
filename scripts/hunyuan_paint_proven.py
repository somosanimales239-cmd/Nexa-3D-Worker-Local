import argparse
import shutil
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def backup_once(path: Path):
    backup = path.with_suffix(path.suffix + '.before_low_vram_fix.bak')
    if not backup.exists():
        shutil.copy2(path, backup)


def patch_backend(root: Path):
    multiview = root / 'hy3dgen' / 'texgen' / 'utils' / 'multiview_utils.py'
    dehighlight = root / 'hy3dgen' / 'texgen' / 'utils' / 'dehighlight_utils.py'
    for path in (multiview, dehighlight):
        if not path.exists():
            raise FileNotFoundError(f'Missing: {path}')
        backup_once(path)

    text = multiview.read_text(encoding='utf-8')
    if 'trust_remote_code=True' not in text:
        old = 'custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16)'
        new = 'custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16, trust_remote_code=True)'
        if old not in text:
            raise RuntimeError('Could not find expected Hunyuan custom_pipeline call in multiview_utils.py')
        text = text.replace(old, new, 1)
    text = text.replace('self.pipeline = pipeline.to(self.device)', 'self.pipeline = pipeline')
    multiview.write_text(text, encoding='utf-8')

    text = dehighlight.read_text(encoding='utf-8')
    text = text.replace('self.pipeline = pipeline.to(self.device, torch.float16)', 'self.pipeline = pipeline')
    dehighlight.write_text(text, encoding='utf-8')


def progress(value, stage, message):
    print(f'NEXA_PROGRESS|{value}|{stage}|{message}', flush=True)


def safe_bbox(alpha, margin_ratio=0.06):
    bbox = alpha.getbbox()
    if not bbox:
        return None
    x1, y1, x2, y2 = bbox
    w = x2 - x1
    h = y2 - y1
    mx = max(8, int(w * margin_ratio))
    my = max(8, int(h * margin_ratio))
    return (max(0, x1 - mx), max(0, y1 - my), min(alpha.width, x2 + mx), min(alpha.height, y2 + my))


def enhance_image(img, object_type='auto', face_priority=False, texture_input_boost='off'):
    from PIL import Image, ImageFilter, ImageEnhance

    img = img.convert('RGBA')
    alpha = img.getchannel('A')
    bbox = safe_bbox(alpha)
    if bbox:
        img = img.crop(bbox)

    if texture_input_boost == 'safe_384':
        target_long = 1536
        scale = min(2.0, target_long / max(img.size))
        if scale > 1.0:
            img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)

    img = ImageEnhance.Color(img).enhance(1.06)
    img = ImageEnhance.Contrast(img).enhance(1.04)
    img = img.filter(ImageFilter.UnsharpMask(radius=1.3, percent=115, threshold=3))

    if face_priority and object_type == 'character':
        alpha = img.getchannel('A')
        bbox = safe_bbox(alpha, margin_ratio=0.0) or (0, 0, img.width, img.height)
        x1, y1, x2, y2 = bbox
        w = x2 - x1
        h = y2 - y1
        fx1 = max(0, x1 + int(w * 0.18))
        fx2 = min(img.width, x2 - int(w * 0.18))
        fy1 = max(0, y1)
        fy2 = min(img.height, y1 + int(h * 0.38))
        if fx2 > fx1 and fy2 > fy1:
            face = img.crop((fx1, fy1, fx2, fy2))
            base_size = 384 if texture_input_boost == 'safe_384' else max(face.size)
            if face.width > 0:
                face = face.resize((base_size, max(1, int(face.height * (base_size / face.width)))), Image.LANCZOS)
            face = ImageEnhance.Sharpness(face).enhance(1.35)
            face = ImageEnhance.Contrast(face).enhance(1.08)
            face = face.filter(ImageFilter.UnsharpMask(radius=1.0, percent=135, threshold=2))
            face = face.resize((fx2 - fx1, fy2 - fy1), Image.LANCZOS)
            img.alpha_composite(face, (fx1, fy1))

    return img


def polish_mesh_textures(mesh_obj):
    from PIL import ImageFilter, ImageEnhance

    def polish_image(img):
        img = img.convert('RGBA')
        img = ImageEnhance.Color(img).enhance(1.03)
        img = ImageEnhance.Contrast(img).enhance(1.03)
        img = img.filter(ImageFilter.UnsharpMask(radius=1.0, percent=105, threshold=2))
        return img

    material = getattr(getattr(mesh_obj, 'visual', None), 'material', None)
    if material is None:
        return False

    changed = False
    for attr in ('image', 'baseColorTexture'):
        value = getattr(material, attr, None)
        if value is None:
            continue
        try:
            polished = polish_image(value)
            setattr(material, attr, polished)
            changed = True
        except Exception:
            continue
    return changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--mesh', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--front', required=True)
    parser.add_argument('--left', default='')
    parser.add_argument('--back', default='')
    parser.add_argument('--right', default='')
    parser.add_argument('--object-type', default='auto')
    parser.add_argument('--texture-input-boost', default='off')
    parser.add_argument('--smart-reference-preprocess', action='store_true')
    parser.add_argument('--front-face-priority', action='store_true')
    parser.add_argument('--final-texture-polish', action='store_true')
    args = parser.parse_args()

    root = Path(args.root).resolve()
    mesh_in = Path(args.mesh).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(root))

    patch_backend(root)
    if not mesh_in.exists():
        raise FileNotFoundError(f'Missing mesh: {mesh_in}')

    refs = [('FRONT', args.front), ('LEFT', args.left), ('BACK', args.back), ('RIGHT', args.right)]
    missing = [path for _, path in refs if path and not Path(path).exists()]
    if missing:
        raise FileNotFoundError('Missing references: ' + ', '.join(missing))

    progress(62, 'Proven Paint backend ready', 'Low-VRAM backend patch verified.')

    import torch
    import trimesh
    from PIL import Image
    from hy3dgen.texgen import Hunyuan3DPaintPipeline

    progress(65, 'Loading original RGBA references', 'Front -> Left -> Back -> Right')
    images = [Image.open(path).convert('RGBA') for _, path in refs if path]

    if args.smart_reference_preprocess:
        progress(66, 'Safe 384 texture prep', 'Auto-crop, soft cleanup and controlled upscale on the reference views.')
        images = [enhance_image(
            img,
            object_type=args.object_type,
            face_priority=(args.front_face_priority and idx == 0),
            texture_input_boost=args.texture_input_boost,
        ) for idx, img in enumerate(images)]

    progress(67, 'Loading white_mesh.glb', 'Reloading the exported Shape mesh before Paint.')
    mesh = trimesh.load(str(mesh_in), force='mesh')

    progress(70, 'Loading Hunyuan Paint Turbo', 'tencent/Hunyuan3D-2 / hunyuan3d-paint-v2-0-turbo')
    pipe = Hunyuan3DPaintPipeline.from_pretrained(
        'tencent/Hunyuan3D-2',
        subfolder='hunyuan3d-paint-v2-0-turbo',
    )

    progress(73, 'Enabling Paint CPU offload', 'Using the same low-VRAM sequence as the successful local test.')
    pipe.enable_model_cpu_offload()
    torch.cuda.empty_cache()

    progress(76, 'Hunyuan Paint Multi-View', 'Paint is using the processed RGBA references in Front -> Left -> Back -> Right order.')
    started = time.time()
    textured_mesh = pipe(mesh, image=images)
    elapsed = time.time() - started

    if args.final_texture_polish:
        progress(90, 'Final texture polish', 'Conservative sharpen and cleanup on the baked material texture.')
        try:
            polish_mesh_textures(textured_mesh)
        except Exception as exc:
            progress(91, 'Texture polish skipped', f'Continuing with the painted texture. {exc}')

    progress(94, 'Exporting final GLB', f'Paint finished in {elapsed:.1f}s')
    textured_mesh.export(str(output))
    print(f'NEXA_RESULT|{output}', flush=True)


if __name__ == '__main__':
    main()
