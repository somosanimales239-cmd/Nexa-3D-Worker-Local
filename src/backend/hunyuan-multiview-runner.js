'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

function fileExists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function dirExists(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }

function packagedScriptPath() {
  let script = path.join(__dirname, '..', '..', 'scripts', 'hunyuan_multiview_worker.py');
  if (script.includes('app.asar')) script = script.replace('app.asar', 'app.asar.unpacked');
  return script;
}

async function runHunyuanMultiview({
  cfg,
  views,
  outputDir,
  payload = {},
  progressCb = async () => {},
  onLog = () => {},
  onChild = () => {}
}) {
  const root = path.resolve(String(cfg.hunyuan3d_local_root || ''));
  const python = path.resolve(String(cfg.hunyuan3d_local_python || ''));
  const script = packagedScriptPath();

  if (!dirExists(root) || !fileExists(path.join(root, 'gradio_app.py'))) {
    throw new Error(`Hunyuan3D-2mv folder is not ready: ${root}`);
  }
  if (!fileExists(python)) throw new Error(`Hunyuan3D Python was not found: ${python}`);
  if (!fileExists(script)) throw new Error(`Nexa Hunyuan 8082 bridge script is missing: ${script}`);

  const byName = new Map(
    (Array.isArray(views) ? views : []).map(v => [String(v.name || '').toLowerCase(), v.file])
  );
  const front = byName.get('front');
  if (!front || !fileExists(front)) {
    throw new Error('Hunyuan 8082 parity generation requires a Front reference.');
  }

  await fsp.mkdir(outputDir, { recursive: true });

  const args = [
    script,
    '--hunyuan-root', root,
    '--output-dir', outputDir,
    '--front', front
  ];

  for (const name of ['back', 'left', 'right']) {
    const file = byName.get(name);
    if (file && fileExists(file)) args.push(`--${name}`, file);
  }

  if (payload?.generate_textures === false) args.push('--shape-only');
  if (cfg.hunyuan3d_cache_dir) {
    args.push('--cache-dir', path.resolve(String(cfg.hunyuan3d_cache_dir)));
  }
  if (cfg.hunyuan3d_temp_dir) {
    args.push('--temp-dir', path.resolve(String(cfg.hunyuan3d_temp_dir)));
  }

  await progressCb(
    11,
    'Starting exact 8082 Hunyuan flow',
    'Shape preset: 30 steps · CFG 5.0 · octree 256 · chunks 8000 · Remove Background ON · Randomize Seed ON.'
  );

  const env = { ...process.env };
  if (cfg.hf_token) env.HF_TOKEN = cfg.hf_token;

  return await new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: root,
      env,
      windowsHide: true,
      shell: false
    });
    onChild(child);

    let tail = [];
    let resultPath = '';

    const capture = (chunk) => {
      for (const raw of String(chunk || '').replaceAll('\r', '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;

        tail.push(line);
        tail = tail.slice(-100);
        onLog(line);

        if (line.startsWith('NEXA_PROGRESS|')) {
          const parts = line.split('|');
          const progress = Math.max(0, Math.min(99, Number(parts[1]) || 0));
          const stage = parts[2] || 'Hunyuan3D';
          const message = parts.slice(3).join('|') || stage;
          progressCb(progress, stage, message).catch(() => {});
        } else if (line.startsWith('NEXA_RESULT|')) {
          resultPath = line.slice('NEXA_RESULT|'.length).trim();
        }
      }
    };

    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', reject);
    child.on('close', (code) => {
      onChild(null);
      if (code !== 0) {
        return reject(new Error(
          `Hunyuan 8082 parity flow exited with code ${code}.\n${tail.slice(-24).join('\n')}`
        ));
      }

      const candidate = resultPath || path.join(
        outputDir,
        payload?.generate_textures === false ? 'white_mesh.glb' : 'final.glb'
      );

      if (!fileExists(candidate)) {
        return reject(new Error(
          `Hunyuan completed but the expected GLB was not found: ${candidate}`
        ));
      }
      resolve(candidate);
    });
  });
}

module.exports = { runHunyuanMultiview };
