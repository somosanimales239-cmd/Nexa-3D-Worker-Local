import argparse
import shutil
from pathlib import Path
MARKER_BEGIN = '# NEXA_PERSISTENT_API_V1_BEGIN'
MARKER_END = '# NEXA_PERSISTENT_API_V1_END'

def backup_once(path: Path, suffix: str):
    backup = path.with_name(path.name + suffix)
    if not backup.exists(): shutil.copy2(path, backup)
    return backup

def patch_low_vram(root: Path):
    mv = root / 'hy3dgen' / 'texgen' / 'utils' / 'multiview_utils.py'
    dl = root / 'hy3dgen' / 'texgen' / 'utils' / 'dehighlight_utils.py'
    for path in (mv, dl):
        if not path.exists(): raise FileNotFoundError(f'Missing Hunyuan Paint backend file: {path}')
        backup_once(path, '.nexa_persistent_190.bak')
    text = mv.read_text(encoding='utf-8')
    if 'trust_remote_code=True' not in text:
        old = 'custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16)'
        new = 'custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16, trust_remote_code=True)'
        if old not in text: raise RuntimeError('Could not locate Hunyuan Paint custom-pipeline call; no unsafe patch was attempted.')
        text = text.replace(old, new, 1)
    text = text.replace('self.pipeline = pipeline.to(self.device)', 'self.pipeline = pipeline')
    mv.write_text(text, encoding='utf-8')
    text = dl.read_text(encoding='utf-8').replace('self.pipeline = pipeline.to(self.device, torch.float16)', 'self.pipeline = pipeline')
    dl.write_text(text, encoding='utf-8')
    print('LOW_VRAM_PATCH_OK')

def patch_windows_inpaint(root: Path):
    path = root / 'hy3dgen' / 'texgen' / 'differentiable_renderer' / 'mesh_processor.py'
    if not path.exists(): print('INPAINT_DEDUP_SKIPPED: mesh_processor.py not found'); return
    backup_once(path, '.nexa_windows_speed_190.bak')
    text = path.read_text(encoding='utf-8'); marker = 'while smooth_count > 0:'
    dedup = 'while smooth_count > 0:\n        uncolored_vtxs = list(set(uncolored_vtxs))  # NEXA_WINDOWS_DEDUP_V1'
    if 'NEXA_WINDOWS_DEDUP_V1' in text: print('INPAINT_DEDUP_ALREADY_PRESENT'); return
    if marker not in text: print('INPAINT_DEDUP_SKIPPED: loop marker not found'); return
    path.write_text(text.replace(marker, dedup, 1), encoding='utf-8'); print('INPAINT_DEDUP_PATCH_OK')

def patch_paint_turbo(text: str):
    if 'hunyuan3d-paint-v2-0-turbo' in text: return text, False
    old = 'texgen_worker = Hunyuan3DPaintPipeline.from_pretrained(args.texgen_model_path)'
    new = "texgen_worker = Hunyuan3DPaintPipeline.from_pretrained(args.texgen_model_path, subfolder='hunyuan3d-paint-v2-0-turbo')"
    return (text.replace(old, new, 1), True) if old in text else (text, False)

