'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { NexaWorker } = require('./nexa-worker');
const { HunyuanServiceManager } = require('./hunyuan-service-manager');

const VERSION = '1.9.4';

async function validateGlb(file) {
  const buffer = await fsp.readFile(file);
  if (buffer.length < 20) throw new Error('Generated GLB is empty or too small.');
  if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('Generated file does not have a GLB glTF signature.');
  if (buffer.readUInt32LE(4) !== 2) throw new Error(`Generated GLB version ${buffer.readUInt32LE(4)} is unsupported.`);
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('Generated GLB declared length does not match its file size.');
  return { sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

class HunyuanNexaWorker extends NexaWorker {
  constructor(store, engines, callbacks = {}) {
    super(store, engines, callbacks);
    this.hunyuanService = new HunyuanServiceManager(store, (line) => this.log(`[8082 Shape] ${line}`));
    this.hunyuanWarmupStarted = false;
  }

  async start() {
    if (this.running) return { ok: true, message: 'Worker is already running.', status: this.status() };
    if (typeof this.store.ensureExact8082Provider === 'function') this.store.ensureExact8082Provider();
    const cfg = this.store.get();

    if (cfg.provider === 'hunyuan3d_multiview_local') {
      const root = path.resolve(String(cfg.hunyuan3d_local_root || ''));
      const python = path.resolve(String(cfg.hunyuan3d_local_python || ''));
      if (!fs.existsSync(path.join(root, 'gradio_app.py'))) throw new Error(`Cannot start Hunyuan Worker: gradio_app.py was not found in ${root}`);
      if (!fs.existsSync(python)) throw new Error(`Cannot start Hunyuan Worker: Python was not found at ${python}`);
      await this.heartbeat();
    }

    const result = await super.start();

    if (cfg.provider === 'hunyuan3d_multiview_local' && !this.hunyuanWarmupStarted) {
      this.hunyuanWarmupStarted = true;
      this.hunyuanService.ensureReady(async (_p, stage, message) => this.log(`${stage}: ${message}`))
        .catch((error) => this.log(`8082 Shape warmup failed: ${error.message}`, 'error'))
        .finally(() => { this.hunyuanWarmupStarted = false; });
    }

    return {
      ...result,
      message: 'Worker started. Hunyuan3D-2mv Shape warms on 8082; Shape remains untouched and Safe 384 can enhance textures after the handoff to Paint Turbo.'
    };
  }

  async stop() {
    const result = await super.stop();
    await this.hunyuanService.stop().catch(() => {});
    return result;
  }

  async heartbeat() {
    const cfg = this.config();
    const data = await this.requestJson('worker-heartbeat.php', {
      worker_id: cfg.worker_id,
      provider: cfg.provider,
      version: VERSION
    });
    this.lastHeartbeat = new Date().toISOString();
    this.emitStatus();
    return data;
  }

  async claim() {
    const cfg = this.config();
    const data = await this.requestJson('worker-next.php', {
      worker_id: cfg.worker_id,
      provider: cfg.provider,
      version: VERSION
    });
    return data.job || null;
  }

  extractQualityPlan(job) {
    const payload = (job && typeof job.payload === 'object' && job.payload) || (() => {
      try { return job?.payload_json ? JSON.parse(job.payload_json) : {}; } catch { return {}; }
    })() || {};
    const paint = payload.paint_parameters || {};
    return {
      objectType: String(payload.object_type || 'auto'),
      safeTextureBoost: Boolean(paint.smart_reference_preprocess),
      textureInputBoost: String(paint.texture_input_boost || 'off'),
      facePriority: Boolean(paint.front_face_priority),
      finalTexturePolish: Boolean(paint.final_texture_polish),
      protectShapePipeline: paint.protect_shape_pipeline !== false
    };
  }

  async generateWithProvider(image, outputDir, payload, progressCb) {
    const cfg = this.store.get();
    if (cfg.provider !== 'hunyuan3d_multiview_local') {
      return super.generateWithProvider(image, outputDir, payload, progressCb);
    }
    const views = [{ name: 'front', file: image }];
    const mesh = await this.hunyuanService.generateShape({ views, outputDir, progressCb });
    await this.hunyuanService.stopShapeBeforePaint(progressCb);
    return this.hunyuanService.runProvenPaint({ mesh, views, outputDir, progressCb });
  }

  async processJob(job) {
    const cfg = this.store.get();
    if (cfg.provider !== 'hunyuan3d_multiview_local') return super.processJob(job);

    this.busy = true;
    this.currentJob = job;
    this.emitStatus();

    const workRoot = path.join(path.resolve(String(cfg.hunyuan3d_temp_dir || 'D:\\N3D\\temp')), 'nexa-worker-jobs');
    await fsp.mkdir(workRoot, { recursive: true });
    const safe = String(job.uuid || 'job').replace(/[^a-zA-Z0-9._-]+/g, '-');
    const jobDir = path.join(workRoot, safe);
    await fsp.rm(jobDir, { recursive: true, force: true });
    const inputDir = path.join(jobDir, 'input');
    const outputDir = path.join(jobDir, 'hunyuan-known-good');
    await fsp.mkdir(inputDir, { recursive: true });
    await fsp.mkdir(outputDir, { recursive: true });

    const ext = path.extname(job.input_filename || '.png').toLowerCase() || '.png';
    const frontImage = path.join(inputDir, `front${ext}`);

    try {
      await this.progress(job, 5, 'Downloading Front reference', 'Retrieving the protected Front image from Nexa.');
      const size = await this.downloadImage(job, frontImage);
      await this.progress(job, 9, 'Front reference ready', `${size} bytes downloaded.`);

      const extraViews = await this.prepareMultiViewInputs(job, inputDir);
      const views = [
        { name: 'front', file: frontImage },
        ...extraViews.map(v => ({ name: v.name, file: v.image }))
      ];
      const qualityPlan = this.extractQualityPlan(job);
      const qualityLabel = qualityPlan.textureInputBoost === 'safe_384' ? 'Using 8082 Shape + Safe 384 Paint assist.' : 'Using 8082 Shape + proven Paint.';
      await this.progress(job, 11, 'References ready', `${views.length} reference views downloaded. ${qualityLabel}`);

      const mesh = await this.hunyuanService.generateShape({
        views,
        outputDir,
        progressCb: (value, stage, message) => this.progress(job, value, stage, message)
      });

      await this.hunyuanService.stopShapeBeforePaint(
        (value, stage, message) => this.progress(job, value, stage, message)
      );

      const finalGlb = await this.hunyuanService.runProvenPaint({
        mesh,
        views,
        outputDir,
        qualityPlan,
        progressCb: (value, stage, message) => this.progress(job, value, stage, message)
      });

      const validated = await validateGlb(finalGlb);
      await this.progress(job, 97, 'Validating final Hunyuan GLB', `SHA-256 ${validated.sha256.slice(0, 12)}…`);
      const result = await this.uploadResult(job, finalGlb, validated.sha256);
      this.processed += 1;
      this.log(`Known-good Hunyuan job ${job.uuid} completed.`);
      this.callbacks.onJob?.({ uuid: job.uuid, progress: 100, stage: 'Completed', result });
    } catch (error) {
      this.log(`Known-good Hunyuan job ${job.uuid} failed: ${error.message}`, 'error');
      await this.fail(job, error.message, 'Hunyuan known-good pipeline failed');
    } finally {
      if (!cfg.keep_temp) await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      this.busy = false;
      this.currentJob = null;
      this.emitStatus();
    }
  }
}

module.exports = { HunyuanNexaWorker };
