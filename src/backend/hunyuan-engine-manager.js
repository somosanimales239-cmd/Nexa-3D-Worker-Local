'use strict';
const fs = require('fs');
const path = require('path');
const { EngineManager } = require('./engine-manager');

class HunyuanEngineManager extends EngineManager {
  async probeEngines() {
    const result = await super.probeEngines();
    const cfg = this.store.get();
    const root = path.resolve(String(cfg.hunyuan3d_local_root || ''));
    const python = path.resolve(String(cfg.hunyuan3d_local_python || ''));
    const local = {
      root,
      python,
      repo_ready: fs.existsSync(path.join(root, 'gradio_app.py')) && fs.existsSync(path.join(root, 'hy3dgen')),
      venv_ready: fs.existsSync(python),
      ready: false,
      detail: 'Not checked'
    };
    if (!local.repo_ready) local.detail = `Hunyuan folder not found: ${root}`;
    else if (!local.venv_ready) local.detail = `Hunyuan Python not found: ${python}`;
    else {
      try {
        const verify = await this.runCapture(python, ['-c', 'import torch; import custom_rasterizer; import mesh_processor; from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline; from hy3dgen.texgen import Hunyuan3DPaintPipeline; print("NEXA_CUDA="+str(torch.cuda.is_available())); print("NEXA_GPU="+(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"))'], { cwd: root });
        local.ready = verify.includes('NEXA_CUDA=True');
        const gpu = verify.split(/\\r?\\n/).find((x) => x.startsWith('NEXA_GPU='));
        local.detail = local.ready ? `CUDA ready · ${(gpu || '').replace('NEXA_GPU=', '')}` : 'Python imports work, but CUDA is unavailable.';
      } catch (error) { local.detail = error.message; }
    }
    return { ...result, hunyuan3d_multiview_local: local };
  }
}

module.exports = { HunyuanEngineManager };
