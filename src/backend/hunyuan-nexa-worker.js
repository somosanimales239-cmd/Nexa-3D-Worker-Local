'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { NexaWorker } = require('./nexa-worker');
const { runHunyuanMultiview } = require('./hunyuan-multiview-runner');

async function validateGlb(file) {
  const buffer = await fsp.readFile(file);
  if (buffer.length < 20) throw new Error('Generated GLB is empty or too small.');
  if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('Generated file does not have a GLB glTF signature.');
  if (buffer.readUInt32LE(4) !== 2) throw new Error(`Generated GLB version ${buffer.readUInt32LE(4)} is unsupported.`);
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('Generated GLB declared length does not match its file size.');
  return { sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

class HunyuanNexaWorker extends NexaWorker {
  async heartbeat() {
    const cfg = this.config();
    const data = await this.requestJson('worker-heartbeat.php', { worker_id: cfg.worker_id, provider: cfg.provider, version: '1.8.2' });
    this.lastHeartbeat = new Date().toISOString();
    this.emitStatus();
    return data;
  }

  async claim() {
    const cfg = this.config();
    const data = await this.requestJson('worker-next.php', { worker_id: cfg.worker_id, provider: cfg.provider, version: '1.8.2' });
    return data.job || null;
  }

  async generateWithProvider(image, outputDir, payload, progressCb) {
    const cfg = this.store.get();
    if (cfg.provider !== 'hunyuan3d_multiview_local') return super.generateWithProvider(image, outputDir, payload, progressCb);
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

  async processJob(job) {
    const cfg = this.store.get();
    if (cfg.provider !== 'hunyuan3d_multiview_local') return super.processJob(job);

    this.busy = true; this.currentJob = job; this.emitStatus();
    const workRoot = path.join(path.resolve(String(cfg.hunyuan3d_temp_dir || 'D:\\N3D\\temp')), 'nexa-worker-jobs');
    await fsp.mkdir(workRoot, { recursive: true });
    const safe = String(job.uuid || 'job').replace(/[^a-zA-Z0-9._-]+/g, '-');
    const jobDir = path.join(workRoot, safe);
    await fsp.rm(jobDir, { recursive: true, force: true });
    const inputDir = path.join(jobDir, 'input');
    const outputDir = path.join(jobDir, 'hunyuan-multiview');
    await fsp.mkdir(inputDir, { recursive: true });
    await fsp.mkdir(outputDir, { recursive: true });
    const ext = path.extname(job.input_filename || '.png').toLowerCase() || '.png';
    const frontImage = path.join(inputDir, `front${ext}`);

    try {
      await this.progress(job, 5, 'Downloading Front reference', 'Retrieving the protected Front image from Nexa.');
      const size = await this.downloadImage(job, frontImage);
      await this.progress(job, 10, 'Front reference ready', `${size} bytes downloaded.`);
      const extraViews = await this.prepareMultiViewInputs(job, inputDir);
      const views = [{ name: 'front', file: frontImage }, ...extraViews.map(v => ({ name: v.name, file: v.image }))];
      const payload = job.payload || {};
      await this.progress(job, 14, 'Exact 8082 Hunyuan multi-view', `${views.length} reference view${views.length === 1 ? '' : 's'} ready. Using the exact 8082 shape preset and proven Hunyuan Paint path; Blender is bypassed.`);

      const finalGlb = await runHunyuanMultiview({
        cfg,
        views,
        outputDir,
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
    } catch (error) {
      this.log(`Hunyuan multi-view job ${job.uuid} failed: ${error.message}`, 'error');
      await this.fail(job, error.message, 'Hunyuan multi-view generation failed');
    } finally {
      this.currentChild = null;
      if (!cfg.keep_temp) await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      this.busy = false; this.currentJob = null; this.emitStatus();
    }
  }
}

module.exports = { HunyuanNexaWorker };
