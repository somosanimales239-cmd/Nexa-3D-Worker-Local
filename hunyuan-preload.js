'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function ensureHunyuanUi() {
  const provider = document.getElementById('provider');
  if (provider && !provider.querySelector('option[value="hunyuan3d_multiview_local"]')) {
    const option = document.createElement('option');
    option.value = 'hunyuan3d_multiview_local';
    option.textContent = 'Hunyuan3D 2mv — Shape-to-Paint handoff';
    provider.insertBefore(option, provider.firstChild);
  }
  const legacyStatus = document.getElementById('hunyuanStatus');
  const legacyCard = legacyStatus ? legacyStatus.closest('article') : null;
  if (legacyCard && !document.getElementById('hunyuanLocalStatus')) {
    const card = document.createElement('article');
    card.className = 'card engine-card';
    card.innerHTML = `
      <div class="engine-title"><div class="engine-logo alt">MV</div><div><span class="pill good">RECOMMENDED</span><h3>Hunyuan3D 2mv — Shape-to-Paint handoff</h3>
      <p>Worker 1.9 keeps the same local Hunyuan page/engine alive on 127.0.0.1:8082. Shape and Paint load once instead of once per job. Exact Shape preset: 30 steps, CFG 5.0, octree 256, chunks 8000. Paint uses original RGBA Front → Left → Back → Right with a Windows high-poly safety guard.</p></div></div>
      <div class="engine-status" id="hunyuanLocalStatus">Checking…</div>
      <div class="license-note"><b>Local paths</b><br>D:\\N3D\\hunyuan2mv<br>D:\\N3D\\hunyuan2mv\\.venv\\Scripts\\python.exe<br>D:\\N3D\\HunyuanCache<br>D:\\N3D\\temp</div>`;
    legacyCard.parentNode.insertBefore(card, legacyCard);
  }
  const version = document.querySelector('.version');
  if (version) version.textContent = 'v1.9.3 · Shape-to-Paint VRAM handoff';
}

function showProvider(config) {
  ensureHunyuanUi();
  if (config?.provider === 'hunyuan3d_multiview_local') {
    const provider = document.getElementById('provider');
    if (provider) provider.value = 'hunyuan3d_multiview_local';
    const metric = document.getElementById('metricEngine');
    const side = document.getElementById('sideProvider');
    if (metric) metric.textContent = 'Hunyuan MV Local';
    if (side) side.textContent = 'Hunyuan MV Local';
  }
}

function showProbe(result) {
  ensureHunyuanUi();
  const local = result?.hunyuan3d_multiview_local || {};
  const el = document.getElementById('hunyuanLocalStatus');
  if (el) {
    el.textContent = local.ready ? `Ready · ${local.detail || 'CUDA'}` : `Not ready · ${local.detail || 'Check local Hunyuan installation'}`;
    el.classList.toggle('ready', Boolean(local.ready));
  }
  const selected = document.getElementById('provider')?.value === 'hunyuan3d_multiview_local';
  if (selected) {
    const metric = document.getElementById('metricEngineReady');
    if (metric) metric.textContent = local.ready ? 'Native multi-view ready' : (local.detail || 'Hunyuan local not ready');
  }
}

document.addEventListener('DOMContentLoaded', ensureHunyuanUi);

contextBridge.exposeInMainWorld('nexa3d', {
  bootstrap: async () => { const data = await ipcRenderer.invoke('app:bootstrap'); setTimeout(() => showProvider(data?.config), 0); return data; },
  saveSettings: async (payload) => { const data = await ipcRenderer.invoke('settings:save', payload); setTimeout(() => showProvider(data?.config), 0); return data; },
  probeSystem: () => ipcRenderer.invoke('system:probe'),
  testConnection: () => ipcRenderer.invoke('connection:test'),
  startWorker: () => ipcRenderer.invoke('worker:start'),
  stopWorker: () => ipcRenderer.invoke('worker:stop'),
  runOnce: () => ipcRenderer.invoke('worker:once'),
  getWorkerStatus: () => ipcRenderer.invoke('worker:status'),
  installStableFast3D: () => ipcRenderer.invoke('engine:install-sf3d'),
  testHunyuan: () => ipcRenderer.invoke('engine:test-hunyuan'),
  probeEngines: async () => { const data = await ipcRenderer.invoke('engine:probe'); setTimeout(() => showProbe(data), 0); return data; },
  testGeneration: (payload) => ipcRenderer.invoke('engine:test-generation', payload),
  probeBlender: () => ipcRenderer.invoke('engine:probe-blender'),
  pickExecutable: () => ipcRenderer.invoke('file:pick-exe'),
  pickImage: () => ipcRenderer.invoke('file:pick-image'),
  pickApplyZip: () => ipcRenderer.invoke('file:pick-apply-zip'),
  pickResultFile: () => ipcRenderer.invoke('file:pick-result'),
  pickFolder: () => ipcRenderer.invoke('file:pick-folder'),
  revealPath: (target) => ipcRenderer.invoke('path:reveal', target),
  openPath: (target) => ipcRenderer.invoke('path:open', target),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  listApplyPackages: () => ipcRenderer.invoke('apply:list'),
  importApplyPackage: (payload) => ipcRenderer.invoke('apply:import', payload),
  setApplyStatus: (payload) => ipcRenderer.invoke('apply:set-status', payload),
  attachApplyResult: (payload) => ipcRenderer.invoke('apply:attach-result', payload),
  deleteApplyPackage: (payload) => ipcRenderer.invoke('apply:delete', payload),
  onWorkerStatus: (callback) => ipcRenderer.on('worker:status-changed', (_e, payload) => callback(payload)),
  onWorkerLog: (callback) => ipcRenderer.on('worker:log', (_e, payload) => callback(payload)),
  onEngineLog: (callback) => ipcRenderer.on('engine:log', (_e, payload) => callback(payload)),
  onJob: (callback) => ipcRenderer.on('worker:job', (_e, payload) => callback(payload))
});
