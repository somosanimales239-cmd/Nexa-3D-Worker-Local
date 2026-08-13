from pathlib import Path
import json
import shutil
import sys

ROOT = Path.cwd()
PAYLOAD = ROOT / 'payload'
BACKUP = ROOT / '_backup_before_hunyuan_multiview_1_8_0'

required = [
    ROOT / 'src/backend/nexa-worker.js',
    ROOT / 'src/backend/config-store.js',
    ROOT / 'src/backend/engine-manager.js',
    ROOT / 'src/index.html',
    ROOT / 'src/app.js',
    ROOT / 'package.json',
]
missing = [str(p) for p in required if not p.exists()]
if missing:
    raise SystemExit('Run this update from the Nexa-3D-Worker-Local repository root. Missing:\n' + '\n'.join(missing))

BACKUP.mkdir(exist_ok=True)
for p in required + [ROOT/'VERSION.txt']:
    if p.exists():
        rel = p.relative_to(ROOT)
        dst = BACKUP / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists(): shutil.copy2(p, dst)

# Copy new runtime files.
for rel in [Path('src/backend/hunyuan-multiview-runner.js'), Path('scripts/hunyuan_multiview_worker.py')]:
    src = PAYLOAD / rel
    dst = ROOT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def patch(path, old, new, label, optional=False):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if new in text:
        print(f'OK already patched: {label}')
        return
    if old not in text:
        if optional:
            print(f'SKIP: {label}')
            return
        raise RuntimeError(f'Could not find patch marker: {label} in {path}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')
    print(f'PATCHED: {label}')

# config-store.js
patch('src/backend/config-store.js',
"    const sf3dRoot = path.join(this.engineRoot, 'stable-fast-3d');",
"    const sf3dRoot = path.join(this.engineRoot, 'stable-fast-3d');\n    const hunyuanRoot = String(process.env.NEXA_HUNYUAN_ROOT || 'D:\\\\N3D\\\\hunyuan2mv');",
'local Hunyuan root default')
patch('src/backend/config-store.js',
"      hunyuan3d_api_url: 'http://127.0.0.1:8080',",
"      hunyuan3d_api_url: 'http://127.0.0.1:8080',\n      hunyuan3d_local_root: hunyuanRoot,\n      hunyuan3d_local_python: path.join(hunyuanRoot, '.venv', 'Scripts', 'python.exe'),\n      hunyuan3d_cache_dir: String(process.env.HF_HOME || 'D:\\\\N3D\\\\HunyuanCache'),\n      hunyuan3d_temp_dir: String(process.env.TEMP || 'D:\\\\N3D\\\\temp'),",
'local Hunyuan paths')
patch('src/backend/config-store.js',
"      'stable_fast_3d_repo', 'stable_fast_3d_python', 'hf_cache_dir', 'hunyuan3d_api_url', 'blender_path', 'quick_texture_enabled'",
"      'stable_fast_3d_repo', 'stable_fast_3d_python', 'hf_cache_dir', 'hunyuan3d_api_url',\n      'hunyuan3d_local_root', 'hunyuan3d_local_python', 'hunyuan3d_cache_dir', 'hunyuan3d_temp_dir',\n      'blender_path', 'quick_texture_enabled'",
'persist local Hunyuan settings')
patch('src/backend/config-store.js',
"    next.provider = ['stable_fast_3d', 'hunyuan3d_api'].includes(next.provider) ? next.provider : 'stable_fast_3d';",
"    next.provider = ['stable_fast_3d', 'hunyuan3d_api', 'hunyuan3d_multiview_local'].includes(next.provider) ? next.provider : 'stable_fast_3d';",
'new provider key')
patch('src/backend/config-store.js',
"    next.hf_cache_dir = String(next.hf_cache_dir || '').trim();",
"    next.hf_cache_dir = String(next.hf_cache_dir || '').trim();\n    next.hunyuan3d_local_root = String(next.hunyuan3d_local_root || '').trim();\n    next.hunyuan3d_local_python = String(next.hunyuan3d_local_python || '').trim();\n    next.hunyuan3d_cache_dir = String(next.hunyuan3d_cache_dir || '').trim();\n    next.hunyuan3d_temp_dir = String(next.hunyuan3d_temp_dir || '').trim();",
'normalize Hunyuan paths')

# engine-manager.js
probe_old = """    let hunyuan = { url: cfg.hunyuan3d_api_url, reachable: false, detail: 'Not tested' };
    try { hunyuan = await this.testHunyuan(); } catch (error) { hunyuan.detail = error.message; }
    return { system, stable_fast_3d: sf3d, hunyuan3d_api: hunyuan };"""
