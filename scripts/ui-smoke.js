'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const electronPath = require('electron');
if (typeof electronPath !== 'string' || electronPath.trim() === '') {
  throw new TypeError('Electron executable path was not resolved. Run this smoke harness with Node, not Electron.');
}

const root = path.resolve(__dirname, '..');
const marker = path.join(root, 'artifacts', 'ui-smoke-ok.json');
fs.rmSync(marker, { force: true });
fs.mkdirSync(path.dirname(marker), { recursive: true });

let settled = false;
const child = spawn(electronPath, [root, '--nexa-ui-smoke'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});

function fail(message, code = 1) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.error(message);
  process.exit(code);
}

const timer = setTimeout(() => {
  try { child.kill(); } catch {}
  fail('UI smoke timed out.', 1);
}, 30000);

child.on('error', (error) => {
  fail(`Electron smoke could not start: ${error.message}`, 1);
});

child.on('exit', (code, signal) => {
  if (settled) return;
  clearTimeout(timer);
  if (code !== 0) {
    return fail(`Electron smoke exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}.`, code || 1);
  }
  if (!fs.existsSync(marker)) return fail('UI smoke marker was not created.', 1);
  const data = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (!data.ok || data.title !== 'Nexa 3D Worker Local') return fail('Invalid UI smoke result.', 1);
  settled = true;
  console.log('UI smoke PASS — Nexa 3D Worker Local window loaded.');
});
