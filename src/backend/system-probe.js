'use strict';
const os = require('os');
const { spawnSync } = require('child_process');

function run(command, args = []) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (result.status === 0) return String(result.stdout || result.stderr || '').trim();
  } catch {}
  return '';
}

function findPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3.11', '--version']], ['py', ['-3', '--version']], ['python', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]];
  for (const [cmd, args] of candidates) {
    const version = run(cmd, args);
    if (version) {
      let executable = cmd;
      if (cmd === 'py') {
        const launcherArgs = args[0] === '-3.11' ? ['-3.11', '-c', 'import sys;print(sys.executable)'] : ['-3', '-c', 'import sys;print(sys.executable)'];
        executable = run('py', launcherArgs) || 'py';
      } else {
        executable = run(cmd, ['-c', 'import sys;print(sys.executable)']) || cmd;
      }
      return { found: true, version, executable };
    }
  }
  return { found: false, version: '', executable: '' };
}

function findGit() {
  const version = run('git', ['--version']);
  return { found: Boolean(version), version };
}

function findGpu() {
  const raw = run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!raw) return { found: false, devices: [] };
  const devices = raw.split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split(',').map((v) => v.trim());
    return { name: parts[0] || 'NVIDIA GPU', memory_mb: Number(parts[1]) || 0, driver: parts[2] || '' };
  });
  return { found: devices.length > 0, devices };
}

async function probeSystem() {
  const [python, git, gpu] = [findPython(), findGit(), findGpu()];
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cpu: os.cpus()[0]?.model || 'Unknown CPU',
    cpu_threads: os.cpus().length,
    memory_gb: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    python,
    git,
    gpu
  };
}

module.exports = { probeSystem, findPython, findGit, findGpu, run };
