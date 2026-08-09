'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VERSION = '1.0.2';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeName(value) {
  const input = String(value || 'model');
  let output = '';
  for (const char of input) {
    const code = char.charCodeAt(0);
    const alphaNum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const allowed = alphaNum || char === '.' || char === '_' || char === '-';
    if (allowed) output += char;
    else if (!output.endsWith('-')) output += '-';
  }
  while (output.startsWith('.') || output.startsWith('-')) output = output.slice(1);
  while (output.endsWith('-')) output = output.slice(0, -1);
  return output.slice(0, 80) || 'model';
}
function splitLines(value) { return String(value || '').replaceAll('\r', '').split('\n'); }
function trimTrailingSlashes(value) {
  let text = String(value || '');
  while (text.endsWith('/')) text = text.slice(0, -1);
  return text;
}
function isHttpUrl(value) {
  const text = String(value || '').toLowerCase();
  return text.startsWith('http://') || text.startsWith('https://');
}
function fileExists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function dirExists(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }

async function findGlbs(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.glb')) found.push(full);
    }
  }
  if (dirExists(root)) await walk(root);
  const stats = await Promise.all(found.map(async (file) => ({ file, stat: await fsp.stat(file) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats.map((x) => x.file);
}

async function validateGlb(file) {
  const buffer = await fsp.readFile(file);
  if (buffer.length < 20) throw new Error('Generated GLB is empty or too small.');
  if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('Generated file does not have a GLB glTF signature.');
  if (buffer.readUInt32LE(4) !== 2) throw new Error(`Generated GLB version ${buffer.readUInt32LE(4)} is unsupported.`);
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('Generated GLB declared length does not match its file size.');
  return { buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

class NexaWorker {
  constructor(store, engines, callbacks = {}) {
    this.store = store;
    this.engines = engines;
    this.callbacks = callbacks;
    this.running = false;
    this.busy = false;
    this.stopRequested = false;
    this.currentChild = null;
    this.currentAbortController = null;
    this.currentJob = null;
    this.processed = 0;
    this.lastError = '';
    this.lastHeartbeat = null;
    this.lastActivity = null;
  }

  reloadConfig() {}
  status() {
    return {
      running: this.running,
      busy: this.busy,
      current_job: this.currentJob ? { uuid: this.currentJob.uuid, asset_name: this.currentJob.asset_name } : null,
      processed: this.processed,
      last_error: this.lastError,
      last_heartbeat: this.lastHeartbeat,
      last_activity: this.lastActivity,
      provider: this.store.get().provider
    };
  }
  emitStatus() { this.callbacks.onStatus?.(this.status()); }
  log(message, level = 'info') {
    const line = `[${new Date().toLocaleTimeString()}] ${String(message)}`;
    this.lastActivity = new Date().toISOString();
    if (level === 'error') this.lastError = String(message);
    this.callbacks.onLog?.({ line, level, at: this.lastActivity });
    try {
      const logFile = path.join(this.store.paths().logs, 'worker.log');
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${String(message)}\n`, 'utf8');
    } catch {}
    this.emitStatus();
  }

  config() {
    const cfg = this.store.get();
    if (!isHttpUrl(cfg.nexa_api_base)) throw new Error('Nexa worker API base is not configured. Copy it from Nexa 3D Studio → Settings.');
    if (!cfg.worker_token) throw new Error('Worker token is missing. Copy it from Nexa 3D Studio → Settings.');
    cfg.nexa_api_base = trimTrailingSlashes(cfg.nexa_api_base) + '/';
    return cfg;
  }

  async requestJson(endpoint, payload, timeoutSeconds) {
    const cfg = this.config();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (timeoutSeconds || cfg.http_timeout_seconds) * 1000);
    try {
      const response = await fetch(cfg.nexa_api_base + endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.worker_token}`, 'Content-Type': 'application/json', 'User-Agent': `Nexa-3D-Worker-Local/${VERSION}` },
        body: JSON.stringify(payload || {}),
        signal: controller.signal
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Nexa returned HTTP ${response.status}: ${text.slice(0, 700)}`); }
      if (!response.ok || data.ok === false) throw new Error(data.error || `Nexa returned HTTP ${response.status}`);
      return data;
    } finally { clearTimeout(timer); }
  }

  async heartbeat() {
    const cfg = this.config();
    const data = await this.requestJson('worker-heartbeat.php', { worker_id: cfg.worker_id, provider: cfg.provider, version: VERSION });
    this.lastHeartbeat = new Date().toISOString();
    this.emitStatus();
    return data;
  }

  async testConnection() {
    try {
      await this.heartbeat();
      this.log('Connection to Nexa 3D Studio verified.');
      return { ok: true, message: 'Connected to Nexa 3D Studio.', status: this.status() };
    } catch (error) {
      this.log(`Connection test failed: ${error.message}`, 'error');
      return { ok: false, error: error.message, status: this.status() };
    }
  }

  async claim() {
    const cfg = this.config();
    const data = await this.requestJson('worker-next.php', { worker_id: cfg.worker_id, provider: cfg.provider, version: VERSION });
    return data.job || null;
  }

  async progress(job, progress, stage, message = '') {
    await this.requestJson('worker-progress.php', {
      job_uuid: job.uuid, claim_token: job.claim_token, progress, stage, message,
      worker_id: this.config().worker_id, version: VERSION
    });
    this.callbacks.onJob?.({ uuid: job.uuid, progress, stage, message, asset_name: job.asset_name });
  }

  async fail(job, error, stage = 'Generation failed') {
    try {
      await this.requestJson('worker-fail.php', { job_uuid: job.uuid, claim_token: job.claim_token, error: String(error).slice(0, 3000), stage });
    } catch (reportError) {
      this.log(`Could not report job failure to Nexa: ${reportError.message}`, 'error');
    }
  }

  async downloadImage(job, target) {
    const cfg = this.config();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.http_timeout_seconds * 1000);
    try {
      const response = await fetch(job.image_url, { headers: { 'Authorization': `Bearer ${cfg.worker_token}`, 'X-Nexa-3D-Claim': job.claim_token }, signal: controller.signal });
      if (!response.ok) throw new Error(`Image download failed HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
      return bytes.length;
    } finally { clearTimeout(timer); }
  }

  async uploadResult(job, glbFile, sha256) {
    const cfg = this.config();
    const bytes = await fsp.readFile(glbFile);
    const form = new FormData();
    form.append('job_uuid', job.uuid);
    form.append('claim_token', job.claim_token);
    form.append('sha256', sha256);
    form.append('glb', new Blob([bytes], { type: 'model/gltf-binary' }), path.basename(glbFile));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(cfg.http_timeout_seconds, 600) * 1000);
    try {
      const response = await fetch(cfg.nexa_api_base + 'worker-result.php', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.worker_token}`, 'User-Agent': `Nexa-3D-Worker-Local/${VERSION}` },
        body: form,
        signal: controller.signal
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Nexa returned HTTP ${response.status}: ${text.slice(0, 700)}`); }
      if (!response.ok || data.ok === false) throw new Error(data.error || `Nexa returned HTTP ${response.status}`);
      return data;
    } finally { clearTimeout(timer); }
  }

  async generateStableFast3D(image, outputDir, payload, progressCb) {
    const cfg = this.store.get();
    const repo = path.resolve(cfg.stable_fast_3d_repo);
    const python = path.resolve(cfg.stable_fast_3d_python);
    const runPy = path.join(repo, 'run.py');
    if (!fileExists(runPy)) throw new Error('Stable Fast 3D is not installed. Use Engine Setup → Install / Repair Stable Fast 3D.');
    if (!fileExists(python)) throw new Error('Stable Fast 3D Python environment is missing. Use Engine Setup → Install / Repair Stable Fast 3D.');
    await fsp.mkdir(outputDir, { recursive: true });
    const args = [runPy, image, '--output-dir', outputDir];
    const quality = String(payload?.quality || 'standard');
    const textureResolution = quality === 'high' ? '2048' : quality === 'draft' ? '512' : '1024';
    args.push('--texture-resolution', textureResolution);
    const env = { ...process.env };
    if (cfg.force_cpu) env.SF3D_USE_CPU = '1';
    if (cfg.hf_token) env.HF_TOKEN = cfg.hf_token;
    await progressCb(20, 'Starting Stable Fast 3D', `Texture resolution ${textureResolution}px.`);
    await new Promise((resolve, reject) => {
      const child = spawn(python, args, { cwd: repo, env, windowsHide: true, shell: false });
      this.currentChild = child;
      let tail = [], progress = 28;
      let lastUpdate = 0;
      const onData = async (chunk) => {
        const text = String(chunk || '');
        for (const line of splitLines(text)) {
          if (!line.trim()) continue;
          tail.push(line); tail = tail.slice(-40); this.log(`[SF3D] ${line}`);
        }
        const now = Date.now();
        if (now - lastUpdate > 12000 && progress < 78) {
          lastUpdate = now; progress = Math.min(78, progress + 4);
          progressCb(progress, 'Generating geometry and materials', tail.at(-1)?.slice(-280) || 'Stable Fast 3D is processing.').catch(() => {});
        }
      };
      child.stdout?.on('data', onData); child.stderr?.on('data', onData);
      child.on('error', reject);
      child.on('close', (code) => {
        this.currentChild = null;
        if (this.stopRequested) reject(new Error('Worker was stopped by the user.'));
        else if (code === 0) resolve();
        else reject(new Error(`Stable Fast 3D exited with code ${code}.\n${tail.slice(-12).join('\n')}`));
      });
    });
    const glbs = await findGlbs(outputDir);
    if (!glbs.length) throw new Error('Stable Fast 3D completed but no GLB was found in its output folder.');
    await progressCb(82, 'GLB created', path.basename(glbs[0]));
    return glbs[0];
  }

  async generateHunyuan(image, outputDir, payload, progressCb) {
    const cfg = this.store.get();
    const base = trimTrailingSlashes(cfg.hunyuan3d_api_url);
    if (!isHttpUrl(base)) throw new Error('Hunyuan3D API URL is invalid.');
    await progressCb(20, 'Preparing Hunyuan3D', 'Encoding the source image for the local Hunyuan3D API.');
    const imageBase64 = (await fsp.readFile(image)).toString('base64');
    await progressCb(32, 'Generating geometry', 'Hunyuan3D is reconstructing the object.');
    const controller = new AbortController();
    this.currentAbortController = controller;
    const timer = setTimeout(() => controller.abort(), cfg.provider_timeout_seconds * 1000);
    let response;
    try {
      response = await fetch(`${base}/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageBase64, texture: payload?.generate_textures !== false }), signal: controller.signal
      });
    } finally { clearTimeout(timer); this.currentAbortController = null; }
    if (!response.ok) throw new Error(`Hunyuan3D API returned HTTP ${response.status}: ${(await response.text()).slice(0, 900)}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('Hunyuan3D API response was not a GLB file.');
    await fsp.mkdir(outputDir, { recursive: true });
    const result = path.join(outputDir, 'hunyuan3d-result.glb');
    await fsp.writeFile(result, bytes);
    await progressCb(82, 'GLB created', path.basename(result));
    return result;
  }

  async generateWithProvider(image, outputDir, payload, progressCb) {
    return this.store.get().provider === 'hunyuan3d_api'
      ? this.generateHunyuan(image, outputDir, payload, progressCb)
      : this.generateStableFast3D(image, outputDir, payload, progressCb);
  }

  async processJob(job) {
    const cfg = this.store.get();
    this.busy = true; this.currentJob = job; this.emitStatus();
    const jobDir = path.join(this.store.paths().work, safeName(job.uuid));
    await fsp.rm(jobDir, { recursive: true, force: true });
    const inputDir = path.join(jobDir, 'input'), outputDir = path.join(jobDir, 'output');
    await fsp.mkdir(inputDir, { recursive: true }); await fsp.mkdir(outputDir, { recursive: true });
    const ext = path.extname(job.input_filename || '.png').toLowerCase() || '.png';
    const image = path.join(inputDir, `source${ext}`);
    try {
      await this.progress(job, 5, 'Downloading source image', 'Retrieving the protected image from Nexa.');
      const size = await this.downloadImage(job, image);
      await this.progress(job, 12, 'Source image ready', `${size} bytes downloaded.`);
      const glb = await this.generateWithProvider(image, outputDir, job.payload || {}, (v, s, m) => this.progress(job, v, s, m));
      const validated = await validateGlb(glb);
      await this.progress(job, 90, 'Validating generated GLB', `SHA-256 ${validated.sha256.slice(0, 12)}…`);
      const result = await this.uploadResult(job, glb, validated.sha256);
      this.processed += 1;
      this.log(`Job ${job.uuid} completed. Nexa asset ${result.asset_id || ''}.`);
      this.callbacks.onJob?.({ uuid: job.uuid, progress: 100, stage: 'Completed', result });
    } catch (error) {
      this.log(`Job ${job.uuid} failed: ${error.message}`, 'error');
      await this.fail(job, error.message);
    } finally {
      if (!cfg.keep_temp) await fsp.rm(jobDir, { recursive: true, force: true });
      this.busy = false; this.currentJob = null; this.emitStatus();
    }
  }

  async start() {
    if (this.running) return { ok: true, message: 'Worker is already running.', status: this.status() };
    this.config();
    this.stopRequested = false; this.running = true; this.lastError = ''; this.emitStatus();
    this.log(`Worker started using ${this.store.get().provider}.`);
    this.loop().catch((error) => { this.log(`Worker loop stopped: ${error.message}`, 'error'); this.running = false; this.emitStatus(); });
    return { ok: true, message: 'Worker started.', status: this.status() };
  }

  async stop() {
    this.stopRequested = true;
    if (this.currentAbortController) { try { this.currentAbortController.abort(); } catch {} }
    if (this.currentChild && !this.currentChild.killed) {
      try { this.currentChild.kill('SIGTERM'); } catch {}
      if (process.platform === 'win32' && this.currentChild.pid) {
        try { spawn('taskkill', ['/PID', String(this.currentChild.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      }
    }
    this.running = false; this.log('Worker stopped by user.'); this.emitStatus();
    return { ok: true, message: 'Worker stopped.', status: this.status() };
  }

  async loop() {
    while (this.running && !this.stopRequested) {
      try {
        await this.heartbeat();
        const job = await this.claim();
        if (job) {
          this.log(`Claimed ${job.uuid}: ${job.asset_name || '3D asset'}.`);
          await this.processJob(job);
          continue;
        }
      } catch (error) {
        this.log(`Worker cycle failed: ${error.message}`, 'error');
      }
      const seconds = Math.max(5, Number(this.store.get().poll_seconds) || 10);
      for (let i = 0; i < seconds && this.running && !this.stopRequested; i++) await sleep(1000);
    }
    this.running = false; this.emitStatus();
  }

  async runOnce() {
    if (this.busy) throw new Error('A job is already processing.');
    await this.heartbeat();
    const job = await this.claim();
    if (!job) return { ok: true, message: 'No queued 3D jobs were found.' };
    this.log(`One-job mode claimed ${job.uuid}.`);
    await this.processJob(job);
    return { ok: true, message: 'One queued job was processed.', status: this.status() };
  }

  async generateLocalTest(payload = {}) {
    if (this.busy) throw new Error('The worker is busy with a Nexa job.');
    const image = String(payload.image || '');
    if (!fileExists(image)) throw new Error('Choose a valid JPG, PNG or WEBP image.');
    const outputBase = String(payload.output_dir || path.join(this.store.paths().userData, 'LocalTests'));
    await fsp.mkdir(outputBase, { recursive: true });
    const testDir = path.join(this.store.paths().work, `local-test-${Date.now()}`);
    const engineOutput = path.join(testDir, 'output');
    this.busy = true; this.emitStatus();
    try {
      this.log(`Starting local test generation from ${path.basename(image)}.`);
      const glb = await this.generateWithProvider(image, engineOutput, { quality: payload.quality || 'standard', generate_textures: true }, async (progress, stage, message) => {
        this.callbacks.onJob?.({ uuid: 'local-test', asset_name: path.basename(image), progress, stage, message });
        this.log(`[Local Test ${progress}%] ${stage}${message ? ` — ${message}` : ''}`);
      });
      await validateGlb(glb);
      const target = path.join(outputBase, `${safeName(path.parse(image).name)}-${Date.now()}.glb`);
      await fsp.copyFile(glb, target);
      this.log(`Local test GLB saved to ${target}.`);
      return { ok: true, file: target };
    } finally {
      await fsp.rm(testDir, { recursive: true, force: true }).catch(() => {});
      this.busy = false; this.emitStatus();
    }
  }
}

module.exports = { NexaWorker, validateGlb, safeName };