probe_new = """    let hunyuan = { url: cfg.hunyuan3d_api_url, reachable: false, detail: 'Not tested' };
    try { hunyuan = await this.testHunyuan(); } catch (error) { hunyuan.detail = error.message; }
    const localRoot = path.resolve(String(cfg.hunyuan3d_local_root || ''));
    const localPython = path.resolve(String(cfg.hunyuan3d_local_python || ''));
    const hunyuanLocal = {
      root: localRoot,
      python: localPython,
      repo_ready: fs.existsSync(path.join(localRoot, 'gradio_app.py')) && fs.existsSync(path.join(localRoot, 'hy3dgen')),
      venv_ready: fs.existsSync(localPython),
      ready: false,
      detail: 'Not checked'
    };
    if (hunyuanLocal.repo_ready && hunyuanLocal.venv_ready) {
      try {
        const verify = await this.runCapture(localPython, ['-c', 'import torch; import custom_rasterizer; import mesh_processor; from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline; from hy3dgen.texgen import Hunyuan3DPaintPipeline; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU")'], { cwd: localRoot });
        const lines = splitLines(verify).filter(Boolean);
        hunyuanLocal.ready = lines.includes('True');
        hunyuanLocal.detail = hunyuanLocal.ready ? `CUDA ready · ${lines.at(-1) || ''}` : `Python ready · CUDA unavailable`;
      } catch (error) { hunyuanLocal.detail = error.message; }
    } else {
      hunyuanLocal.detail = !hunyuanLocal.repo_ready ? 'Hunyuan3D-2mv folder not found' : 'Hunyuan Python environment not found';
    }
    return { system, stable_fast_3d: sf3d, hunyuan3d_api: hunyuan, hunyuan3d_multiview_local: hunyuanLocal };"""
patch('src/backend/engine-manager.js', probe_old, probe_new, 'probe native Hunyuan multi-view')

# nexa-worker.js
patch('src/backend/nexa-worker.js',
"const { bakeMultiViewTexture } = require('./multi-view-texture');",
"const { bakeMultiViewTexture } = require('./multi-view-texture');\nconst { runHunyuanMultiview } = require('./hunyuan-multiview-runner');",
'import Hunyuan runner')
patch('src/backend/nexa-worker.js', "const VERSION = '1.7.1';", "const VERSION = '1.8.0';", 'worker version')
old_gen = """  async generateWithProvider(image, outputDir, payload, progressCb) {
    return this.store.get().provider === 'hunyuan3d_api'
      ? this.generateHunyuan(image, outputDir, payload, progressCb)
      : this.generateStableFast3D(image, outputDir, payload, progressCb);
  }"""
new_gen = """  async generateWithProvider(image, outputDir, payload, progressCb) {
    const cfg = this.store.get();
    if (cfg.provider === 'hunyuan3d_multiview_local') {
      return runHunyuanMultiview({
        cfg,
        views: [{ name: 'front', file: image }],
        outputDir,
        payload,
        progressCb,
        onLog: (line) => this.log(`[Hunyuan MV] ${line}`),
        onChild: (child) => { this.currentChild = child; }
      });
    }
    return cfg.provider === 'hunyuan3d_api'
      ? this.generateHunyuan(image, outputDir, payload, progressCb)
      : this.generateStableFast3D(image, outputDir, payload, progressCb);
  }"""
patch('src/backend/nexa-worker.js', old_gen, new_gen, 'route single-view Hunyuan local')
insert_marker = """      const refineMode = String(refine.refine_mode || (refineEnabled ? 'professional_refine' : 'standard_multiview'));

      // IMPORTANT QUALITY RULE:"""
insert_new = """      const refineMode = String(refine.refine_mode || (refineEnabled ? 'professional_refine' : 'standard_multiview'));

      if (cfg.provider === 'hunyuan3d_multiview_local') {
        await this.progress(job, 14, 'Native Hunyuan multi-view pipeline', 'Front / Back / Left / Right are being sent directly to Hunyuan3D-2mv. Blender texture projection is bypassed.');
        const finalGlb = await runHunyuanMultiview({
          cfg,
          views: viewImages.map(view => ({ name: view.name, file: view.image })),
          outputDir: path.join(jobDir, 'hunyuan-multiview'),
          payload,
          progressCb: (v, s, m) => this.progress(job, v, s, m),
          onLog: (line) => this.log(`[Hunyuan MV] ${line}`),
          onChild: (child) => { this.currentChild = child; }
        });
        const validated = await validateGlb(finalGlb);
        await this.progress(job, 97, 'Validating final Hunyuan GLB', `SHA-256 ${validated.sha256.slice(0, 12)}…`);
        const result = await this.uploadResult(job, finalGlb, validated.sha256);
        this.processed += 1;
        this.log(`Hunyuan multi-view job ${job.uuid} completed. Nexa asset ${result.asset_id || ''}.`);
        this.callbacks.onJob?.({ uuid: job.uuid, progress: 100, stage: 'Completed', result });
        return;
      }

      // IMPORTANT QUALITY RULE:"""
