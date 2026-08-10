'use strict';
const $ = (id) => document.getElementById(id);
const state = { config: {}, system: null, worker: null, paths: {}, testFile: '', logs: [], engineLogs: [] };

const pageTitles = { dashboard:'Worker Dashboard', connection:'Nexa Connection', engine:'Engine Setup', test:'Local Image → 3D Test', logs:'Activity & Logs', settings:'Settings' };

function toast(message, type='good') {
  const el=$('toast'); el.textContent=message; el.className=`toast ${type}`; clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.add('hidden'),4200);
}
function setPage(page){
  document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
  document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.dataset.pagePanel===page));
  $('pageTitle').textContent=pageTitles[page]||'Nexa 3D Worker Local';
}
function statusDot(el, good, warn=false){el.className=good?'good':warn?'warn':''}
function formatDate(value){if(!value)return 'No heartbeat yet';try{return new Date(value).toLocaleTimeString()}catch{return value}}
function appendWorkerLog(entry){
  const line=typeof entry==='string'?entry:entry.line; state.logs.push(line); state.logs=state.logs.slice(-800); $('workerLog').textContent=state.logs.join('\n'); $('workerLog').scrollTop=$('workerLog').scrollHeight;
}
function appendEngineLog(line){state.engineLogs.push(line);state.engineLogs=state.engineLogs.slice(-800);$('engineLog').textContent=state.engineLogs.join('\n');$('engineLog').scrollTop=$('engineLog').scrollHeight}

function fillConfig(cfg){
  state.config=cfg;
  $('nexaApiBase').value=cfg.nexa_api_base||''; $('workerToken').value=cfg.has_worker_token?'••••••••••••••••':''; $('workerId').value=cfg.worker_id||''; $('provider').value=cfg.provider||'stable_fast_3d';
  $('sf3dRepo').value=cfg.stable_fast_3d_repo||''; $('sf3dPython').value=cfg.stable_fast_3d_python||''; $('hfCacheDir').value=cfg.hf_cache_dir||''; $('hfToken').value=cfg.has_hf_token?'••••••••••••••••':''; $('hunyuanUrl').value=cfg.hunyuan3d_api_url||'';
  $('forceCpu').checked=Boolean(cfg.force_cpu); $('pollSeconds').value=cfg.poll_seconds||10; $('httpTimeout').value=cfg.http_timeout_seconds||120; $('providerTimeout').value=cfg.provider_timeout_seconds||3600; $('autoStart').checked=Boolean(cfg.auto_start); $('keepTemp').checked=Boolean(cfg.keep_temp);
  $('metricEngine').textContent=cfg.provider==='hunyuan3d_api'?'Hunyuan3D API':'Stable Fast 3D'; $('sideProvider').textContent=$('metricEngine').textContent;
}
function renderSystem(system){
  state.system=system; const py=system.python||{},git=system.git||{},gpu=system.gpu||{};
  statusDot($('checkPython'),py.found); $('pythonDetail').textContent=py.found?`${py.version} · ${py.executable}`:'Python not detected';
  statusDot($('checkGit'),git.found); $('gitDetail').textContent=git.found?git.version:'Git not detected';
  statusDot($('checkGpu'),gpu.found,!gpu.found); $('gpuDetail').textContent=gpu.found?gpu.devices.map(x=>`${x.name} · ${x.memory_mb} MB`).join(' / '):'No NVIDIA GPU detected — CPU mode remains possible';
  $('metricGpu').textContent=gpu.found?gpu.devices[0].name:'CPU / No NVIDIA'; $('metricGpuMemory').textContent=gpu.found?`${gpu.devices[0].memory_mb} MB VRAM`:`${system.memory_gb} GB system RAM`;
}
function renderWorker(w){
  state.worker=w; const running=Boolean(w.running); $('metricWorker').textContent=running?(w.busy?'Processing':'Online'):'Stopped'; $('metricProcessed').textContent=String(w.processed||0); $('metricHeartbeat').textContent=w.last_heartbeat?`Heartbeat ${formatDate(w.last_heartbeat)}`:'No heartbeat yet';
  $('sideStatus').textContent=running?(w.busy?'Processing':'Running'):'Stopped'; $('sideStatusDot').classList.toggle('running',running); $('heroCore').classList.toggle('running',running);
  $('startWorkerBtn').classList.toggle('hidden',running); $('stopWorkerBtn').classList.toggle('hidden',!running); $('heroStartBtn').textContent=running?'Worker is running':'Start accepting jobs'; $('heroStartBtn').disabled=running;
  $('jobStateBadge').textContent=w.busy?'Processing':running?'Waiting':'Idle'; $('jobStateBadge').classList.toggle('running',running);
}
function renderJob(job){
  const isLocal=job.uuid==='local-test'; if(isLocal){renderTestProgress(job);return}
  $('jobEmpty').classList.add('hidden');$('jobLive').classList.remove('hidden');$('jobAsset').textContent=job.asset_name||job.uuid||'3D asset';$('jobStage').textContent=job.stage||'Processing';$('jobProgressBar').style.width=`${Math.max(0,Math.min(100,job.progress||0))}%`;$('jobProgressValue').textContent=`${job.progress||0}%`;$('jobProgressMessage').textContent=job.message||job.stage||'Processing';
  if((job.progress||0)>=100)setTimeout(()=>{$('jobEmpty').classList.remove('hidden');$('jobLive').classList.add('hidden')},2500);
}
function renderTestProgress(job){
  const p=Math.max(0,Math.min(100,job.progress||0));$('testProgressBar').style.width=`${p}%`;$('testProgressValue').textContent=`${p}%`;$('testProgressStage').textContent=job.stage||'Processing';$('testResultTitle').textContent=job.stage||'Generating 3D';$('testResultText').textContent=job.message||'The local engine is processing the image.';$('testOrb').classList.add('running');
}
function connectionPayload(){return {nexa_api_base:$('nexaApiBase').value.trim(),worker_token:$('workerToken').value.trim(),worker_id:$('workerId').value.trim(),provider:$('provider').value,stable_fast_3d_repo:$('sf3dRepo').value.trim(),stable_fast_3d_python:$('sf3dPython').value.trim(),hf_cache_dir:$('hfCacheDir').value.trim(),hf_token:$('hfToken').value.trim(),hunyuan3d_api_url:$('hunyuanUrl').value.trim(),force_cpu:$('forceCpu').checked}}
function settingsPayload(){return {...connectionPayload(),poll_seconds:Number($('pollSeconds').value),http_timeout_seconds:Number($('httpTimeout').value),provider_timeout_seconds:Number($('providerTimeout').value),auto_start:$('autoStart').checked,keep_temp:$('keepTemp').checked}}
async function saveSettings(show=true){const result=await window.nexa3d.saveSettings(settingsPayload());fillConfig(result.config);if(show)toast('Settings saved.');return result}

