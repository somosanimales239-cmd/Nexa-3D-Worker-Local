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
  watchDir(id) { return path.join(this.packageDir(id), 'drop-result-here'); }
  notePath(id) { return path.join(this.packageDir(id), 'README-NEXA.txt'); }

  async importPackage(sourcePath) {
    return this.#importFromZip(path.resolve(String(sourcePath || '')), {
      sourceName: path.basename(String(sourcePath || '')),
      status: 'imported'
    });
  }

  async importRemotePackage(job, zipFile) {
    const row = await this.#importFromZip(path.resolve(String(zipFile || '')), {
      sourceName: String(job?.package_name || 'apply-package.zip'),
      status: 'processing',
      remote_dispatch_id: String(job?.dispatch_id || ''),
      remote_asset_id: Number(job?.asset_id || 0),
      remote_claim_token: String(job?.claim_token || ''),
      remote_asset_name: String(job?.asset_name || ''),
      remote_output_name: String(job?.output_name || ''),
      remote_version_name: String(job?.version_name || ''),
      remote_notes: String(job?.notes || ''),
      bridge_state: 'awaiting_result',
      uploaded_back_to_nexa: false
    });
    await this.writeInstructionNote(row.id, job);
    return this.get(row.id);
  }

  async #importFromZip(source, extra = {}) {
    if (!fileExists(source)) throw new Error('Apply Package ZIP was not found.');
    if (path.extname(source).toLowerCase() !== '.zip') throw new Error('Choose a ZIP Apply Package file.');
    const id = crypto.randomBytes(8).toString('hex');
    const folder = this.packageDir(id);
    const extract = this.extractDir(id);
    const watch = this.watchDir(id);
    await fsp.mkdir(folder, { recursive: true });
    await fsp.mkdir(watch, { recursive: true });
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
      source_name: String(extra.sourceName || path.basename(source)),
      imported_at: new Date().toISOString(),
      status: String(extra.status || 'imported'),
      zip_path: this.zipPath(id),
      package_folder: folder,
      extracted_folder: extractionOk ? extract : '',
      result_drop_folder: watch,
      extraction_ok: extractionOk,
      asset_name: extra.remote_asset_name || manifest?.asset?.name || manifest?.apply_job?.original_asset_name || 'Apply Package',
      output_name: extra.remote_output_name || manifest?.apply_job?.output_name || path.basename(source, '.zip'),
      version_name: extra.remote_version_name || manifest?.version?.name || manifest?.apply_job?.version_name || 'Current profile',
      refs_count: (Array.isArray(refs.material) ? refs.material.length : 0) + (Array.isArray(refs.design) ? refs.design.length : 0) + (Array.isArray(refs.render) ? refs.render.length : 0),
      brief,
      result_path: '',
      result_name: '',
      result_size: 0,
      remote_dispatch_id: String(extra.remote_dispatch_id || ''),
      remote_asset_id: Number(extra.remote_asset_id || 0),
      remote_claim_token: String(extra.remote_claim_token || ''),
      remote_notes: String(extra.remote_notes || ''),
      bridge_state: String(extra.bridge_state || ''),
      uploaded_back_to_nexa: Boolean(extra.uploaded_back_to_nexa)
    };
    const rows = this.readIndex();
    rows.unshift(row);
    this.writeIndex(rows);
    return row;
  }

  async writeInstructionNote(id, job = {}) {
    const lines = [
      'Nexa 3D Worker Local — Automatic Web ↔ Worker Bridge',
      '',
      `Dispatch ID: ${String(job.dispatch_id || '')}`,
      `Asset: ${String(job.asset_name || '')}`,
      `Output target: ${String(job.output_name || '')}`,
      '',
      'This Apply Package was downloaded automatically from Nexa 3D Studio.',
      'Work with the package locally, then place your finished GLB / GLTF / ZIP file inside this folder:',
      this.watchDir(id),
      '',
      'The worker watches that folder and uploads the first compatible finished file back to Nexa automatically.',
      'You do not need to import the package manually or upload the result manually.'
    ];
    await fsp.writeFile(this.notePath(id), lines.join('\r\n') + '\r\n', 'utf8');
  }

  extractZipWindows(zipFile, targetDir) {
    if (process.platform !== 'win32') return false;
    fs.mkdirSync(targetDir, { recursive: true });
    const command = `Expand-Archive -LiteralPath '${String(zipFile).replace(/'/g, "''")}' -DestinationPath '${String(targetDir).replace(/'/g, "''")}' -Force`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 300000 });
    return result.status === 0;
  }

  get(id) {
    return this.readIndex().find((x) => String(x.id) === String(id)) || null;
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
    found.bridge_state = found.remote_dispatch_id ? 'ready_to_upload' : found.bridge_state;
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

  updateRemoteState(id, patch = {}) {
    const rows = this.readIndex();
    const found = rows.find((x) => String(x.id) === String(id));
    if (!found) throw new Error('Apply package record not found.');
    Object.assign(found, patch, { updated_at: new Date().toISOString() });
    this.writeIndex(rows);
    return found;
  }

  pendingRemotePackages() {
    return this.list().filter((x) => x.remote_dispatch_id && !x.uploaded_back_to_nexa && String(x.status) !== 'failed');
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