patch('src/backend/nexa-worker.js', insert_marker, insert_new, 'native Hunyuan multi-view job path')

# index.html
patch('src/index.html',
'<option value="stable_fast_3d">Stable Fast 3D — Local</option><option value="hunyuan3d_api">Hunyuan3D — Local API</option>',
'<option value="hunyuan3d_multiview_local">Hunyuan3D Multi-View Local — Recommended</option><option value="stable_fast_3d">Stable Fast 3D — Local</option><option value="hunyuan3d_api">Hunyuan3D — Local API (legacy)</option>',
'provider selector')
patch('src/index.html', 'v1.3.0 · Quick Texture · No OpenAI', 'v1.8.0 · Hunyuan MV Paint · No OpenAI', 'sidebar version', optional=True)
api_card_marker = '''          <article class="card engine-card">
            <div class="engine-title"><div class="engine-logo alt">HY</div><div><span class="pill neutral">OPTIONAL</span><h3>Hunyuan3D Local API</h3>'''
local_card = '''          <article class="card engine-card">
            <div class="engine-title"><div class="engine-logo alt">MV</div><div><span class="pill good">RECOMMENDED</span><h3>Hunyuan3D Multi-View Local</h3><p>Native Front / Back / Left / Right shape + Hunyuan Paint. Uses the existing Hunyuan installation directly; 127.0.0.1:8082 is not required.</p></div></div>
            <div class="engine-status" id="hunyuanLocalStatus">Not checked</div>
            <label>Hunyuan folder<input id="hunyuanLocalRoot" placeholder="D:\\N3D\\hunyuan2mv"></label>
            <label>Hunyuan Python<input id="hunyuanLocalPython" placeholder="D:\\N3D\\hunyuan2mv\\.venv\\Scripts\\python.exe"></label>
            <label>Hunyuan cache folder<input id="hunyuanCacheDir" placeholder="D:\\N3D\\HunyuanCache"></label>
            <label>Heavy temp folder<input id="hunyuanTempDir" placeholder="D:\\N3D\\temp"></label>
            <div class="license-note">The Worker runs shape and Paint sequentially, releases the shape model before Paint, enables CPU offload, and keeps the original textured GLB before optional polish.</div>
          </article>

'''
patch('src/index.html', api_card_marker, local_card + api_card_marker, 'Hunyuan local engine card')

