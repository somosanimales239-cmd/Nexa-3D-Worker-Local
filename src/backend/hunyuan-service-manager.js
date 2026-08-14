'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
function fileExists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function dirExists(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function packagedPatchScriptPath() {
  let script = path.join(__dirname, '..', '..', 'scripts', 'patch_hunyuan_gradio_api.py');
  if (script.includes('app.asar')) script = script.replace('app.asar', 'app.asar.unpacked');
  return script;
}
class HunyuanServiceManager {
  constructor(store, onLog = () => {}) { this.store = store; this.onLog = onLog; this.child = null; this.readyPromise = null; this.lastHealth = null; }
  log(message) { this.onLog(String(message)); }
  config() { return this.store.get(); }
  baseUrl() { return String(this.config().hunyuan3d_service_url || 'http://127.0.0.1:8082').replace(/\/+$/, ''); }
  async fetchJson(url, options = {}, timeoutMs = 3500) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text(); let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) throw new Error(data.error || data.detail || `HTTP ${response.status}`);
      return data;
    } finally { clearTimeout(timer); }
  }
  async health() {
    try {
      const data = await this.fetchJson(`${this.baseUrl()}/nexa/health`, {}, 2500);
      if (data?.ok && data?.service === 'nexa-hunyuan-persistent-v1') { this.lastHealth = data; return data; }
    } catch {}
    return null;
  }
  async rootResponds() {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1800);
    try { return Boolean(await fetch(`${this.baseUrl()}/`, { signal: controller.signal, redirect: 'manual' })); }
    catch { return false; }
    finally { clearTimeout(timer); }
  }
  patchLocalInstallation() {
    const cfg = this.config(); const root = path.resolve(String(cfg.hunyuan3d_local_root || '')); const python = path.resolve(String(cfg.hunyuan3d_local_python || '')); const script = packagedPatchScriptPath();
    if (!dirExists(root) || !fileExists(path.join(root, 'gradio_app.py'))) throw new Error(`Hunyuan folder is not ready: ${root}`);
    if (!fileExists(python)) throw new Error(`Hunyuan Python was not found: ${python}`);
    if (!fileExists(script)) throw new Error(`Nexa Hunyuan patch script is missing: ${script}`);
    this.log('Checking persistent 8082 API patch and Windows texture-speed guard...');
    const env = { ...process.env, HF_HOME: String(cfg.hunyuan3d_cache_dir || process.env.HF_HOME || ''), TEMP: String(cfg.hunyuan3d_temp_dir || process.env.TEMP || ''), TMP: String(cfg.hunyuan3d_temp_dir || process.env.TMP || '') };
    const result = spawnSync(python, [script, '--root', root], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    for (const line of output.split(/\r?\n/)) if (line.trim()) this.log(`[8082 patch] ${line.trim()}`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Could not prepare Hunyuan 8082 API. ${output.slice(-1200)}`);
  }
  stopLegacyGradio8082() {
    if (process.platform !== 'win32') return 0;
    const root = path.resolve(String(this.config().hunyuan3d_local_root || '')).replace(/'/g, "''");
    const ps = [`$root='${root}'`, "$items=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*gradio_app.py*' -and $_.CommandLine -match '--port\\s+8082' -and $_.CommandLine -like ('*'+$root+'*') }", '$count=0', 'foreach($p in $items){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $count++ } catch {} }', 'Write-Output $count'].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const count = Number(String(result.stdout || '').trim().split(/\r?\n/).pop()) || 0;
    if (count > 0) this.log(`Restarting ${count} older Hunyuan 8082 process so it can use the persistent Nexa API.`);
    return count;
  }
  launchService() {
    const cfg = this.config(); const root = path.resolve(String(cfg.hunyuan3d_local_root || '')); const python = path.resolve(String(cfg.hunyuan3d_local_python || ''));
    const cache = path.resolve(String(cfg.hunyuan3d_cache_dir || 'D:\\N3D\\HunyuanCache')); const temp = path.resolve(String(cfg.hunyuan3d_temp_dir || 'D:\\N3D\\temp')); const gradioCache = path.join(root, 'gradio_cache');
    fs.mkdirSync(temp, { recursive: true }); fs.mkdirSync(gradioCache, { recursive: true });
    const args = ['gradio_app.py','--model_path','tencent/Hunyuan3D-2mv','--subfolder','hunyuan3d-dit-v2-mv','--texgen_model_path','tencent/Hunyuan3D-2','--device','cuda','--low_vram_mode','--host','127.0.0.1','--port','8082','--cache-path',gradioCache];
    const env = { ...process.env, HF_HOME: cache, HF_HUB_CACHE: path.join(cache,'hub'), HUGGINGFACE_HUB_CACHE: path.join(cache,'hub'), TRANSFORMERS_CACHE: path.join(cache,'transformers'), TORCH_HOME: path.join(cache,'torch'), TEMP: temp, TMP: temp, PYTORCH_CUDA_ALLOC_CONF: process.env.PYTORCH_CUDA_ALLOC_CONF || 'expandable_segments:True' };
    this.log('Launching persistent Hunyuan3D-2mv + Paint service on 127.0.0.1:8082...');
    const child = spawn(python, args, { cwd: root, env, windowsHide: true, shell: false }); this.child = child;
    const capture = (chunk) => { for (const line of String(chunk || '').replaceAll('\r','').split('\n')) { const text = line.trim(); if (text) this.log(`[Hunyuan 8082] ${text}`); } };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture); child.on('error', (error) => this.log(`Hunyuan 8082 process error: ${error.message}`));
    child.on('close', (code) => { if (this.child === child) this.child = null; this.log(`Hunyuan 8082 process exited with code ${code}.`); });
  }
  async ensureReady(progressCb = async () => {}) {
    const existing = await this.health(); if (existing) return existing;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this._ensureReady(progressCb).finally(() => { this.readyPromise = null; }); return this.readyPromise;
  }
  async _ensureReady(progressCb) {
    this.patchLocalInstallation(); let health = await this.health(); if (health) return health;
    if (await this.rootResponds()) { const stopped = this.stopLegacyGradio8082(); if (stopped > 0) for (let i=0; i<20 && await this.rootResponds(); i+=1) await sleep(250); }
    if (await this.rootResponds()) throw new Error('Port 8082 is already in use by a process that is not the Nexa Hunyuan persistent service. Close that process and start the Worker again.');
    this.launchService(); const started = Date.now(); let lastSignal = 0;
    while (Date.now() - started < 20*60*1000) {
      health = await this.health();
      if (health) { this.log(`Persistent Hunyuan 8082 is ready · ${health.gpu || 'CUDA'} · Shape and Paint loaded once.`); await progressCb(18,'Hunyuan 8082 ready','Persistent Shape + Paint engine loaded and ready.'); return health; }
      const elapsed = Math.round((Date.now()-started)/1000);
      if (elapsed-lastSignal >= 10) { lastSignal = elapsed; await progressCb(Math.min(17,12+Math.floor(elapsed/60)),'Warming persistent Hunyuan 8082',`Loading Shape + Paint once · ${elapsed}s elapsed.`); }
      if (this.child && this.child.exitCode !== null) throw new Error(`Hunyuan 8082 exited during startup with code ${this.child.exitCode}.`);
      await sleep(2000);
    }
    throw new Error('Hunyuan 8082 did not become ready within 20 minutes. Startup was stopped instead of leaving Nexa hanging indefinitely.');
  }
  async generate({ views, outputDir, progressCb = async () => {} }) {
    await this.ensureReady(progressCb);
    const byName = new Map((Array.isArray(views)?views:[]).map(v => [String(v.name||'').toLowerCase(), v.file])); const front = byName.get('front');
    if (!front || !fileExists(front)) throw new Error('Front reference is missing.');
    const payload = { front, output_dir: outputDir }; for (const name of ['back','left','right']) { const file = byName.get(name); if (file && fileExists(file)) payload[name] = file; }
    const accepted = await this.fetchJson(`${this.baseUrl()}/nexa/generate`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) }, 10000);
    if (!accepted?.job_id) throw new Error('Hunyuan 8082 did not return a local job id.');
    const localJobId = String(accepted.job_id); const started = Date.now(); let lastSignature = '';
    while (Date.now()-started < 30*60*1000) {
      const status = await this.fetchJson(`${this.baseUrl()}/nexa/status/${encodeURIComponent(localJobId)}`, {}, 5000);
      const signature = `${status.progress}|${status.stage}|${status.message}`;
      if (signature !== lastSignature) { lastSignature = signature; await progressCb(Number(status.progress)||18, status.stage||'Hunyuan 8082', status.message||'Processing locally.'); }
      if (status.status === 'completed') { if (!status.result_path || !fileExists(status.result_path)) throw new Error('Hunyuan reported completion but final.glb was not found.'); return status.result_path; }
      if (status.status === 'failed') throw new Error(status.error || 'Persistent Hunyuan generation failed.');
      await sleep(2000);
    }
    await this.stop(); throw new Error('Hunyuan generation exceeded the 30-minute watchdog. The local engine was stopped instead of remaining stuck for an hour.');
  }
  async stop() {
    const child = this.child; this.child = null; if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15000}); else { try { child.kill('SIGTERM'); } catch {} }
  }
}
module.exports = { HunyuanServiceManager };
