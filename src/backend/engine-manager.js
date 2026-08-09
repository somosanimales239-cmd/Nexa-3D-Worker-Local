'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { probeSystem } = require('./system-probe');

function splitLines(value) {
  return String(value || '').replaceAll('\r', '').split('\n');
}

function trimTrailingSlashes(value) {
  let text = String(value || '');
  while (text.endsWith('/')) text = text.slice(0, -1);
  return text;
}

function isHttpUrl(value) {
  const text = String(value || '').toLowerCase();
  return text.startsWith('http://') || text.startsWith('https://');
}

class EngineManager {
  constructor(store, onLog = () => {}) {
    this.store = store;
    this.onLog = onLog;
    this.installing = false;
  }

  log(message) {
    this.onLog(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  async run(command, args, options = {}) {
    this.log(`> ${path.basename(command)} ${args.join(' ')}`);
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd || undefined,
        env: options.env || process.env,
        windowsHide: true,
        shell: false
      });
      let tail = [];
      const capture = (data) => {
        const text = String(data || '');
        for (const line of splitLines(text)) {
          if (!line.trim()) continue;
          tail.push(line);
          tail = tail.slice(-40);
          this.log(line);
        }
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true, code, tail });
        else reject(new Error(`${path.basename(command)} exited with code ${code}.\n${tail.slice(-12).join('\n')}`));
      });
    });
  }

  async probeEngines() {
    const cfg = this.store.get();
    const system = await probeSystem();
    const repo = path.resolve(cfg.stable_fast_3d_repo);
    const py = path.resolve(cfg.stable_fast_3d_python);
    const sf3d = {
      repo,
      repo_ready: fs.existsSync(path.join(repo, 'run.py')),
      python: py,
      venv_ready: fs.existsSync(py),
      torch: null
    };
    if (sf3d.venv_ready) {
      try {
        const result = await this.runCapture(py, ['-c', 'import torch;print(torch.__version__);print(torch.cuda.is_available());print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU")']);
        const lines = splitLines(result).filter(Boolean);
        sf3d.torch = { version: lines[0] || '', cuda: lines[1] === 'True', device: lines[2] || '' };
      } catch (error) {
        sf3d.torch = { error: error.message };
      }
    }
    let hunyuan = { url: cfg.hunyuan3d_api_url, reachable: false, detail: 'Not tested' };
    try { hunyuan = await this.testHunyuan(); } catch (error) { hunyuan.detail = error.message; }
    return { system, stable_fast_3d: sf3d, hunyuan3d_api: hunyuan };
  }

  async runCapture(command, args, options = {}) {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd || undefined, env: options.env || process.env, windowsHide: true, shell: false });
      let stdout = '', stderr = '';
      child.stdout?.on('data', (d) => stdout += d);
      child.stderr?.on('data', (d) => stderr += d);
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr || stdout || `Exit ${code}`).trim())));
    });
  }

  async installStableFast3D() {
    if (this.installing) throw new Error('Stable Fast 3D installation is already running.');
    this.installing = true;
    try {
      const cfg = this.store.get();
      const system = await probeSystem();
      if (!system.python.found) throw new Error('Python was not detected. Install Python 3.10 or 3.11 for the most compatible Windows setup, then run this installer again.');
      if (!system.git.found) throw new Error('Git was not detected. Install Git for Windows, then run this installer again.');
      const repo = path.resolve(cfg.stable_fast_3d_repo);
      const venvPython = path.resolve(cfg.stable_fast_3d_python);
      fs.mkdirSync(path.dirname(repo), { recursive: true });
      this.log('Preparing Stable Fast 3D local engine. This can take a long time because PyTorch and 3D dependencies are large.');
      if (!fs.existsSync(path.join(repo, 'run.py'))) {
        if (fs.existsSync(repo) && fs.readdirSync(repo).length) throw new Error(`Engine folder exists but is not a Stable Fast 3D repository: ${repo}`);
        await this.run('git', ['clone', '--depth', '1', 'https://github.com/Stability-AI/stable-fast-3d.git', repo]);
      } else {
        this.log('Stable Fast 3D source already exists; source was not overwritten.');
      }
      if (!fs.existsSync(venvPython)) {
        fs.mkdirSync(path.dirname(venvPython), { recursive: true });
        await this.run(system.python.executable, ['-m', 'venv', path.dirname(path.dirname(venvPython))]);
      } else {
        this.log('Existing Stable Fast 3D Python environment detected.');
      }
      await this.run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
      await this.run(venvPython, ['-m', 'pip', 'install', 'setuptools==69.5.1', 'wheel']);
      try {
        await this.runCapture(venvPython, ['-c', 'import torch;print(torch.__version__)']);
        this.log('PyTorch is already installed.');
      } catch {
        this.log('Installing PyTorch using the default pip package. If CUDA is not detected afterwards, use the official PyTorch CUDA command for this PC and run Repair again.');
        await this.run(venvPython, ['-m', 'pip', 'install', 'torch', 'torchvision']);
      }
      await this.run(venvPython, ['-m', 'pip', 'install', '-r', path.join(repo, 'requirements.txt')], { cwd: repo });
      const verify = await this.runCapture(venvPython, ['-c', 'import torch;print(torch.__version__);print("cuda="+str(torch.cuda.is_available()));print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU")']);
      this.log(`Engine verification:\n${verify}`);
      this.log('Stable Fast 3D source and Python environment are ready. Model access on Hugging Face is still required before first generation.');
      return { ok: true, repo, python: venvPython, verification: verify };
    } finally {
      this.installing = false;
    }
  }

  async testHunyuan() {
    const cfg = this.store.get();
    const base = trimTrailingSlashes(cfg.hunyuan3d_api_url);
    if (!isHttpUrl(base)) throw new Error('Hunyuan3D API URL is invalid.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      let response = await fetch(`${base}/health`, { signal: controller.signal });
      if (response.ok) return { url: base, reachable: true, detail: `Health endpoint HTTP ${response.status}` };
      response = await fetch(`${base}/docs`, { signal: controller.signal });
      if (response.ok) return { url: base, reachable: true, detail: `API docs reachable HTTP ${response.status}` };
      throw new Error(`Hunyuan3D server responded but health/docs were unavailable (HTTP ${response.status}).`);
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { EngineManager };