async function refreshAll(){
  const data=await window.nexa3d.bootstrap();state.paths=data.paths||{};fillConfig(data.config);renderWorker(data.worker);renderSystem(data.system);await probeEngines(false);
}
async function probeEngines(show=true){
  try{const r=await window.nexa3d.probeEngines();const sf=r.stable_fast_3d;const hy=r.hunyuan3d_api;$('sf3dStatus').textContent=sf.repo_ready&&sf.venv_ready?(sf.torch?.cuda?`Ready · CUDA · ${sf.torch.device}`:sf.torch?.version?`Ready · CPU/PyTorch ${sf.torch.version}`:'Source ready · Python check failed'):'Not installed';$('sf3dStatus').classList.toggle('ready',sf.repo_ready&&sf.venv_ready);$('metricEngineReady').textContent=state.config.provider==='stable_fast_3d'?$('sf3dStatus').textContent:(hy.reachable?'Local API ready':'Local API offline');$('hunyuanStatus').textContent=hy.reachable?`Connected · ${hy.detail}`:`Offline · ${hy.detail||'Not reachable'}`;$('hunyuanStatus').classList.toggle('ready',hy.reachable);if(show)toast('Engine status refreshed.')}catch(e){if(show)toast(e.message,'bad')}
}

function wire(){
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.page)));document.querySelectorAll('[data-goto]').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.goto)));document.querySelectorAll('.external-link').forEach(b=>b.addEventListener('click',()=>window.nexa3d.openExternal(b.dataset.url)));
  $('refreshBtn').addEventListener('click',()=>refreshAll().catch(e=>toast(e.message,'bad')));
  $('saveConnectionBtn').addEventListener('click',()=>saveSettings().catch(e=>toast(e.message,'bad')));
  $('saveSettingsBtn').addEventListener('click',()=>saveSettings().catch(e=>toast(e.message,'bad')));
  $('testConnectionBtn').addEventListener('click',async()=>{await saveSettings(false);const r=await window.nexa3d.testConnection();statusDot($('checkNexa'),r.ok);$('nexaDetail').textContent=r.ok?r.message:r.error;toast(r.ok?r.message:r.error,r.ok?'good':'bad')});
  const start=async()=>{try{await saveSettings(false);const r=await window.nexa3d.startWorker();renderWorker(r.status);toast(r.message)}catch(e){toast(e.message,'bad');setPage('connection')}};$('startWorkerBtn').addEventListener('click',start);$('heroStartBtn').addEventListener('click',start);
  $('stopWorkerBtn').addEventListener('click',async()=>{const r=await window.nexa3d.stopWorker();renderWorker(r.status);toast(r.message)});
  $('probeEngineBtn').addEventListener('click',()=>probeEngines(true));
  $('chooseHfCacheBtn').addEventListener('click',async()=>{const dir=await window.nexa3d.pickFolder();if(!dir)return;$('hfCacheDir').value=dir;toast('Hugging Face cache folder selected. Save settings to apply it.');});
  $('installSf3dBtn').addEventListener('click',async()=>{try{await saveSettings(false);$('installSf3dBtn').disabled=true;$('installSf3dBtn').textContent='Installing…';appendEngineLog('Starting Stable Fast 3D installation. Large downloads may take time.');const r=await window.nexa3d.installStableFast3D();toast('Stable Fast 3D installation completed.');appendEngineLog(`Completed: ${r.verification||'ready'}`);await probeEngines(false)}catch(e){toast(e.message,'bad');appendEngineLog(`ERROR: ${e.message}`)}finally{$('installSf3dBtn').disabled=false;$('installSf3dBtn').textContent='Install / Repair Stable Fast 3D'}});
  $('testHunyuanBtn').addEventListener('click',async()=>{try{await saveSettings(false);const r=await window.nexa3d.testHunyuan();$('hunyuanStatus').textContent=`Connected · ${r.detail}`;$('hunyuanStatus').classList.add('ready');toast('Hunyuan3D local API is reachable.')}catch(e){$('hunyuanStatus').textContent=`Offline · ${e.message}`;$('hunyuanStatus').classList.remove('ready');toast(e.message,'bad')}});
  $('chooseImageBtn').addEventListener('click',async()=>{const file=await window.nexa3d.pickImage();if(!file)return;state.testFile=file;$('testImagePath').value=file;$('imagePreview').classList.add('has-image');$('imagePreview').style.backgroundImage=`url("file://${file.replace(/\\/g,'/')}")`;$('imagePreview').querySelector('b').textContent=file.split(/[\\/]/).pop();$('imagePreview').querySelector('small').textContent=file});
  $('chooseOutputBtn').addEventListener('click',async()=>{const dir=await window.nexa3d.pickFolder();if(!dir)return;$('testOutputDir').value=dir;$('testOutputLabel').textContent=`Output: ${dir}`});
  $('generateTestBtn').addEventListener('click',async()=>{try{if(!state.testFile)throw new Error('Choose an image first.');await saveSettings(false);$('generateTestBtn').disabled=true;$('generateTestBtn').textContent='Generating…';$('testOrb').classList.add('running');const r=await window.nexa3d.testGeneration({image:state.testFile,output_dir:$('testOutputDir').value,quality:$('testQuality').value});$('testOrb').classList.remove('running');$('testOrb').classList.add('done');$('testResultTitle').textContent='Real GLB generated';$('testResultText').textContent=r.file;$('testProgressBar').style.width='100%';$('testProgressValue').textContent='100%';$('testProgressStage').textContent='Completed';$('revealTestBtn').dataset.file=r.file;$('revealTestBtn').classList.remove('hidden');toast('Local 3D test completed.')}catch(e){$('testOrb').classList.remove('running');$('testResultTitle').textContent='Generation failed';$('testResultText').textContent=e.message;toast(e.message,'bad')}finally{$('generateTestBtn').disabled=false;$('generateTestBtn').textContent='Generate Local 3D Model'}});
  $('revealTestBtn').addEventListener('click',()=>window.nexa3d.revealPath($('revealTestBtn').dataset.file));$('openLogsBtn').addEventListener('click',()=>window.nexa3d.openPath(state.paths.logs));$('openDataBtn').addEventListener('click',()=>window.nexa3d.openPath(state.paths.userData));$('clearWorkerLog').addEventListener('click',()=>{state.logs=[];$('workerLog').textContent=''});$('clearEngineLog').addEventListener('click',()=>{state.engineLogs=[];$('engineLog').textContent=''});
  window.nexa3d.onWorkerStatus(renderWorker);window.nexa3d.onWorkerLog(appendWorkerLog);window.nexa3d.onEngineLog(appendEngineLog);window.nexa3d.onJob(renderJob);
}

document.addEventListener('DOMContentLoaded',async()=>{wire();try{await refreshAll()}catch(e){toast(e.message,'bad')}});
