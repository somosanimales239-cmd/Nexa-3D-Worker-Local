'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { ConfigStore } = require('./src/backend/config-store');
const { probeSystem } = require('./src/backend/system-probe');
const { EngineManager } = require('./src/backend/engine-manager');
const { NexaWorker } = require('./src/backend/nexa-worker');

let mainWindow = null;
let store = null;
let worker = null;
let engines = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#080b12',
    title: 'Nexa 3D Worker Local',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (process.argv.includes('--nexa-ui-smoke')) {
    mainWindow.webContents.once('did-finish-load', () => {
      const out = path.join(__dirname, 'artifacts');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'ui-smoke-ok.json'), JSON.stringify({ ok: true, title: 'Nexa 3D Worker Local', at: new Date().toISOString() }, null, 2));
      setTimeout(() => app.quit(), 500);
    });
  }
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', async () => ({
    config: store.getPublicConfig(),
    worker: worker.status(),
    system: await probeSystem(),
    paths: store.paths()
  }));

  ipcMain.handle('settings:save', async (_event, payload) => {
    store.save(payload || {});
    worker.reloadConfig();
    return { ok: true, config: store.getPublicConfig() };
  });

  ipcMain.handle('system:probe', async () => ({ ok: true, system: await probeSystem() }));
  ipcMain.handle('connection:test', async () => worker.testConnection());
  ipcMain.handle('worker:start', async () => worker.start());
  ipcMain.handle('worker:stop', async () => worker.stop());
  ipcMain.handle('worker:once', async () => worker.runOnce());
  ipcMain.handle('worker:status', async () => worker.status());

  ipcMain.handle('engine:install-sf3d', async () => engines.installStableFast3D());
  ipcMain.handle('engine:test-hunyuan', async () => engines.testHunyuan());
  ipcMain.handle('engine:probe', async () => engines.probeEngines());
  ipcMain.handle('engine:test-generation', async (_event, payload) => worker.generateLocalTest(payload || {}));

  ipcMain.handle('file:pick-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an image for local 3D test',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('file:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('path:reveal', async (_event, target) => {
    if (!target) return { ok: false };
    shell.showItemInFolder(String(target));
    return { ok: true };
  });
  ipcMain.handle('path:open', async (_event, target) => {
    if (!target) return { ok: false };
    await shell.openPath(String(target));
    return { ok: true };
  });
  ipcMain.handle('external:open', async (_event, url) => {
    const value = String(url || '');
    if (!value.toLowerCase().startsWith('https://')) throw new Error('Only HTTPS links are allowed.');
    await shell.openExternal(value);
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  store = new ConfigStore(app.getPath('userData'), safeStorage);
  engines = new EngineManager(store, (line) => send('engine:log', line));
  worker = new NexaWorker(store, engines, {
    onStatus: (status) => send('worker:status-changed', status),
    onLog: (line) => send('worker:log', line),
    onJob: (job) => send('worker:job', job)
  });
  registerIpc();
  createWindow();
  if (!process.argv.includes('--nexa-ui-smoke') && store.get().auto_start) {
    setTimeout(() => worker.start().catch(() => {}), 1200);
  }
});

app.on('window-all-closed', async () => {
  if (worker) await worker.stop().catch(() => {});
  app.quit();
});
