'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ApplyPackageStore } = require('./apply-package-store');
const { quickTextureJob } = require('./quick-texture-processor');
const { bakeMultiViewTexture } = require('./multi-view-texture');

const VERSION = '1.7.1';

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


async function findResultCandidate(dir) {
  if (!dirExists(dir)) return null;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!['.glb', '.gltf', '.zip'].includes(ext)) continue;
    const full = path.join(dir, entry.name);
    const stat = await fsp.stat(full);
    files.push({ file: full, stat });
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return files[0]?.file || null;
}

class NexaWorker {
  constructor(store, engines, callbacks = {}) {
    this.store = store;
    this.engines = engines;
    this.callbacks = callbacks;
    this.applyPackages = new ApplyPackageStore(store.paths().userData);
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
        headers: { 'Authorization': `Bearer ${cfg.worker_token}`, 'X-Nexa-3D-Worker-Token': cfg.worker_token, 'Content-Type': 'application/json', 'User-Agent': `Nexa-3D-Worker-Local/${VERSION}` },
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


  async claimDispatch() {
    const cfg = this.config();
    const data = await this.requestJson('dispatch-next.php', { worker_id: cfg.worker_id, provider: cfg.provider, version: VERSION });
    return data.job || null;
  }

  async dispatchProgress(job, progress, stage, message = '') {
    await this.requestJson('dispatch-progress.php', {
      dispatch_id: job.dispatch_id, claim_token: job.claim_token, progress, stage, message,
      worker_id: this.config().worker_id, version: VERSION
    });
  }

  async dispatchFail(job, error, stage = 'Worker failed') {
    try {
      await this.requestJson('dispatch-fail.php', { dispatch_id: job.dispatch_id, claim_token: job.claim_token, error: String(error).slice(0, 3000), stage });
    } catch (reportError) {
      this.log(`Could not report dispatch failure to Nexa: ${reportError.message}`, 'error');
    }
  }

  async downloadDispatchPackage(job, target) {
    const cfg = this.config();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.http_timeout_seconds * 1000);
    try {
      const response = await fetch(job.package_url, {
        headers: {
          'Authorization': `Bearer ${cfg.worker_token}`,
          'X-Nexa-3D-Worker-Token': cfg.worker_token,
          'X-Nexa-3D-Claim': job.claim_token,
          'User-Agent': `Nexa-3D-Worker-Local/${VERSION}`
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Package download failed HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
      return bytes.length;
    } finally { clearTimeout(timer); }
  }

  async uploadDispatchResult(job, resultFile) {
    const cfg = this.config();
    const bytes = await fsp.readFile(resultFile);
    const form = new FormData();
    form.append('dispatch_id', job.dispatch_id);
    form.append('claim_token', job.claim_token);
    form.append('result', new Blob([bytes], { type: 'application/octet-stream' }), path.basename(resultFile));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(cfg.http_timeout_seconds, 600) * 1000);
    try {
      const response = await fetch(cfg.nexa_api_base + 'dispatch-result.php', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.worker_token}`, 'X-Nexa-3D-Worker-Token': cfg.worker_token, 'User-Agent': `Nexa-3D-Worker-Local/${VERSION}` },
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

  async stageDispatchPackage(job) {
    const inbox = path.join(this.store.paths().work, 'dispatch-inbox', String(job.dispatch_id));
    const zipPath = path.join(inbox, String(job.package_name || `apply-package-${job.dispatch_id}.zip`));
    try {
      await this.dispatchProgress(job, 8, 'Downloading apply package', 'Retrieving the Apply Package ZIP from Nexa.');
      const bytes = await this.downloadDispatchPackage(job, zipPath);
      await this.dispatchProgress(job, 20, 'Apply package ready', `${bytes} bytes downloaded.`);
      const local = await this.applyPackages.importRemotePackage(job, zipPath);
      await this.dispatchProgress(job, 40, 'Waiting for local result file', `Place the finished GLB / GLTF / ZIP inside: ${local.result_drop_folder}`);
      this.log(`Dispatch ${job.dispatch_id} imported automatically. Waiting for result file in ${local.result_drop_folder}.`);
      return local;
    } catch (error) {
      await this.dispatchFail(job, error.message, 'Apply package staging failed');
      this.log(`Dispatch ${job.dispatch_id} failed during staging: ${error.message}`, 'error');
      return null;
    }
  }

  async checkPendingDispatchUploads() {
    const pending = this.applyPackages.pendingRemotePackages();
    for (const item of pending) {
      const resultFile = item.result_path && fileExists(item.result_path) ? item.result_path : await findResultCandidate(item.result_drop_folder || '');
      if (!resultFile) continue;
      const job = { dispatch_id: item.remote_dispatch_id, claim_token: item.remote_claim_token, output_name: item.output_name };
      try {
        this.applyPackages.updateRemoteState(item.id, { status: 'processing', bridge_state: 'uploading', result_path: resultFile, result_name: path.basename(resultFile) });
        await this.dispatchProgress(job, 82, 'Uploading finished result', `Uploading ${path.basename(resultFile)} back to Nexa.`);
        const response = await this.uploadDispatchResult(job, resultFile);
        this.applyPackages.updateRemoteState(item.id, {
          status: 'completed',
          bridge_state: 'uploaded_to_nexa',
          uploaded_back_to_nexa: true,
          result_path: resultFile,
          result_name: path.basename(resultFile),
          result_size: (await fsp.stat(resultFile)).size,
          remote_download_url: response.download_url || ''
        });
        this.processed += 1;
        this.log(`Dispatch ${item.remote_dispatch_id} completed and uploaded back to Nexa.`);
      } catch (error) {
        this.applyPackages.updateRemoteState(item.id, { status: 'failed', bridge_state: 'upload_failed', last_error: error.message });
        await this.dispatchFail(job, error.message, 'Dispatch upload failed');
        this.log(`Dispatch ${item.remote_dispatch_id} failed while uploading result: ${error.message}`, 'error');
      }
    }
  }


  async claimQuickTexture() {
    const cfg = this.config();
    if (!cfg.quick_texture_enabled) return null;
    const data = await this.requestJson('quick-texture-next.php', { worker_id: cfg.worker_id, version: VERSION });
    return data.job || null;
  }

  async quickTextureProgress(job, progress, stage, message = '') {
    await this.requestJson('quick-texture-progress.php', {
      job_id: job.id, claim_token: job.claim_token, progress, stage, message,
      worker_id: this.config().worker_id, version: VERSION
    });
    this.callbacks.onJob?.({ uuid: `quick-texture:${job.id}`, progress, stage, message, asset_name: job.asset_name || 'Quick Texture' });
  }

  async quickTextureFail(job, error) {
    try {
      await this.requestJson('quick-texture-fail.php', { job_id: job.id, claim_token: job.claim_token, error: String(error).slice(0, 3000) });
    } catch (reportError) {
      this.log(`Could not report Quick Texture failure: ${reportError.message}`, 'error');
    }
  }

  async downloadQuickTextureBundle(job, target) {
    const cfg = this.config();
    const url = cfg.nexa_api_base + `quick-texture-bundle.php?job_id=${encodeURIComponent(job.id)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.http_timeout_seconds * 1000);
    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${cfg.worker_token}`,
          'X-Nexa-3D-Worker-Token': cfg.worker_token,
          'X-Nexa-3D-Claim': job.claim_token,
          'User-Agent': `Nexa-3D-Worker-Local/${VERSION}`
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Quick Texture bundle download failed HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
      return bytes.length;
    } finally { clearTimeout(timer); }
  }

  extractQuickTextureBundle(zipFile, targetDir) {
    if (process.platform !== 'win32') throw new Error('Quick Texture automatic ZIP extraction currently requires Windows.');
    fs.mkdirSync(targetDir, { recursive: true });
    const ps = `Expand-Archive -LiteralPath '${String(zipFile).replace(/'/g, "''")}' -DestinationPath '${String(targetDir).replace(/'/g, "''")}' -Force`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Unable to extract Quick Texture bundle.').trim());
  }

  async uploadQuickTextureResult(job, resultFile) {
    const cfg = this.config();
    const bytes = await fsp.readFile(resultFile);
    const form = new FormData();
    form.append('job_id', job.id);
    form.append('claim_token', job.claim_token);
    form.append('result', new Blob([bytes], { type: 'model/gltf-binary' }), path.basename(resultFile));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(cfg.http_timeout_seconds, 600) * 1000);
    try {
      const response = await fetch(cfg.nexa_api_base + 'quick-texture-result.php', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.worker_token}`, 'X-Nexa-3D-Worker-Token': cfg.worker_token, 'User-Agent': `Nexa-3D-Worker-Local/${VERSION}` },
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

  async processQuickTextureJob(job) {
    const cfg = this.store.get();
    const root = path.join(this.heavyWorkRoot(), `quick-texture-${safeName(job.id)}`);
    const zip = path.join(root, 'bundle.zip');
    const bundleDir = path.join(root, 'bundle');
    const outputDir = path.join(root, 'output');
    this.busy = true;
    this.currentJob = { uuid: `quick-texture:${job.id}`, asset_name: job.asset_name || 'Quick Texture' };
    this.emitStatus();
    try {
      await this.quickTextureProgress(job, 8, 'Downloading Quick Texture bundle', 'Downloading model, original source image and references.');
      const size = await this.downloadQuickTextureBundle(job, zip);
      this.extractQuickTextureBundle(zip, bundleDir);
      await this.quickTextureProgress(job, 25, 'Bundle ready', `${size} bytes downloaded and extracted.`);
      await this.quickTextureProgress(job, 40, 'Fast texture pass', 'Blender is applying the selected Quick Texture paint / texture mode to the model.');
      const result = await quickTextureJob({
        bundleDir,
        outputDir,
        blenderPath: cfg.blender_path || '',
        onLog: (line) => this.log(`[Quick Texture] ${line}`),
        onChild: (child) => { this.currentChild = child; }
      });
      const validated = await validateGlb(result.output);
      await this.quickTextureProgress(job, 88, 'Validating result', `GLB validated · ${validated.sha256.slice(0, 12)}…`);
      await this.uploadQuickTextureResult(job, result.output);
      this.processed += 1;
      this.log(`Quick Texture ${job.id} completed and returned to Nexa.`);
      this.callbacks.onJob?.({ uuid: `quick-texture:${job.id}`, progress: 100, stage: 'Completed', asset_name: job.asset_name || 'Quick Texture' });
    } catch (error) {
      this.log(`Quick Texture ${job.id} failed: ${error.message}`, 'error');
      await this.quickTextureFail(job, error.message);
    } finally {
      if (!cfg.keep_temp) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
      this.busy = false; this.currentJob = null; this.emitStatus();
    }
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
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.requestJson('worker-progress.php', {
          job_uuid: job.uuid, claim_token: job.claim_token, progress, stage, message,
          worker_id: this.config().worker_id, version: VERSION
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(700 * attempt);
      }
    }
    if (lastError) this.log(`Progress telemetry warning at ${progress}% (${stage}): ${lastError.message}. Local generation will continue.`, 'warn');
    this.callbacks.onJob?.({ uuid: job.uuid, progress, stage, message, asset_name: job.asset_name });
    return lastError === null;
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
      const response = await fetch(job.image_url, { headers: { 'Authorization': `Bearer ${cfg.worker_token}`, 'X-Nexa-3D-Worker-Token': cfg.worker_token, 'X-Nexa-3D-Claim': job.claim_token }, signal: controller.signal });
      if (!response.ok) throw new Error(`Image download failed HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
      return bytes.length;
    } finally { clearTimeout(timer); }
  }


  async downloadReference(job, reference, target) {
    const cfg = this.config();
    const url = String(reference?.download_url || '');
    if (!url) throw new Error(`Reference ${reference?.group || 'image'} does not include a protected download URL.`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.http_timeout_seconds * 1000);
    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${cfg.worker_token}`,
          'X-Nexa-3D-Worker-Token': cfg.worker_token,
          'X-Nexa-3D-Claim': job.claim_token,
          'User-Agent': `Nexa-3D-Worker-Local/${VERSION}`
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Reference download failed HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
      return bytes.length;
    } finally { clearTimeout(timer); }
  }

  async prepareMultiViewInputs(job, inputDir) {
    const refs = Array.isArray(job.reference_images) ? job.reference_images : [];
    const byGroup = new Map();
    for (const ref of refs) if (ref?.group && !byGroup.has(String(ref.group))) byGroup.set(String(ref.group), ref);
    const result = [];
    for (const group of ['back','left','right']) {
      const ref = byGroup.get(group);
      if (!ref) continue;
      const ext = path.extname(String(ref.filename || '.png')).toLowerCase() || '.png';
      const target = path.join(inputDir, `${group}${ext}`);
      await this.progress(job, 13, `Downloading ${group} reference`, `Retrieving the protected ${group} view from Nexa.`);
      await this.downloadReference(job, ref, target);
      result.push({ name: group, image: target, reference: ref });
    }
    return result;
  }

  mappedViewProgress(job, label, start, end) {
    return async (raw, stage, message) => {
      const normalized = Math.max(0, Math.min(100, Number(raw) || 0)) / 100;
      const progress = Math.round(start + (end - start) * normalized);
      await this.progress(job, progress, `${label}: ${stage}`, message);
    };
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
        headers: { 'Authorization': `Bearer ${cfg.worker_token}`, 'X-Nexa-3D-Worker-Token': cfg.worker_token, 'User-Agent': `Nexa-3D-Worker-Local/${VERSION}` },
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
    const requestedSf3dResolution = Number(payload?.sf3d_texture_resolution || 0);
    const textureResolution = requestedSf3dResolution > 0
      ? String(Math.max(512, Math.min(2048, requestedSf3dResolution)))
      : (quality === 'high' ? '2048' : quality === 'draft' ? '512' : '1024');
    args.push('--texture-resolution', textureResolution);
    args.push('--batch_size', '1');
    if (!cfg.force_cpu) args.push('--device', 'cuda');
    const env = { ...process.env };
    if (!cfg.force_cpu) {
      env.PYTORCH_CUDA_ALLOC_CONF = env.PYTORCH_CUDA_ALLOC_CONF || 'expandable_segments:True';
    }
    if (cfg.force_cpu) env.SF3D_USE_CPU = '1';
    if (cfg.hf_token) env.HF_TOKEN = cfg.hf_token;
    const hfCacheDir = String(cfg.hf_cache_dir || env.HF_HOME || '').trim();
    if (hfCacheDir) {
      const resolvedHfCache = path.resolve(hfCacheDir);
      const resolvedHubCache = path.join(resolvedHfCache, 'hub');
      await fsp.mkdir(resolvedHubCache, { recursive: true });
      env.HF_HOME = resolvedHfCache;
      env.HF_HUB_CACHE = resolvedHubCache;
      env.HUGGINGFACE_HUB_CACHE = resolvedHubCache;
      this.log(`[SF3D] Hugging Face cache: ${resolvedHubCache}`);
    } else {
      this.log('[SF3D] Hugging Face cache folder is not configured; the system default cache will be used.', 'warn');
    }
    await progressCb(20, 'Starting Stable Fast 3D', `Texture resolution ${textureResolution}px${hfCacheDir ? ` · HF cache ${path.resolve(hfCacheDir)}` : ''}.`);
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

  heavyWorkRoot() {
    const cfg = this.store.get();
    const hfCacheDir = String(cfg.hf_cache_dir || process.env.HF_HOME || '').trim();
    return hfCacheDir ? path.join(path.resolve(hfCacheDir), 'nexa-worker-temp') : this.store.paths().work;
  }

  async processJob(job) {
    const cfg = this.store.get();
    this.busy = true; this.currentJob = job; this.emitStatus();
    const workRoot = this.heavyWorkRoot();
    await fsp.mkdir(workRoot, { recursive: true });
    const jobDir = path.join(workRoot, safeName(job.uuid));
    await fsp.rm(jobDir, { recursive: true, force: true });
    const inputDir = path.join(jobDir, 'input'), outputDir = path.join(jobDir, 'output');
    await fsp.mkdir(inputDir, { recursive: true }); await fsp.mkdir(outputDir, { recursive: true });
    const ext = path.extname(job.input_filename || '.png').toLowerCase() || '.png';
    const frontImage = path.join(inputDir, `front${ext}`);
    try {
      await this.progress(job, 5, 'Downloading Front reference', 'Retrieving the protected Front image from Nexa.');
      const size = await this.downloadImage(job, frontImage);
      await this.progress(job, 10, 'Front reference ready', `${size} bytes downloaded.`);

      const payload = job.payload || {};
      const multiView = payload?.multi_view?.enabled === true || payload?.pipeline === 'quality_multiview';
      if (!multiView) {
        const glb = await this.generateWithProvider(frontImage, outputDir, payload, (v, s, m) => this.progress(job, v, s, m));
        const validated = await validateGlb(glb);
        await this.progress(job, 90, 'Validating generated GLB', `SHA-256 ${validated.sha256.slice(0, 12)}…`);
        const result = await this.uploadResult(job, glb, validated.sha256);
        this.processed += 1;
        this.log(`Job ${job.uuid} completed. Nexa asset ${result.asset_id || ''}.`);
        this.callbacks.onJob?.({ uuid: job.uuid, progress: 100, stage: 'Completed', result });
        return;
      }

      const extraViews = await this.prepareMultiViewInputs(job, inputDir);
      const viewImages = [{ name:'front', image:frontImage }, ...extraViews.map(v => ({ name:v.name, image:v.image, reference:v.reference }))];
      const refine = payload?.professional_refine || {};
      const refineEnabled = refine.enabled === true || payload?.pipeline === 'single_base_professional_refine';
      const polishLevel = String(refine.polish_level || (payload?.quality === 'high' ? 'professional' : 'standard'));
      const orientationMode = String(refine.orientation_mode || 'front_positive_y');
      const refineMode = String(refine.refine_mode || (refineEnabled ? 'professional_refine' : 'standard_multiview'));

      // IMPORTANT QUALITY RULE: Stable Fast 3D is a single-image reconstruction engine.
      // Never create complete Front/Back/Side bodies and voxel-fuse them together.
      // That duplicates invented geometry and can make a good front reconstruction dramatically worse.
      // We preserve ONE coherent base mesh from the Front reference, then use Back/Left/Right only
      // as texture evidence projected onto that same mesh.
      const baseOut = path.join(jobDir, 'view-front');
      const basePayload = { ...payload, quality: 'high', generate_textures: false, optimize_web: false, sf3d_texture_resolution: 1024 };
      await this.progress(job, 14, 'Reconstructing base geometry', 'Creating one clean base geometry from the Front reference only. SF3D uses a VRAM-safe 1024px temporary bake; the final professional texture is still produced later at up to 4096px.');
      let finalGlb = await this.generateWithProvider(
        frontImage,
        baseOut,
        basePayload,
        this.mappedViewProgress(job, 'BASE GEOMETRY', 14, 72)
      );
      await validateGlb(finalGlb);
      await this.progress(job, 78, 'Base geometry preserved', 'Single coherent Front reconstruction retained. Back and side references will now improve orientation, continuity and finish.');

      if (viewImages.length > 1) {
        await this.progress(job, 82, refineEnabled ? 'Professional multi-view refine' : 'Multi-View Texture', refineEnabled ? 'Applying orientation-correct reference projection and professional polish on the locked base mesh.' : 'Projecting Front / Back / Side references onto the single base mesh and preparing a 4096px color-safe bake.');
        const textured = await bakeMultiViewTexture({
          model: finalGlb,
          views: viewImages.map(view => ({ name: view.name, file: view.image })),
          outputDir: path.join(jobDir, 'textured'),
          blenderPath: cfg.blender_path || '',
          textureSize: 4096,
          orientationMode,
          refineMode,
          polishLevel,
          onLog: (line) => this.log(`[Multi-View Texture] ${line}`),
          onChild: (child) => { this.currentChild = child; }
        });
        finalGlb = textured.output;
        await this.progress(job, 94, refineEnabled ? 'Professional polish completed' : 'Texture bake completed', `${textured.viewCount} reference views baked onto one coherent mesh in a ${textured.textureSize}px texture atlas${textured.fallbackFrom ? ' after an automatic memory-safe retry' : ''}${refineEnabled ? ` · finish ${textured.polishLevel}` : ''}.`);
      }

      const validated = await validateGlb(finalGlb);
      await this.progress(job, 97, 'Validating final GLB', `SHA-256 ${validated.sha256.slice(0, 12)}…`);
      const result = await this.uploadResult(job, finalGlb, validated.sha256);
      this.processed += 1;
      this.log(`Multi-view job ${job.uuid} completed. Nexa asset ${result.asset_id || ''}.`);
      this.callbacks.onJob?.({ uuid: job.uuid, progress: 100, stage: 'Completed', result });
    } catch (error) {
      this.log(`Job ${job.uuid} failed: ${error.message}`, 'error');
      await this.fail(job, error.message);
    } finally {
      this.currentChild = null;
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
        await this.checkPendingDispatchUploads();
        const quickTexture = await this.claimQuickTexture();
        if (quickTexture) {
          this.log(`Claimed Quick Texture ${quickTexture.id}: ${quickTexture.asset_name || '3D asset'}.`);
          await this.processQuickTextureJob(quickTexture);
          continue;
        }
        const job = await this.claim();
        if (job) {
          this.log(`Claimed ${job.uuid}: ${job.asset_name || '3D asset'}.`);
          await this.processJob(job);
          continue;
        }
        const dispatchJob = await this.claimDispatch();
        if (dispatchJob) {
          this.log(`Claimed dispatch ${dispatchJob.dispatch_id}: ${dispatchJob.output_name || dispatchJob.asset_name || 'Apply Package'}.`);
          await this.stageDispatchPackage(dispatchJob);
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
    await this.checkPendingDispatchUploads();
    const quickTexture = await this.claimQuickTexture();
    if (quickTexture) {
      await this.processQuickTextureJob(quickTexture);
      return { ok: true, message: 'One Quick Texture job was processed.', status: this.status() };
    }
    const job = await this.claim();
    if (job) {
      this.log(`One-job mode claimed ${job.uuid}.`);
      await this.processJob(job);
      return { ok: true, message: 'One queued 3D job was processed.', status: this.status() };
    }
    const dispatchJob = await this.claimDispatch();
    if (dispatchJob) {
      await this.stageDispatchPackage(dispatchJob);
      return { ok: true, message: 'One queued Apply Package was downloaded and staged for automatic upload.', status: this.status() };
    }
    return { ok: true, message: 'No queued Quick Texture, 3D or Apply Package jobs were found.' };
  }

  async generateLocalTest(payload = {}) {
    if (this.busy) throw new Error('The worker is busy with a Nexa job.');
    const image = String(payload.image || '');
    if (!fileExists(image)) throw new Error('Choose a valid JPG, PNG or WEBP image.');
    const workRoot = this.heavyWorkRoot();
    const outputBase = String(payload.output_dir || (String(this.store.get().hf_cache_dir || '').trim() ? path.join(path.resolve(this.store.get().hf_cache_dir), 'LocalTests') : path.join(this.store.paths().userData, 'LocalTests')));
    await fsp.mkdir(outputBase, { recursive: true });
    await fsp.mkdir(workRoot, { recursive: true });
    const testDir = path.join(workRoot, `local-test-${Date.now()}`);
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
