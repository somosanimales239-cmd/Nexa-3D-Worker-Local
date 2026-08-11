'use strict';
const path = require('path');
const { QuickTextureBridge } = require('../src/backend/quick-texture-bridge');

const bridge = new QuickTextureBridge({
  baseUrl: process.env.NEXA_QUICK_TEXTURE_BASE_URL || 'https://your-site.com/api/3d/',
  workerToken: process.env.NEXA_QUICK_TEXTURE_WORKER_TOKEN || '',
  workerId: process.env.NEXA_QUICK_TEXTURE_WORKER_ID || 'nexa-quick-texture-worker-local',
  blenderPath: process.env.NEXA_BLENDER_PATH || '',
  pollSeconds: Number(process.env.NEXA_QUICK_TEXTURE_POLL_SECONDS || 10),
  workRoot: process.env.NEXA_QUICK_TEXTURE_WORK_ROOT || path.join(process.cwd(), 'quick-texture-work'),
  onLog: (line) => console.log(line)
});

if (!process.env.NEXA_QUICK_TEXTURE_WORKER_TOKEN) {
  console.error('Missing NEXA_QUICK_TEXTURE_WORKER_TOKEN.');
  process.exit(1);
}

bridge.loop().catch((error) => {
  console.error(error);
  process.exit(1);
});
