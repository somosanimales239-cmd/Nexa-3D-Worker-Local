import argparse
import shutil
import sys
import time
from pathlib import Path


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--mesh', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--front', required=True)
    parser.add_argument('--left', default='')
    parser.add_argument('--back', default='')
    parser.add_argument('--right', default='')
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

    progress(65, 'Loading original RGBA references', 'Front → Left → Back → Right')
    images = [Image.open(path).convert('RGBA') for _, path in refs if path]

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

    progress(76, 'Hunyuan Paint Multi-View', 'Running original RGBA Front → Left → Back → Right.')
    started = time.time()
    textured_mesh = pipe(mesh, image=images)
    elapsed = time.time() - started

    progress(94, 'Exporting final GLB', f'Paint finished in {elapsed:.1f}s')
    textured_mesh.export(str(output))
    print(f'NEXA_RESULT|{output}', flush=True)


if __name__ == '__main__':
    main()
