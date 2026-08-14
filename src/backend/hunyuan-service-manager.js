'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function fileExists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function dirExists(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function unpackedScript(name) {
  let script = path.join(__dirname, '..', '..', 'scripts', name);
  if (script.includes('app.asar')) script = script.replace('app.asar', 'app.asar.unpacked');
  return script;
}

class HunyuanServiceManager {
  constructor(store, onLog = () => {}) {
    this.store = store;
    this.onLog = onLog;
    this.child = null;
    this.readyPromise = null;
    this.lastExit = null;
    this.logTail = [];
  }

  log(message) { this.onLog(String(message)); }
  config() { return this.store.get(); }
  baseUrl() { return String(this.config().hunyuan3d_service_url || 'http://127.0.0.1:8082').replace(/\/+$/, ''); }

  captureLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    this.logTail.push(text);
    this.logTail = this.logTail.slice(-80);
    this.log(`[Hunyuan 8082] ${text}`);
  }

  async fetchJson(url, options = {}, timeoutMs = 3500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) throw new Error(data.error || data.detail || `HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    try {
      const data = await this.fetchJson(`${this.baseUrl()}/nexa/health`, {}, 2500);
      return data?.ok && data?.service === 'nexa-hunyuan-shape-8082-v1' ? data : null;
    } catch {
      return null;
    }
  }

  async rootResponds() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    try {
      return Boolean(await fetch(`${this.baseUrl()}/`, { signal: controller.signal, redirect: 'manual' }));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  patchLocalInstallation() {
    const cfg = this.config();
    const root = path.resolve(String(cfg.hunyuan3d_local_root || ''));
    const python = path.resolve(String(cfg.hunyuan3d_local_python || ''));
    const script = unpackedScript('patch_hunyuan_shape_api.py');

    if (!dirExists(root) || !fileExists(path.join(root, 'gradio_app.py'))) {
      throw new Error(`Hunyuan folder is not ready: ${root}`);
    }
    if (!fileExists(python)) throw new Error(`Hunyuan Python was not found: ${python}`);
    if (!fileExists(script)) throw new Error(`Nexa Hunyuan shape API patch is missing: ${script}`);

    const result = spawnSync(python, [script, '--root', root], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      env: {
        ...process.env,
        HF_HOME: String(cfg.hunyuan3d_cache_dir || 'D:\\N3D\\HunyuanCache'),
        TEMP: String(cfg.hunyuan3d_temp_dir || 'D:\\N3D\\temp'),
        TMP: String(cfg.hunyuan3d_temp_dir || 'D:\\N3D\\temp')
      }
    });

    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    for (const line of output.split(/\r?\n/)) {
      if (line.trim()) this.log(`[8082 patch] ${line.trim()}`);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Could not prepare the 8082 Shape API. ${output.slice(-1400)}`);
  }

  stopMatchingGradio8082() {
    if (process.platform !== 'win32') return 0;
    const root = path.resolve(String(this.config().hunyuan3d_local_root || '')).replace(/'/g, "''");
    const ps = [
      `$root='${root}'`,
      "$items=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*gradio_app.py*' -and $_.CommandLine -match '--port\\s+8082' -and $_.CommandLine -like ('*'+$root+'*') }",
      '$count=0',
      'foreach($p in $items){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $count++ } catch {} }',
      'Write-Output $count'
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 15000
    });
    return Number(String(result.stdout || '').trim().split(/\r?\n/).pop()) || 0;
  }

  launchShapeService() {
    const cfg = this.config();
    const root = path.resolve(String(cfg.hunyuan3d_local_root || ''));
    const python = path.resolve(String(cfg.hunyuan3d_local_python || ''));
    const cache = path.resolve(String(cfg.hunyuan3d_cache_dir || 'D:\\N3D\\HunyuanCache'));
    const temp = path.resolve(String(cfg.hunyuan3d_temp_dir || 'D:\\N3D\\temp'));
    const gradioCache = path.join(root, 'gradio_cache');

    fs.mkdirSync(temp, { recursive: true });
    fs.mkdirSync(gradioCache, { recursive: true });

    const args = [
      'gradio_app.py',
      '--model_path', 'tencent/Hunyuan3D-2mv',
      '--subfolder', 'hunyuan3d-dit-v2-mv',
      '--device', 'cuda',
      '--disable_tex',
      '--host', '127.0.0.1',
      '--port', '8082',
      '--cache-path', gradioCache
    ];

    const env = {
      ...process.env,
      HF_HOME: cache,
      HF_HUB_CACHE: path.join(cache, 'hub'),
      HUGGINGFACE_HUB_CACHE: path.join(cache, 'hub'),
      TRANSFORMERS_CACHE: path.join(cache, 'transformers'),
      TORCH_HOME: path.join(cache, 'torch'),
      TEMP: temp,
      TMP: temp,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    };

    this.lastExit = null;
    this.logTail = [];
    this.log('Starting Hunyuan3D-2mv Shape on 127.0.0.1:8082 with Paint disabled during startup.');
    const child = spawn(python, args, { cwd: root, env, windowsHide: true, shell: false });
    this.child = child;

    const capture = (chunk) => {
      for (const line of String(chunk || '').replaceAll('\r', '').split('\n')) this.captureLine(line);
    };

    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', (error) => {
      this.lastExit = { code: -1, error: error.message, tail: [...this.logTail] };
      this.log(`Hunyuan 8082 process error: ${error.message}`);
    });
    child.on('close', (code) => {
      this.lastExit = { code, tail: [...this.logTail] };
      if (this.child === child) this.child = null;
      this.log(`Hunyuan 8082 exited with code ${code}.`);
    });
  }

  async ensureReady(progressCb = async () => {}) {
    const ready = await this.health();
    if (ready) return ready;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this._ensureReady(progressCb).finally(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  async _ensureReady(progressCb) {
    this.patchLocalInstallation();
    let health = await this.health();
    if (health) return health;

    if (await this.rootResponds()) {
      const stopped = this.stopMatchingGradio8082();
      if (stopped > 0) {
        this.log(`Restarted ${stopped} older Hunyuan 8082 process to activate the Shape API.`);
        for (let i = 0; i < 30 && await this.rootResponds(); i += 1) await sleep(250);
      }
    }

    if (await this.rootResponds()) {
      throw new Error('Port 8082 is occupied by another process. Close it and start the Worker again.');
    }

    this.launchShapeService();
    const started = Date.now();
    let lastSignal = -10;

    while (Date.now() - started < 10 * 60 * 1000) {
      if (this.lastExit) {
        const tail = (this.lastExit.tail || []).slice(-14).join(' | ');
        throw new Error(`Hunyuan 8082 exited during startup (code ${this.lastExit.code}). ${this.lastExit.error || ''} ${tail}`.trim());
      }

      health = await this.health();
      if (health) {
        await progressCb(18, 'Hunyuan 8082 Shape ready', `Shape engine loaded once · ${health.gpu || 'CUDA'}.`);
        return health;
      }

      const elapsed = Math.round((Date.now() - started) / 1000);
      if (elapsed - lastSignal >= 10) {
        lastSignal = elapsed;
        await progressCb(
          Math.min(17, 12 + Math.floor(elapsed / 60)),
          'Loading Hunyuan3D-2mv Shape',
          `${elapsed}s elapsed · waiting for the same 8082 Shape engine.`
        );
      }
      await sleep(1500);
    }

    throw new Error(`Hunyuan3D-2mv Shape did not become ready within 10 minutes. Last engine output: ${this.logTail.slice(-14).join(' | ')}`);
  }

  async generateShape({ views, outputDir, progressCb = async () => {} }) {
    await this.ensureReady(progressCb);
    const byName = new Map((Array.isArray(views) ? views : []).map(v => [String(v.name || '').toLowerCase(), v.file]));
    const front = byName.get('front');
    if (!front || !fileExists(front)) throw new Error('Front reference is missing.');

    const payload = { front, output_dir: outputDir };
    for (const name of ['back', 'left', 'right']) {
      const file = byName.get(name);
      if (file && fileExists(file)) payload[name] = file;
    }

    const accepted = await this.fetchJson(`${this.baseUrl()}/nexa/shape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 10000);

    if (!accepted?.job_id) throw new Error('Hunyuan 8082 did not return a Shape job id.');
    const id = String(accepted.job_id);
    const started = Date.now();

    while (Date.now() - started < 15 * 60 * 1000) {
      const status = await this.fetchJson(`${this.baseUrl()}/nexa/status/${encodeURIComponent(id)}`, {}, 5000);
      await progressCb(Number(status.progress) || 20, status.stage || 'Hunyuan Shape', status.message || 'Shape generation active.');

      if (status.status === 'completed') {
        if (!status.result_path || !fileExists(status.result_path)) throw new Error('8082 Shape completed but white_mesh.glb was not found.');
        return status.result_path;
      }
      if (status.status === 'failed') throw new Error(status.error || '8082 Shape generation failed.');
      await sleep(2500);
    }

    throw new Error('8082 Shape generation exceeded 15 minutes and was aborted by Nexa watchdog.');
  }


  async stopShapeBeforePaint(progressCb = async () => {}) {
    await progressCb(58, 'Releasing Hunyuan Shape GPU', 'Stopping 8082 Shape so Paint Turbo can load without competing for VRAM.');
    await this.stop();

    const started = Date.now();
    while (Date.now() - started < 30000) {
      if (!(await this.rootResponds())) {
        await sleep(2500);
        await progressCb(59, 'Shape engine released', '127.0.0.1:8082 is down. Starting proven Paint next.');
        return;
      }
      await sleep(1000);
    }

    throw new Error('8082 Shape process did not shut down cleanly before Paint.');
  }

  async runProvenPaint({ mesh, views, outputDir, qualityPlan = {}, progressCb = async () => {} }) {
    const cfg = this.config();
    const python = path.resolve(String(cfg.hunyuan3d_local_python || ''));
    const root = path.resolve(String(cfg.hunyuan3d_local_root || ''));
    const script = unpackedScript('hunyuan_paint_proven.py');
    if (!fileExists(script)) throw new Error(`Proven Paint bridge is missing: ${script}`);

    const byName = new Map((Array.isArray(views) ? views : []).map(v => [String(v.name || '').toLowerCase(), v.file]));
    const args = [
      script,
      '--root', root,
      '--mesh', mesh,
      '--output', path.join(outputDir, 'final.glb'),
      '--front', byName.get('front') || '',
      '--object-type', String(qualityPlan.objectType || 'auto'),
      '--texture-input-boost', String(qualityPlan.textureInputBoost || 'off')
    ];
    if (qualityPlan.safeTextureBoost) args.push('--smart-reference-preprocess');
    if (qualityPlan.facePriority) args.push('--front-face-priority');
    if (qualityPlan.finalTexturePolish) args.push('--final-texture-polish');
    for (const name of ['left', 'back', 'right']) {
      const file = byName.get(name);
      if (file) args.push(`--${name}`, file);
    }

    const cache = String(cfg.hunyuan3d_cache_dir || 'D:\\N3D\\HunyuanCache');
    const temp = String(cfg.hunyuan3d_temp_dir || 'D:\\N3D\\temp');
    const env = {
      ...process.env,
      HF_HOME: cache,
      HF_HUB_CACHE: path.join(cache, 'hub'),
      HUGGINGFACE_HUB_CACHE: path.join(cache, 'hub'),
      TRANSFORMERS_CACHE: path.join(cache, 'transformers'),
      TORCH_HOME: path.join(cache, 'torch'),
      TEMP: temp,
      TMP: temp,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    };

    const boostLabel = qualityPlan.textureInputBoost === 'safe_384' ? 'Safe 384 texture boost enabled.' : 'Safe texture boost disabled.';
    await progressCb(60, 'Starting proven Hunyuan Paint', `Using the same low-VRAM Paint Turbo sequence that already succeeded locally. ${boostLabel}`);

    return await new Promise((resolve, reject) => {
      const child = spawn(python, args, { cwd: root, env, windowsHide: true, shell: false });
      let tail = [];
      let resultPath = '';
      let paintStarted = false;

      const ticker = setInterval(() => {
        if (paintStarted) {
          progressCb(76, 'Hunyuan Paint Multi-View', 'Paint is still active - original RGBA Front -> Left -> Back -> Right.').catch(() => {});
        }
      }, 15000);

      const capture = (chunk) => {
        for (const raw of String(chunk || '').replaceAll('\r', '').split('\n')) {
          const line = raw.trim();
          if (!line) continue;
          tail.push(line);
          tail = tail.slice(-80);
          this.log(`[Proven Paint] ${line}`);

          if (line.startsWith('NEXA_PROGRESS|')) {
            const parts = line.split('|');
            const value = Number(parts[1]) || 60;
            const stage = parts[2] || 'Hunyuan Paint';
            const message = parts.slice(3).join('|') || stage;
            if (value >= 74) paintStarted = true;
            progressCb(value, stage, message).catch(() => {});
          } else if (line.startsWith('NEXA_RESULT|')) {
            resultPath = line.slice('NEXA_RESULT|'.length).trim();
          }
        }
      };

      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.on('error', (error) => {
        clearInterval(ticker);
        reject(error);
      });
      child.on('close', (code) => {
        clearInterval(ticker);
        if (code !== 0) {
          return reject(new Error(`Proven Hunyuan Paint exited with code ${code}. ${tail.slice(-18).join(' | ')}`));
        }
        const finalFile = resultPath || path.join(outputDir, 'final.glb');
        if (!fileExists(finalFile)) {
          return reject(new Error(`Paint completed but final.glb was not found. ${tail.slice(-12).join(' | ')}`));
        }
        resolve(finalFile);
      });
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }
  }
}

module.exports = { HunyuanServiceManager };
