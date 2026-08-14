import argparse
import shutil
from pathlib import Path

BEGIN_190 = '# NEXA_PERSISTENT_API_V1_BEGIN'
END_190 = '# NEXA_PERSISTENT_API_V1_END'
BEGIN = '# NEXA_SHAPE_API_V191_BEGIN'
END = '# NEXA_SHAPE_API_V191_END'


def backup_once(path: Path, suffix: str):
    out = path.with_name(path.name + suffix)
    if not out.exists():
        shutil.copy2(path, out)
    return out


def remove_block(text: str, begin: str, end: str) -> str:
    if begin not in text or end not in text:
        return text
    start = text.index(begin)
    line_start = text.rfind('\n', 0, start) + 1
    finish = text.index(end, start) + len(end)
    line_end = text.find('\n', finish)
    if line_end < 0:
        line_end = len(text)
    else:
        line_end += 1
    return text[:line_start] + text[line_end:]


def api_block():
    return r'''
    # NEXA_SHAPE_API_V191_BEGIN
    from fastapi import Request as _NexaShapeRequest
    from fastapi.responses import JSONResponse as _NexaShapeJSONResponse
    from PIL import Image as _NexaShapeImage
    import threading as _nexa_shape_threading
    import traceback as _nexa_shape_traceback

    _nexa_shape_jobs = {}
    _nexa_shape_lock = _nexa_shape_threading.Lock()
    _nexa_shape_generation_lock = _nexa_shape_threading.Lock()

    def _nexa_shape_set(job_id, **updates):
        with _nexa_shape_lock:
            item = dict(_nexa_shape_jobs.get(job_id, {}))
            item.update(updates)
            item['updated_at'] = time.time()
            _nexa_shape_jobs[job_id] = item
            return dict(item)

    def _nexa_shape_get(job_id):
        with _nexa_shape_lock:
            return dict(_nexa_shape_jobs.get(job_id, {}))

    def _nexa_shape_open(file_path):
        with _NexaShapeImage.open(file_path) as im:
            return im.convert('RGBA').copy()

    def _nexa_shape_tick(job_id, stop_event, started):
        while not stop_event.wait(15):
            _nexa_shape_set(
                job_id,
                progress=34,
                stage='Hunyuan3D-2mv shape generation',
                message=f'Shape generation active · {int(time.time()-started)}s elapsed'
            )

    def _nexa_shape_run(job_id, payload):
        with _nexa_shape_generation_lock:
            try:
                output_dir = os.path.abspath(str(payload.get('output_dir') or ''))
                if not output_dir:
                    raise ValueError('output_dir is required')
                os.makedirs(output_dir, exist_ok=True)

                refs = {k: str(payload.get(k) or '') for k in ('front', 'back', 'left', 'right')}
                if not refs['front'] or not os.path.exists(refs['front']):
                    raise FileNotFoundError('Front reference is missing')

                raw = {
                    k: _nexa_shape_open(refs[k])
                    for k in ('front', 'back', 'left', 'right')
                    if refs[k] and os.path.exists(refs[k])
                }
                _nexa_shape_set(
                    job_id,
                    status='processing',
                    progress=26,
                    stage='Preparing 8082 Shape references',
                    message='Front + Back + Left + Right loaded as RGBA files'
                )

                started = time.time()
                stop = _nexa_shape_threading.Event()
                _nexa_shape_threading.Thread(
                    target=_nexa_shape_tick,
                    args=(job_id, stop, started),
                    daemon=True
                ).start()

                try:
                    mesh, _main, _folder, stats, seed = _gen_shape(
                        caption=None,
                        image=None,
                        mv_image_front=raw.get('front'),
                        mv_image_back=raw.get('back'),
                        mv_image_left=raw.get('left'),
                        mv_image_right=raw.get('right'),
                        steps=30,
                        guidance_scale=5.0,
                        seed=1234,
                        octree_resolution=256,
                        check_box_rembg=True,
                        num_chunks=8000,
                        randomize_seed=True,
                    )
                finally:
                    stop.set()

                result = os.path.join(output_dir, 'white_mesh.glb')
                mesh.export(result, include_normals=False)
                _nexa_shape_set(
                    job_id,
                    status='completed',
                    progress=56,
                    stage='8082 Shape complete',
                    message=f'white_mesh.glb ready · {int(mesh.faces.shape[0])} faces · seed {seed}',
                    result_path=result,
                    seed=int(seed),
                    stats=stats
                )
            except Exception as exc:
                _nexa_shape_traceback.print_exc()
                _nexa_shape_set(
                    job_id,
                    status='failed',
                    progress=max(20, int(_nexa_shape_get(job_id).get('progress', 20))),
                    stage='8082 Shape failed',
                    message=str(exc),
                    error=str(exc)
                )

    @app.get('/nexa/health')
    async def nexa_shape_health():
        return _NexaShapeJSONResponse({
            'ok': True,
            'service': 'nexa-hunyuan-shape-8082-v1',
            'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU',
            'texture_loaded': False,
            'preset': {
                'steps': 30,
                'guidance_scale': 5.0,
                'octree_resolution': 256,
                'num_chunks': 8000,
                'remove_background': True,
                'randomize_seed': True,
            }
        })

    @app.post('/nexa/shape')
    async def nexa_shape_generate(request: _NexaShapeRequest):
        payload = await request.json()
        job_id = str(uuid.uuid4())
        _nexa_shape_set(
            job_id,
            status='queued',
            progress=20,
            stage='Accepted by 8082 Shape engine',
            message='Using already-loaded Hunyuan3D-2mv Shape model.'
        )
        _nexa_shape_threading.Thread(target=_nexa_shape_run, args=(job_id, payload), daemon=True).start()
        return _NexaShapeJSONResponse({'ok': True, 'job_id': job_id})

    @app.get('/nexa/status/{job_id}')
    async def nexa_shape_status(job_id: str):
        item = _nexa_shape_get(job_id)
        if not item:
            return _NexaShapeJSONResponse({'ok': False, 'error': 'Unknown Shape job'}, status_code=404)
        return _NexaShapeJSONResponse({'ok': True, **item})
    # NEXA_SHAPE_API_V191_END
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    path = root / 'gradio_app.py'
    if not path.exists():
        raise FileNotFoundError(path)

    backup_once(path, '.before_nexa_shape_api_191.bak')
    text = path.read_text(encoding='utf-8')
    text = remove_block(text, BEGIN_190, END_190)
    text = remove_block(text, BEGIN, END)

    # Undo the 1.9.0 forced Paint loader edit if it was applied. 1.9.1 launches 8082 with --disable_tex.
    text = text.replace(
        "texgen_worker = Hunyuan3DPaintPipeline.from_pretrained(args.texgen_model_path, subfolder='hunyuan3d-paint-v2-0-turbo')",
        "texgen_worker = Hunyuan3DPaintPipeline.from_pretrained(args.texgen_model_path)"
    )

    marker = '    app = FastAPI()\n'
    if marker not in text:
        marker = '    app = FastAPI()\r\n'
    if marker not in text:
        raise RuntimeError('FastAPI app marker not found; gradio_app.py was not modified.')

    newline = '\r\n' if '\r\n' in text else '\n'
    text = text.replace(marker, marker + api_block().replace('\n', newline), 1)
    compile(text, str(path), 'exec')
    path.write_text(text, encoding='utf-8')
    print('NEXA_SHAPE_API_191_OK')


if __name__ == '__main__':
    main()
