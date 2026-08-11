'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { quickTextureJob } = require('./quick-texture-processor');

function fileExists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }
async function sleep(ms) { return await new Promise((resolve) => setTimeout(resolve, ms)); }

class QuickTextureBridge {
  constructor(config = {}) {
    this.baseUrl = String(config.baseUrl || '').replace(/\/?$/, '/');
    this.workerToken = String(config.workerToken || '');
    this.workerId = String(config.workerId || os.hostname() + '-nexa-quick-texture');
    this.blenderPath = String(config.blenderPath || '');
    this.pollSeconds = Math.max(5, Number(config.pollSeconds || 10));
    this.workRoot = path.resolve(String(config.workRoot || path.join(process.cwd(), 'quick-texture-work')));
    this.running = false;
    this.onLog = typeof config.onLog === 'function' ? config.onLog : console.log;
  }

  log(message) { this.onLog(`[QuickTextureBridge] ${message}`); }

  headers(extra = {}) {
    return Object.assign({
      'X-Nexa-3D-Worker-Token': this.workerToken,
      'Content-Type': 'application/json'
    }, extra);
  }

  async postJson(endpoint, body) {
    const response = await fetch(this.baseUrl + endpoint, { method: 'POST', headers: this.headers(), body: JSON.stringify(body || {}) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Invalid JSON from ${endpoint}: ${text.slice(0, 500)}`); }
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async claimNext() {
    return (await this.postJson('quick-texture-next.php', { worker_id: this.workerId })).job || null;
  }

  async updateProgress(job, progress, stage, message) {
    return await this.postJson('quick-texture-progress.php', { job_id: job.id, claim_token: job.claim_token, progress, stage, message });
  }

  async fail(job, error) {
    try {
      await this.postJson('quick-texture-fail.php', { job_id: job.id, claim_token: job.claim_token, error: String(error || 'Quick texture failed.') });
    } catch (reportError) {
      this.log(`Could not report failure: ${reportError.message}`);
    }
  }

  extractZipWindows(zipFile, targetDir) {
    if (process.platform !== 'win32') throw new Error('This quick texture bridge currently expects Windows for ZIP extraction.');
    const command = `Expand-Archive -LiteralPath '${String(zipFile).replace(/'/g, "''")}' -DestinationPath '${String(targetDir).replace(/'/g, "''")}' -Force`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 300000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Could not extract the quick texture bundle ZIP.');
  }

  async downloadBundle(job, rootDir) {
    const bundleZip = path.join(rootDir, 'bundle.zip');
    const bundleDir = path.join(rootDir, 'bundle');
    const url = `${this.baseUrl}quick-texture-bundle.php?job_id=${encodeURIComponent(job.id)}&claim_token=${encodeURIComponent(job.claim_token)}`;
    const response = await fetch(url, { headers: { 'X-Nexa-3D-Worker-Token': this.workerToken } });
    if (!response.ok) throw new Error(`Bundle download failed. HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await ensureDir(rootDir);
    await fsp.writeFile(bundleZip, buffer);
    this.extractZipWindows(bundleZip, bundleDir);
    return { bundleZip, bundleDir };
  }

  async uploadResult(job, resultFile) {
    const bytes = await fsp.readFile(resultFile);
    const form = new FormData();
    form.append('job_id', job.id);
    form.append('claim_token', job.claim_token);
    form.append('result', new Blob([bytes], { type: 'model/gltf-binary' }), path.basename(resultFile));
    const response = await fetch(this.baseUrl + 'quick-texture-result.php', {
      method: 'POST',
      headers: { 'X-Nexa-3D-Worker-Token': this.workerToken },
      body: form
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Invalid JSON from quick-texture-result.php: ${text.slice(0, 500)}`); }
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async processOne(job) {
    const root = path.join(this.workRoot, String(job.id));
    this.log(`Claimed job ${job.id} for asset ${job.asset_name || '3D Asset'}`);
    await this.updateProgress(job, 8, 'Downloading bundle', 'Downloading the quick texture bundle from Nexa.');
    const downloaded = await this.downloadBundle(job, root);
    await this.updateProgress(job, 22, 'Bundle ready', 'Quick texture bundle downloaded and extracted.');
    const onLog = (line) => this.log(String(line).trim());
    await this.updateProgress(job, 45, 'Applying quick texture', 'Blender is applying fast color and texture.');
    const result = await quickTextureJob({ bundleDir: downloaded.bundleDir, outputDir: path.join(root, 'output'), blenderPath: this.blenderPath, onLog });
    await this.updateProgress(job, 88, 'Uploading result', 'Uploading the quick textured model back to Nexa.');
    await this.uploadResult(job, result.output);
    this.log(`Completed quick texture job ${job.id}`);
  }

  async loop() {
    this.running = true;
    this.log('Quick texture bridge is running.');
    while (this.running) {
      try {
        const job = await this.claimNext();
        if (job) {
          try {
            await this.processOne(job);
          } catch (error) {
            this.log(`Job ${job.id} failed: ${error.message}`);
            await this.fail(job, error.message);
          }
          continue;
        }
      } catch (error) {
        this.log(`Loop error: ${error.message}`);
      }
      await sleep(this.pollSeconds * 1000);
    }
  }

  stop() { this.running = false; }
}

module.exports = { QuickTextureBridge };