def api_block():
    return r'''
    # NEXA_PERSISTENT_API_V1_BEGIN
    from fastapi import Request as _NexaRequest
    from fastapi.responses import JSONResponse as _NexaJSONResponse
    from PIL import Image as _NexaImage
    import threading as _nexa_threading
    import traceback as _nexa_traceback
    _nexa_jobs = {}
    _nexa_jobs_lock = _nexa_threading.Lock()
    _nexa_generation_lock = _nexa_threading.Lock()
    def _nexa_set(job_id, **updates):
        with _nexa_jobs_lock:
            item = dict(_nexa_jobs.get(job_id, {})); item.update(updates); item['updated_at'] = time.time(); _nexa_jobs[job_id] = item; return dict(item)
    def _nexa_get(job_id):
        with _nexa_jobs_lock: return dict(_nexa_jobs.get(job_id, {}))
    def _nexa_open_rgba(file_path):
        with _NexaImage.open(file_path) as im: return im.convert('RGBA').copy()
    def _nexa_elapsed_ticker(job_id, stop_event, progress_value, stage, started):
        while not stop_event.wait(15):
            elapsed = int(time.time() - started); _nexa_set(job_id, progress=progress_value, stage=stage, message=f'{stage} · {elapsed}s elapsed · engine is still active')
    def _nexa_run_job(job_id, payload):
        with _nexa_generation_lock:
            try:
                output_dir = os.path.abspath(str(payload.get('output_dir') or ''))
                if not output_dir: raise ValueError('output_dir is required')
                os.makedirs(output_dir, exist_ok=True)
                source_paths = {k: str(payload.get(k) or '') for k in ('front','back','left','right')}
                if not source_paths['front'] or not os.path.exists(source_paths['front']): raise FileNotFoundError('Front reference is missing')
                raw = {key:_nexa_open_rgba(source_paths[key]) for key in ('front','back','left','right') if source_paths[key] and os.path.exists(source_paths[key])}
                _nexa_set(job_id,status='processing',progress=24,stage='Preparing exact 8082 references',message='Original RGBA references loaded: '+' + '.join(k.upper() for k in ('front','back','left','right') if k in raw))
                shape_started=time.time(); shape_stop=_nexa_threading.Event(); _nexa_threading.Thread(target=_nexa_elapsed_ticker,args=(job_id,shape_stop,32,'Hunyuan3D-2mv shape generation',shape_started),daemon=True).start()
                _nexa_set(job_id,progress=30,stage='Hunyuan3D-2mv shape generation',message='Exact 8082 preset · Remove Background ON · Randomize Seed ON · 30 steps · CFG 5.0 · Octree 256 · Chunks 8000')
                try:
                    mesh,_main_image,_save_folder,stats,seed=_gen_shape(caption=None,image=None,mv_image_front=raw.get('front'),mv_image_back=raw.get('back'),mv_image_left=raw.get('left'),mv_image_right=raw.get('right'),steps=30,guidance_scale=5.0,seed=1234,octree_resolution=256,check_box_rembg=True,num_chunks=8000,randomize_seed=True)
                finally: shape_stop.set()
                white_path=os.path.join(output_dir,'white_mesh.glb'); mesh.export(white_path,include_normals=False); raw_faces=int(mesh.faces.shape[0])
                _nexa_set(job_id,progress=56,stage='8082 shape complete',message=f'Raw white_mesh.glb saved · {raw_faces} faces · seed {seed}')
                if not HAS_TEXTUREGEN: raise RuntimeError('Hunyuan Paint did not load at 8082 startup.')
                paint_mesh=trimesh.load(white_path,force='mesh'); faces_before=int(paint_mesh.faces.shape[0])
                if faces_before>100000:
                    _nexa_set(job_id,progress=61,stage='Preparing texture mesh',message=f'Windows texture guard: reducing Paint copy from {faces_before} to 80000 faces; raw white mesh is preserved.')
                    paint_mesh=face_reduce_worker(paint_mesh,max_facenum=80000)
                else: _nexa_set(job_id,progress=61,stage='Preparing texture mesh',message=f'Paint mesh has {faces_before} faces; no reduction required.')
                paint_images=[raw[k] for k in ('front','left','back','right') if k in raw]
                _nexa_set(job_id,progress=68,stage='Hunyuan Paint ready',message='Original RGBA order: '+' → '.join(k.upper() for k in ('front','left','back','right') if k in raw))
                paint_started=time.time(); paint_stop=_nexa_threading.Event(); _nexa_threading.Thread(target=_nexa_elapsed_ticker,args=(job_id,paint_stop,74,'Hunyuan Paint Multi-View',paint_started),daemon=True).start()
                _nexa_set(job_id,progress=72,stage='Hunyuan Paint Multi-View',message='Persistent Paint Turbo is processing the texture; models are not being reloaded for this job.')
                try: textured_mesh=texgen_worker(paint_mesh,paint_images)
                finally: paint_stop.set()
                final_path=os.path.join(output_dir,'final.glb'); _nexa_set(job_id,progress=94,stage='Exporting final GLB',message=f'Paint finished in {time.time()-paint_started:.1f}s · exporting final.glb')
                textured_mesh.export(final_path); torch.cuda.empty_cache()
                _nexa_set(job_id,status='completed',progress=100,stage='Completed',message='Persistent 8082 generation completed.',result_path=final_path,white_mesh_path=white_path,seed=int(seed),stats=stats)
            except Exception as exc:
                _nexa_traceback.print_exc(); _nexa_set(job_id,status='failed',progress=max(1,int(_nexa_get(job_id).get('progress',1))),stage='Hunyuan generation failed',error=str(exc),message=str(exc))
    @app.get('/nexa/health')
    async def nexa_health():
        active=any(v.get('status')=='processing' for v in list(_nexa_jobs.values()))
        return _NexaJSONResponse({'ok':True,'service':'nexa-hunyuan-persistent-v1','model':f'{args.model_path}/{args.subfolder}','texture_ready':bool(HAS_TEXTUREGEN),'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU','busy':active,'preset':{'steps':30,'guidance_scale':5.0,'octree_resolution':256,'num_chunks':8000,'remove_background':True,'randomize_seed':True}})
    @app.post('/nexa/generate')
    async def nexa_generate(request:_NexaRequest):
        payload=await request.json(); job_id=str(uuid.uuid4()); _nexa_set(job_id,status='queued',progress=20,stage='Accepted by persistent Hunyuan 8082',message='Job accepted without reloading Shape/Paint models.'); _nexa_threading.Thread(target=_nexa_run_job,args=(job_id,payload),daemon=True).start(); return _NexaJSONResponse({'ok':True,'job_id':job_id})
    @app.get('/nexa/status/{job_id}')
    async def nexa_status(job_id:str):
        item=_nexa_get(job_id)
        if not item: return _NexaJSONResponse({'ok':False,'error':'Unknown local Hunyuan job'},status_code=404)
        return _NexaJSONResponse({'ok':True,**item})
    # NEXA_PERSISTENT_API_V1_END
'''

def patch_gradio(root: Path):
    path=root/'gradio_app.py'
    if not path.exists(): raise FileNotFoundError(f'gradio_app.py not found: {path}')
    backup_once(path,'.before_nexa_persistent_190.bak'); text=path.read_text(encoding='utf-8'); text,turbo_changed=patch_paint_turbo(text)
    if turbo_changed: print('PAINT_TURBO_PRELOAD_PATCH_OK')
    if MARKER_BEGIN in text and MARKER_END in text: path.write_text(text,encoding='utf-8'); print('PERSISTENT_API_ALREADY_PRESENT'); return
    marker='    app = FastAPI()\n'
    if marker not in text: marker='    app = FastAPI()\r\n'
    if marker not in text: raise RuntimeError('Could not locate the FastAPI app creation in gradio_app.py. No API patch was written.')
    newline='\r\n' if '\r\n' in text else '\n'; text=text.replace(marker,marker+api_block().replace('\n',newline),1); path.write_text(text,encoding='utf-8'); print('PERSISTENT_API_PATCH_OK')

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--root',required=True); args=parser.parse_args(); root=Path(args.root).resolve(); patch_low_vram(root); patch_windows_inpaint(root); patch_gradio(root); print('NEXA_HUNYUAN_190_PATCH_COMPLETE')
if __name__=='__main__': main()
