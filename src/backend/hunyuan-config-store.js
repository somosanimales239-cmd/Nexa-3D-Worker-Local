'use strict';
const fs = require('fs');
const { ConfigStore } = require('./config-store');

const HUNYUAN_PROVIDER = 'hunyuan3d_multiview_local';
const MIGRATION_KEY = 'exact_8082_provider_initialized';

class HunyuanConfigStore extends ConfigStore {
  constructor(userData, safeStorage) {
    super(userData, safeStorage);
    this.ensureExact8082Provider();
  }

  defaults() {
    return {
      ...super.defaults(),
      hunyuan3d_local_root: String(process.env.NEXA_HUNYUAN_ROOT || 'D:\\N3D\\hunyuan2mv'),
      hunyuan3d_local_python: String(process.env.NEXA_HUNYUAN_PYTHON || 'D:\\N3D\\hunyuan2mv\\.venv\\Scripts\\python.exe'),
      hunyuan3d_cache_dir: String(process.env.NEXA_HUNYUAN_CACHE || 'D:\\N3D\\HunyuanCache'),
      hunyuan3d_temp_dir: String(process.env.NEXA_HUNYUAN_TEMP || 'D:\\N3D\\temp')
    };
  }

  ensureExact8082Provider() {
    const current = this.readJson(this.configPath, {});
    const defaults = this.defaults();
    let changed = false;

    if (current[MIGRATION_KEY] !== true) {
      current.provider = HUNYUAN_PROVIDER;
      current[MIGRATION_KEY] = true;
      changed = true;
    }

    for (const key of [
      'hunyuan3d_local_root',
      'hunyuan3d_local_python',
      'hunyuan3d_cache_dir',
      'hunyuan3d_temp_dir'
    ]) {
      if (!String(current[key] || '').trim()) {
        current[key] = defaults[key];
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(this.configPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
    }
    return this.get();
  }

  save(input) {
    const current = this.get();
    const desiredProvider = String(input?.provider || current.provider || HUNYUAN_PROVIDER);
    const allowedProvider = ['stable_fast_3d', 'hunyuan3d_api', HUNYUAN_PROVIDER].includes(desiredProvider)
      ? desiredProvider
      : HUNYUAN_PROVIDER;

    const payload = { ...(input || {}), provider: allowedProvider === HUNYUAN_PROVIDER ? 'stable_fast_3d' : allowedProvider };
    super.save(payload);

    const publicConfig = this.readJson(this.configPath, {});
    publicConfig.provider = allowedProvider;
    publicConfig[MIGRATION_KEY] = true;

    const defaults = this.defaults();
    for (const key of [
      'hunyuan3d_local_root',
      'hunyuan3d_local_python',
      'hunyuan3d_cache_dir',
      'hunyuan3d_temp_dir'
    ]) {
      const supplied = Object.prototype.hasOwnProperty.call(input || {}, key)
        ? String(input[key] || '').trim()
        : '';
      publicConfig[key] = supplied || String(current[key] || '').trim() || defaults[key];
    }

    fs.writeFileSync(this.configPath, JSON.stringify(publicConfig, null, 2) + '\n', 'utf8');
    return this.get();
  }
}

module.exports = { HunyuanConfigStore, HUNYUAN_PROVIDER };
