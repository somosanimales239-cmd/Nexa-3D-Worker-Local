'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

class ConfigStore {
  constructor(userData, safeStorage) {
    this.userData = userData;
    this.safeStorage = safeStorage;
    this.configPath = path.join(userData, 'config.json');
    this.secretsPath = path.join(userData, 'secrets.json');
    this.logDir = path.join(userData, 'logs');
    this.workDir = path.join(userData, 'work');
    this.engineRoot = path.join(userData, 'engines');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.mkdirSync(this.engineRoot, { recursive: true });
  }

  defaults() {
    const sf3dRoot = path.join(this.engineRoot, 'stable-fast-3d');
    const inheritedHfHome = String(process.env.HF_HOME || '').trim();
    const inheritedHubCache = String(process.env.HF_HUB_CACHE || '').trim();
    const hfCacheDir = inheritedHfHome || (inheritedHubCache ? path.dirname(inheritedHubCache) : '');
    return {
      nexa_api_base: '',
      provider: 'stable_fast_3d',
      worker_id: `${os.hostname()}-nexa3d`.slice(0, 100),
      poll_seconds: 10,
      http_timeout_seconds: 120,
      provider_timeout_seconds: 3600,
      auto_start: false,
      keep_temp: false,
      force_cpu: false,
      stable_fast_3d_repo: sf3dRoot,
      stable_fast_3d_python: path.join(sf3dRoot, '.venv', 'Scripts', 'python.exe'),
      hf_cache_dir: hfCacheDir,
      hunyuan3d_api_url: 'http://127.0.0.1:8080',
      worker_token: '',
      hf_token: ''
    };
  }

  readJson(file, fallback = {}) {
    try {
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  decrypt(value) {
    if (!value) return '';
    try {
      if (value.mode === 'safeStorage' && this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
        return this.safeStorage.decryptString(Buffer.from(value.value, 'base64'));
      }
      if (value.mode === 'plain') return String(value.value || '');
    } catch {}
    return '';
  }

  encrypt(value) {
    const text = String(value || '');
    if (!text) return null;
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      return { mode: 'safeStorage', value: this.safeStorage.encryptString(text).toString('base64') };
    }
    return { mode: 'plain', value: text };
  }

  get() {
    const base = { ...this.defaults(), ...this.readJson(this.configPath, {}) };
    const secrets = this.readJson(this.secretsPath, {});
    base.worker_token = this.decrypt(secrets.worker_token);
    base.hf_token = this.decrypt(secrets.hf_token);
    return base;
  }

  getPublicConfig() {
    const cfg = this.get();
    return {
      ...cfg,
      worker_token: cfg.worker_token ? '••••••••••••••••' : '',
      hf_token: cfg.hf_token ? '••••••••••••••••' : '',
      has_worker_token: Boolean(cfg.worker_token),
      has_hf_token: Boolean(cfg.hf_token)
    };
  }

  save(input) {
    const current = this.get();
    const next = { ...current };
    const keys = [
      'nexa_api_base', 'provider', 'worker_id', 'poll_seconds', 'http_timeout_seconds',
      'provider_timeout_seconds', 'auto_start', 'keep_temp', 'force_cpu',
      'stable_fast_3d_repo', 'stable_fast_3d_python', 'hf_cache_dir', 'hunyuan3d_api_url'
    ];
    for (const key of keys) if (Object.prototype.hasOwnProperty.call(input, key)) next[key] = input[key];
    next.poll_seconds = Math.max(5, Number(next.poll_seconds) || 10);
    next.http_timeout_seconds = Math.max(10, Number(next.http_timeout_seconds) || 120);
    next.provider_timeout_seconds = Math.max(60, Number(next.provider_timeout_seconds) || 3600);
    next.provider = ['stable_fast_3d', 'hunyuan3d_api'].includes(next.provider) ? next.provider : 'stable_fast_3d';
    next.nexa_api_base = String(next.nexa_api_base || '').trim();
    next.worker_id = String(next.worker_id || this.defaults().worker_id).trim().slice(0, 100);
    next.hf_cache_dir = String(next.hf_cache_dir || '').trim();

    const publicConfig = { ...next };
    delete publicConfig.worker_token;
    delete publicConfig.hf_token;
    fs.writeFileSync(this.configPath, JSON.stringify(publicConfig, null, 2) + '\n', 'utf8');

    const currentSecrets = this.readJson(this.secretsPath, {});
    if (Object.prototype.hasOwnProperty.call(input, 'worker_token') && input.worker_token && !String(input.worker_token).startsWith('••')) {
      currentSecrets.worker_token = this.encrypt(input.worker_token);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'hf_token') && input.hf_token && !String(input.hf_token).startsWith('••')) {
      currentSecrets.hf_token = this.encrypt(input.hf_token);
    }
    if (input.clear_worker_token) delete currentSecrets.worker_token;
    if (input.clear_hf_token) delete currentSecrets.hf_token;
    fs.writeFileSync(this.secretsPath, JSON.stringify(currentSecrets, null, 2) + '\n', 'utf8');
    return this.get();
  }

  paths() {
    return {
      userData: this.userData,
      config: this.configPath,
      logs: this.logDir,
      work: this.workDir,
      engines: this.engineRoot
    };
  }
}

module.exports = { ConfigStore };
