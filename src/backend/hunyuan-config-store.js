'use strict';
const fs = require('fs');
const path = require('path');
const { ConfigStore } = require('./config-store');

class HunyuanConfigStore extends ConfigStore {
  defaults() {
    return {
      ...super.defaults(),
      hunyuan3d_local_root: String(process.env.NEXA_HUNYUAN_ROOT || 'D:\\N3D\\hunyuan2mv'),
      hunyuan3d_local_python: String(process.env.NEXA_HUNYUAN_PYTHON || 'D:\\N3D\\hunyuan2mv\\.venv\\Scripts\\python.exe'),
      hunyuan3d_cache_dir: String(process.env.NEXA_HUNYUAN_CACHE || 'D:\\N3D\\HunyuanCache'),
      hunyuan3d_temp_dir: String(process.env.NEXA_HUNYUAN_TEMP || 'D:\\N3D\\temp')
    };
  }

  save(input) {
    const desiredProvider = String(input?.provider || this.get().provider || 'stable_fast_3d');
    const payload = { ...(input || {}) };
    if (desiredProvider === 'hunyuan3d_multiview_local') payload.provider = 'stable_fast_3d';
    super.save(payload);
    if (desiredProvider === 'hunyuan3d_multiview_local') {
      const publicConfig = this.readJson(this.configPath, {});
      publicConfig.provider = desiredProvider;
      fs.writeFileSync(this.configPath, JSON.stringify(publicConfig, null, 2) + '\n', 'utf8');
    }
    return this.get();
  }
}

module.exports = { HunyuanConfigStore };