# app.js
patch('src/app.js',
"$('sf3dRepo').value=cfg.stable_fast_3d_repo||''; $('sf3dPython').value=cfg.stable_fast_3d_python||''; $('hfCacheDir').value=cfg.hf_cache_dir||''; $('hfToken').value=cfg.has_hf_token?'••••••••••••••••':''; $('hunyuanUrl').value=cfg.hunyuan3d_api_url||''; $('blenderPath').value=cfg.blender_path||''; $('quickTextureEnabled').checked=cfg.quick_texture_enabled!==false;",
"$('sf3dRepo').value=cfg.stable_fast_3d_repo||''; $('sf3dPython').value=cfg.stable_fast_3d_python||''; $('hfCacheDir').value=cfg.hf_cache_dir||''; $('hfToken').value=cfg.has_hf_token?'••••••••••••••••':''; $('hunyuanUrl').value=cfg.hunyuan3d_api_url||''; $('hunyuanLocalRoot').value=cfg.hunyuan3d_local_root||''; $('hunyuanLocalPython').value=cfg.hunyuan3d_local_python||''; $('hunyuanCacheDir').value=cfg.hunyuan3d_cache_dir||''; $('hunyuanTempDir').value=cfg.hunyuan3d_temp_dir||''; $('blenderPath').value=cfg.blender_path||''; $('quickTextureEnabled').checked=cfg.quick_texture_enabled!==false;",
'load Hunyuan local config')
patch('src/app.js',
"$('metricEngine').textContent=cfg.provider==='hunyuan3d_api'?'Hunyuan3D API':'Stable Fast 3D';",
"$('metricEngine').textContent=cfg.provider==='hunyuan3d_multiview_local'?'Hunyuan MV Local':cfg.provider==='hunyuan3d_api'?'Hunyuan3D API':'Stable Fast 3D';",
'engine label')
old_payload = "function connectionPayload(){return {nexa_api_base:$('nexaApiBase').value.trim(),worker_token:$('workerToken').value.trim(),worker_id:$('workerId').value.trim(),provider:$('provider').value,stable_fast_3d_repo:$('sf3dRepo').value.trim(),stable_fast_3d_python:$('sf3dPython').value.trim(),hf_cache_dir:$('hfCacheDir').value.trim(),hf_token:$('hfToken').value.trim(),hunyuan3d_api_url:$('hunyuanUrl').value.trim(),blender_path:$('blenderPath').value.trim(),quick_texture_enabled:$('quickTextureEnabled').checked,force_cpu:$('forceCpu').checked}}"
new_payload = "function connectionPayload(){return {nexa_api_base:$('nexaApiBase').value.trim(),worker_token:$('workerToken').value.trim(),worker_id:$('workerId').value.trim(),provider:$('provider').value,stable_fast_3d_repo:$('sf3dRepo').value.trim(),stable_fast_3d_python:$('sf3dPython').value.trim(),hf_cache_dir:$('hfCacheDir').value.trim(),hf_token:$('hfToken').value.trim(),hunyuan3d_api_url:$('hunyuanUrl').value.trim(),hunyuan3d_local_root:$('hunyuanLocalRoot').value.trim(),hunyuan3d_local_python:$('hunyuanLocalPython').value.trim(),hunyuan3d_cache_dir:$('hunyuanCacheDir').value.trim(),hunyuan3d_temp_dir:$('hunyuanTempDir').value.trim(),blender_path:$('blenderPath').value.trim(),quick_texture_enabled:$('quickTextureEnabled').checked,force_cpu:$('forceCpu').checked}}"
patch('src/app.js', old_payload, new_payload, 'save Hunyuan local config')
patch('src/app.js',
"    const sf=r.stable_fast_3d;const hy=r.hunyuan3d_api;",
"    const sf=r.stable_fast_3d;const hy=r.hunyuan3d_api;const hyl=r.hunyuan3d_multiview_local||{};",
'probe Hunyuan local result')
patch('src/app.js',
"    $('metricEngineReady').textContent=state.config.provider==='stable_fast_3d'?$('sf3dStatus').textContent:(hy.reachable?'Local API ready':'Local API offline');",
"    $('metricEngineReady').textContent=state.config.provider==='hunyuan3d_multiview_local'?(hyl.ready?'Native multi-view ready':(hyl.detail||'Hunyuan local not ready')):state.config.provider==='stable_fast_3d'?$('sf3dStatus').textContent:(hy.reachable?'Local API ready':'Local API offline');\n    $('hunyuanLocalStatus').textContent=hyl.ready?`Ready · ${hyl.detail||''}`:`Not ready · ${hyl.detail||'Check local paths'}`;$('hunyuanLocalStatus').classList.toggle('ready',Boolean(hyl.ready));",
'local Hunyuan readiness UI')

# package.json + version
pkg_path = ROOT / 'package.json'
pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
pkg['version'] = '1.8.0'
pkg['description'] = 'Nexa 3D Worker Local 1.8.0 with native Hunyuan3D-2mv geometry, Hunyuan Paint multi-reference texture, Face Priority Polish and conservative texture polish.'
files = pkg.setdefault('build', {}).setdefault('files', [])
if 'scripts/**/*' not in files: files.append('scripts/**/*')
unpack = pkg['build'].setdefault('asarUnpack', [])
if 'scripts/**/*' not in unpack: unpack.append('scripts/**/*')
validate = pkg.get('scripts', {}).get('validate', '')
if 'hunyuan-multiview-runner.js' not in validate:
    validate = validate.replace('node --check src/backend/nexa-worker.js', 'node --check src/backend/nexa-worker.js && node --check src/backend/hunyuan-multiview-runner.js')
    pkg['scripts']['validate'] = validate
pkg_path.write_text(json.dumps(pkg, indent=2) + '\n', encoding='utf-8')
(ROOT/'VERSION.txt').write_text('1.8.0\n', encoding='utf-8')

print('\nNEXA WORKER UPDATE 1.8.0 APPLIED')
print('Backup:', BACKUP)
print('Next: npm run validate')
