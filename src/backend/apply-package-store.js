"use strict";
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function fileExists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function dirExists(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }
function safeName(value) {
  const input = String(value || 'package');
  let output = '';
  for (const char of input) {
    const code = char.charCodeAt(0);
    const alphaNum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const allowed = alphaNum || char === '.' || char === '_' || char === '-';
    if (allowed) output += char;
    else if (!output.endsWith('-')) output += '-';
  }
  while (output.startsWith('.') || output.startsWith('-')) output = output.slice(1);
  while (output.endsWith('-')) output = output.slice(0, -1);
  return output.slice(0, 100) || 'package';
}

class ApplyPackageStore {
  constructor(userData) {
    this.rootDir = path.join(userData, 'apply-packages');
    this.indexFile = path.join(this.rootDir, 'packages.json');
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  readIndex() {
    try {
      if (!fileExists(this.indexFile)) return [];
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  writeIndex(rows) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(this.indexFile, JSON.stringify(Array.isArray(rows) ? rows : [], null, 2) + '\n', 'utf8');
  }

  list() {
    const rows = this.readIndex();
    rows.sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')));
    return rows;
  }

  packageDir(id) { return path.join(this.rootDir, String(id)); }
  zipPath(id) { return path.join(this.packageDir(id), 'apply-package.zip'); }
  extractDir(id) { return path.join(this.packageDir(id), 'extracted'); }
  resultDir(id) { return path.join(this.packageDir(id), 'result'); }

  async importPackage(sourcePath) {
    const source = path.resolve(String(sourcePath || ''));
    if (!fileExists(source)) throw new Error('Apply Package ZIP was not found.');
    if (path.extname(source).toLowerCase() !== '.zip') throw new Error('Choose a ZIP Apply Package file.');
    const id = crypto.randomBytes(8).toString('hex');
    const folder = this.packageDir(id);
    const extract = this.extractDir(id);
    await fsp.mkdir(folder, { recursive: true });
    await fsp.copyFile(source, this.zipPath(id));
    let extractionOk = false;
    let manifest = null;
    let brief = '';
    try {
      extractionOk = this.extractZipWindows(this.zipPath(id), extract);
      if (extractionOk && fileExists(path.join(extract, 'manifest.json'))) {
        manifest = JSON.parse(await fsp.readFile(path.join(extract, 'manifest.json'), 'utf8'));
      }
      if (extractionOk && fileExists(path.join(extract, 'enhancement-brief.txt'))) {
        brief = String(await fsp.readFile(path.join(extract, 'enhancement-brief.txt'), 'utf8')).slice(0, 4000);
      }
    } catch {}
    const refs = manifest?.snapshot?.references || {};
    const row = {
      id,
      source_name: path.basename(source),
      imported_at: new Date().toISOString(),
      status: 'imported',
      zip_path: this.zipPath(id),
      package_folder: folder,
      extracted_folder: extractionOk ? extract : '',
      extraction_ok: extractionOk,
      asset_name: manifest?.asset?.name || manifest?.apply_job?.original_asset_name || 'Apply Package',
      output_name: manifest?.apply_job?.output_name || path.basename(source, '.zip'),
      version_name: manifest?.version?.name || manifest?.apply_job?.version_name || 'Current profile',
      refs_count: (Array.isArray(refs.material) ? refs.material.length : 0) + (Array.isArray(refs.design) ? refs.design.length : 0) + (Array.isArray(refs.render) ? refs.render.length : 0),
      brief,
      result_path: '',
      result_name: '',
      result_size: 0
    };
    const rows = this.readIndex();
    rows.unshift(row);
    this.writeIndex(rows);
    return row;
  }

  extractZipWindows(zipFile, targetDir) {
    if (process.platform !== 'win32') return false;
    fs.mkdirSync(targetDir, { recursive: true });
    const command = `Expand-Archive -LiteralPath '${String(zipFile).replace(/'/g, "''")}' -DestinationPath '${String(targetDir).replace(/'/g, "''")}' -Force`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 300000 });
    return result.status === 0;
  }

  attachResult(id, sourcePath) {
    const source = path.resolve(String(sourcePath || ''));
    if (!fileExists(source)) throw new Error('Result file was not found.');
    const ext = path.extname(source).toLowerCase();
    if (!['.glb', '.gltf', '.zip'].includes(ext)) throw new Error('Result file must be GLB, GLTF or ZIP.');
    const rows = this.readIndex();
    const found = rows.find((x) => String(x.id) === String(id));
    if (!found) throw new Error('Apply package record not found.');
    fs.mkdirSync(this.resultDir(id), { recursive: true });
    const target = path.join(this.resultDir(id), safeName(path.basename(source, ext)) + ext);
    fs.copyFileSync(source, target);
    const stat = fs.statSync(target);
    found.status = 'completed';
    found.result_path = target;
    found.result_name = path.basename(target);
    found.result_size = stat.size;
    found.updated_at = new Date().toISOString();
    this.writeIndex(rows);
    return found;
  }

  setStatus(id, status) {
    const allowed = ['imported', 'processing', 'completed', 'failed'];
    if (!allowed.includes(String(status))) throw new Error('Invalid status.');
    const rows = this.readIndex();
    const found = rows.find((x) => String(x.id) === String(id));
    if (!found) throw new Error('Apply package record not found.');
    found.status = String(status);
    found.updated_at = new Date().toISOString();
    this.writeIndex(rows);
    return found;
  }

  deletePackage(id) {
    const rows = this.readIndex();
    const next = rows.filter((x) => String(x.id) !== String(id));
    if (next.length === rows.length) throw new Error('Apply package record not found.');
    this.writeIndex(next);
    this.deleteTree(this.packageDir(id));
    return { ok: true };
  }

  deleteTree(target) {
    if (!dirExists(target)) return;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) this.deleteTree(full);
      else { try { fs.unlinkSync(full); } catch {} }
    }
    try { fs.rmdirSync(target); } catch {}
  }
}

module.exports = { ApplyPackageStore };
