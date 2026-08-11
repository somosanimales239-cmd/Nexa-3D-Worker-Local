'use strict';
const $ = (id) => document.getElementById(id);
const state = { config: {}, system: null, worker: null, paths: {}, testFile: '', applyZipFile: '', logs: [], engineLogs: [], applyPackages: [] };

const pageTitles = { dashboard:'Worker Dashboard', connection:'Nexa Connection', engine:'Engine Setup', apply:'Apply Packages', test:'Local Image → 3D Test', logs:'Activity & Logs', settings:'Settings' };

function toast(message, type='good') {
  const el=$('toast'); el.textContent=message; el.className=`toast ${type}`; clearTimeout(toast.timer); el.classList.remove('hidden'); toast.timer=setTimeout(()=>el.classList.add('hidden'),4200);
}
function setPage(page){
  document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
  document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.dataset.pagePanel===page));
  $('pageTitle').textContent=pageTitles[page]||'Nexa 3D Worker Local';
}
function statusDot(el, good, warn=false){el.className=good?'good':warn?'warn':''}
function formatDate(value){if(!value)return 'No heartbeat yet';try{return new Date(value).toLocaleString()}catch{return value}}
function formatBytes(value){const n=Number(value)||0;if(n<=0)return '0 B';const u=['B','KB','MB','GB'];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i+=1}return `${v.toFixed(v>=10||i===0?0:1)} ${u[i]}`}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]||ch));}
function appendWorkerLog(entry){ const line=typeof entry==='string'?entry:entry.line; state.logs.push(line); state.logs=state.logs.slice(-800); $('workerLog').textContent=state.logs.join('\n'); $('workerLog').scrollTop=$('workerLog').scrollHeight; }
function appendEngineLog(line){ state.engineLogs.push(line); state.engineLogs=state.engineLogs.slice(-800); $('engineLog').textContent=state.engineLogs.join('\n'); $('engineLog').scrollTop=$('engineLog').scrollHeight; }

function fillConfig(cfg){
  state.config=cfg;
  $('nexaApiBase').value=cfg.nexa_api_base||''; $('workerToken').value=cfg.has_worker_token?'••••••••••••••••':''; $('workerId').value=cfg.worker_id||''; $('provider').value=cfg.provider||'stable_fast_3d';
  $('sf3dRepo').value=cfg.stable_fast_3d_repo||''; $('sf3dPython').value=cfg.stable_fast_3d_python||''; $('hfCacheDir').value=cfg.hf_cache_dir||''; $('hfToken').value=cfg.has_hf_token?'••••••••••••••••':''; $('hunyuanUrl').value=cfg.hunyuan3d_api_url||''; $('blenderPath').value=cfg.blender_path||''; $('quickTextureEnabled').checked=cfg.quick_texture_enabled!==false;
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
function renderApplyPackages(list){
  state.applyPackages=Array.isArray(list)?list:[];
  const wrap=$('applyPackageList');
  if(!state.applyPackages.length){
    wrap.innerHTML='<article class="card"><div class="job-empty"><div class="empty-icon">📦</div><h3>No apply packages imported yet</h3><p>Download an Apply Package ZIP from Nexa 3D Studio, then import it here.</p></div></article>';
    return;
  }
  wrap.innerHTML=state.applyPackages.map((item)=>`<article class="card apply-card">
    <div class="card-head"><div><span class="kicker">${item.remote_dispatch_id?'AUTO WEB ↔ WORKER BRIDGE':'APPLY PACKAGE'}</span><h3>${escapeHtml(item.output_name||item.asset_name||'Apply Package')}</h3><p class="muted">${escapeHtml(item.asset_name||'')} · Version: ${escapeHtml(item.version_name||'Current profile')}${item.remote_dispatch_id?` · Dispatch ${escapeHtml(item.remote_dispatch_id)}`:''}</p></div><span class="state-badge ${item.status==='completed'?'running':''}">${escapeHtml(String(item.status||'imported').toUpperCase())}</span></div>
    <div class="metric-grid apply-metrics">
      <div class="metric"><span>Imported</span><strong>${escapeHtml(formatDate(item.imported_at))}</strong><small>${escapeHtml(item.source_name||'')}</small></div>
      <div class="metric"><span>References</span><strong>${Number(item.refs_count||0)}</strong><small>${item.extraction_ok?'Manifest read successfully':'Imported without extraction details'}</small></div>
      <div class="metric"><span>Result file</span><strong>${escapeHtml(item.result_name||'Not attached')}</strong><small>${item.result_name?escapeHtml(formatBytes(item.result_size)):(item.remote_dispatch_id?'Drop the finished GLB/GLTF/ZIP into the watched folder for automatic upload.':'Attach the completed GLB/GLTF/ZIP after processing')}</small></div>
    </div>
    ${item.remote_dispatch_id?`<div class="apply-brief"><b>Automatic bridge status</b><pre>${escapeHtml(item.bridge_state||'awaiting_result')}
Watched folder: ${escapeHtml(item.result_drop_folder||'')}
${item.uploaded_back_to_nexa?'Uploaded back to Nexa automatically.':'The worker will upload the first finished GLB / GLTF / ZIP it finds in the watched folder.'}</pre></div>`:''}
    ${item.brief?`<div class="apply-brief"><b>Brief preview</b><pre>${escapeHtml(String(item.brief).slice(0,900))}</pre></div>`:''}
    <div class="button-row">
      <button class="btn secondary" data-action="set-status" data-id="${item.id}" data-status="processing">Mark Processing</button>
      <button class="btn secondary" data-action="set-status" data-id="${item.id}" data-status="failed">Mark Failed</button>
      <button class="btn secondary" data-action="attach-result" data-id="${item.id}">Attach Result File</button>
      ${item.result_drop_folder?`<button class="btn primary" data-action="open-path" data-path="${escapeHtml(item.result_drop_folder)}">Open Watched Result Folder</button>`:''}
      <button class="btn ghost" data-action="open-path" data-path="${escapeHtml(item.package_folder||item.zip_path||'')}">Open Package Folder</button>
      <button class="btn ghost" data-action="open-path" data-path="${escapeHtml(item.zip_path||'')}">Reveal ZIP</button>
      ${item.result_path?`<button class="btn primary" data-action="open-path" data-path="${escapeHtml(item.result_path)}">Reveal Result</button>`:''}
      <button class="btn danger" data-action="delete-apply" data-id="${item.id}">Delete</button>
    </div>
  </article>`).join('');
}

function connectionPayload(){return {nexa_api_base:$('nexaApiBase').value.trim(),worker_token:$('workerToken').value.trim(),worker_id:$('workerId').value.trim(),provider:$('provider').value,stable_fast_3d_repo:$('sf3dRepo').value.trim(),stable_fast_3d_python:$('sf3dPython').value.trim(),hf_cache_dir:$('hfCacheDir').value.trim(),hf_token:$('hfToken').value.trim(),hunyuan3d_api_url:$('hunyuanUrl').value.trim(),blender_path:$('blenderPath').value.trim(),quick_texture_enabled:$('quickTextureEnabled').checked,force_cpu:$('forceCpu').checked}}
function settingsPayload(){return {...connectionPayload(),poll_seconds:Number($('pollSeconds').value),http_timeout_seconds:Number($('httpTimeout').value),provider_timeout_seconds:Number($('providerTimeout').value),auto_start:$('autoStart').checked,keep_temp:$('keepTemp').checked}}
async function saveSettings(show=true){const result=await window.nexa3d.saveSettings(settingsPayload());fillConfig(result.config);if(show)toast('Settings saved.');return result}

async function refreshAll(){
  const data=await window.nexa3d.bootstrap();state.paths=data.paths||{};fillConfig(data.config);renderWorker(data.worker);renderSystem(data.system);renderApplyPackages(data.apply_packages||[]);await probeEngines(false);
}
async function refreshApplyPackages(){ const r=await window.nexa3d.listApplyPackages(); renderApplyPackages(r.packages||[]); }
async function probeEngines(show=true){
  try{
    const [r,bt]=await Promise.all([window.nexa3d.probeEngines(),window.nexa3d.probeBlender()]);
    const sf=r.stable_fast_3d;const hy=r.hunyuan3d_api;
    $('sf3dStatus').textContent=sf.repo_ready&&sf.venv_ready?(sf.torch?.cuda?`Ready · CUDA · ${sf.torch.device}`:sf.torch?.version?`Ready · CPU/PyTorch ${sf.torch.version}`:'Source ready · Python check failed'):'Not installed';
    $('sf3dStatus').classList.toggle('ready',sf.repo_ready&&sf.venv_ready);
    $('metricEngineReady').textContent=state.config.provider==='stable_fast_3d'?$('sf3dStatus').textContent:(hy.reachable?'Local API ready':'Local API offline');
    $('hunyuanStatus').textContent=hy.reachable?`Connected · ${hy.detail}`:`Offline · ${hy.detail||'Not reachable'}`;$('hunyuanStatus').classList.toggle('ready',hy.reachable);
    $('blenderStatus').textContent=bt.found?`${bt.version} · Ready for Quick Texture`:`Not ready · ${bt.error||'Blender not detected'}`;$('blenderStatus').classList.toggle('ready',Boolean(bt.found));
    if(bt.found && !$('blenderPath').value.trim()) $('blenderPath').value=bt.executable||'';
    if(show)toast('Engine status refreshed.');
  }catch(e){if(show)toast(e.message,'bad')}
}

function wire(){
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.page)));
  document.querySelectorAll('[data-goto]').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.goto)));
  document.querySelectorAll('.external-link').forEach(b=>b.addEventListener('click',()=>window.nexa3d.openExternal(b.dataset.url)));

  $('refreshBtn').addEventListener('click',()=>refreshAll().catch(e=>toast(e.message,'bad')));
  $('saveConnectionBtn').addEventListener('click',()=>saveSettings().catch(e=>toast(e.message,'bad')));
  $('saveSettingsBtn').addEventListener('click',()=>saveSettings().catch(e=>toast(e.message,'bad')));
  $('testConnectionBtn').addEventListener('click',async()=>{await saveSettings(false);const r=await window.nexa3d.testConnection();statusDot($('checkNexa'),r.ok);$('nexaDetail').textContent=r.ok?r.message:r.error;toast(r.ok?r.message:r.error,r.ok?'good':'bad')});

  const start=async()=>{try{await saveSettings(false);const r=await window.nexa3d.startWorker();renderWorker(r.status);toast(r.message)}catch(e){toast(e.message,'bad');setPage('connection')}};
  $('startWorkerBtn').addEventListener('click',start);$('heroStartBtn').addEventListener('click',start);
  $('stopWorkerBtn').addEventListener('click',async()=>{const r=await window.nexa3d.stopWorker();renderWorker(r.status);toast(r.message)});

  $('probeEngineBtn').addEventListener('click',()=>probeEngines(true));
  $('probeBlenderBtn').addEventListener('click',async()=>{try{await saveSettings(false);const r=await window.nexa3d.probeBlender();$('blenderStatus').textContent=r.found?`${r.version} · Ready for Quick Texture`:`Not ready · ${r.error||'Blender not detected'}`;$('blenderStatus').classList.toggle('ready',Boolean(r.found));if(r.found&& !$('blenderPath').value.trim())$('blenderPath').value=r.executable||'';toast(r.found?'Blender Quick Texture is ready.':r.error,r.found?'good':'bad')}catch(e){toast(e.message,'bad')}});
  $('chooseBlenderBtn').addEventListener('click',async()=>{const file=await window.nexa3d.pickExecutable();if(!file)return;$('blenderPath').value=file;await saveSettings(false);await probeEngines(false);toast('Blender executable selected.');});
  $('chooseHfCacheBtn').addEventListener('click',async()=>{const dir=await window.nexa3d.pickFolder();if(!dir)return;$('hfCacheDir').value=dir;toast('Hugging Face cache folder selected. Save settings to apply it.');});
  $('installSf3dBtn').addEventListener('click',async()=>{try{await saveSettings(false);$('installSf3dBtn').disabled=true;$('installSf3dBtn').textContent='Installing…';appendEngineLog('Starting Stable Fast 3D installation. Large downloads may take time.');const r=await window.nexa3d.installStableFast3D();toast('Stable Fast 3D installation completed.');appendEngineLog(`Completed: ${r.verification||'ready'}`);await probeEngines(false)}catch(e){toast(e.message,'bad');appendEngineLog(`ERROR: ${e.message}`)}finally{$('installSf3dBtn').disabled=false;$('installSf3dBtn').textContent='Install / Repair Stable Fast 3D'}});
  $('testHunyuanBtn').addEventListener('click',async()=>{try{await saveSettings(false);const r=await window.nexa3d.testHunyuan();$('hunyuanStatus').textContent=`Connected · ${r.detail}`;$('hunyuanStatus').classList.add('ready');toast('Hunyuan3D local API is reachable.')}catch(e){$('hunyuanStatus').textContent=`Offline · ${e.message}`;$('hunyuanStatus').classList.remove('ready');toast(e.message,'bad')}});

  $('chooseApplyZipBtn').addEventListener('click',async()=>{const file=await window.nexa3d.pickApplyZip();if(!file)return;state.applyZipFile=file;$('applyZipPath').value=file;toast('Apply Package ZIP selected.');});
  $('importApplyZipBtn').addEventListener('click',async()=>{try{if(!state.applyZipFile)throw new Error('Choose an Apply Package ZIP first.');$('importApplyZipBtn').disabled=true;const r=await window.nexa3d.importApplyPackage({path:state.applyZipFile});state.applyZipFile='';$('applyZipPath').value='';await refreshApplyPackages();toast(`Apply Package imported: ${r.item.output_name||r.item.asset_name}`);}catch(e){toast(e.message,'bad')}finally{$('importApplyZipBtn').disabled=false;}});
  $('applyPackageList').addEventListener('click',async(e)=>{
    const btn=e.target.closest('[data-action]'); if(!btn)return;
    const action=btn.dataset.action; const id=btn.dataset.id;
    try{
      if(action==='set-status'){
        await window.nexa3d.setApplyStatus({id,status:btn.dataset.status});
        await refreshApplyPackages();
        toast('Package status updated.');
      } else if(action==='attach-result'){
        const file=await window.nexa3d.pickResultFile(); if(!file)return;
        await window.nexa3d.attachApplyResult({id,path:file});
        await refreshApplyPackages();
        toast('Result file attached.');
      } else if(action==='delete-apply'){
        if(!confirm('Delete this apply package from the local worker?')) return;
        await window.nexa3d.deleteApplyPackage({id});
        await refreshApplyPackages();
        toast('Apply package deleted.');
      } else if(action==='open-path'){
        await window.nexa3d.revealPath(btn.dataset.path);
      }
    } catch(err){ toast(err.message,'bad'); }
  });

  $('chooseImageBtn').addEventListener('click',async()=>{const file=await window.nexa3d.pickImage();if(!file)return;state.testFile=file;$('testImagePath').value=file;$('imagePreview').classList.add('has-image');$('imagePreview').style.backgroundImage=`url("file://${file.replace(/\\/g,'/')}")`;$('imagePreview').querySelector('b').textContent=file.split(/[\\/]/).pop();$('imagePreview').querySelector('small').textContent=file});
  $('chooseOutputBtn').addEventListener('click',async()=>{const dir=await window.nexa3d.pickFolder();if(!dir)return;$('testOutputDir').value=dir;$('testOutputLabel').textContent=`Output: ${dir}`});
  $('generateTestBtn').addEventListener('click',async()=>{try{if(!state.testFile)throw new Error('Choose an image first.');await saveSettings(false);$('generateTestBtn').disabled=true;$('generateTestBtn').textContent='Generating…';$('testOrb').classList.add('running');const r=await window.nexa3d.testGeneration({image:state.testFile,output_dir:$('testOutputDir').value,quality:$('testQuality').value});$('testOrb').classList.remove('running');$('testOrb').classList.add('done');$('testResultTitle').textContent='Real GLB generated';$('testResultText').textContent=r.file;$('testProgressBar').style.width='100%';$('testProgressValue').textContent='100%';$('testProgressStage').textContent='Completed';$('revealTestBtn').dataset.file=r.file;$('revealTestBtn').classList.remove('hidden');toast('Local 3D test completed.')}catch(e){$('testOrb').classList.remove('running');$('testResultTitle').textContent='Generation failed';$('testResultText').textContent=e.message;toast(e.message,'bad')}finally{$('generateTestBtn').disabled=false;$('generateTestBtn').textContent='Generate Local 3D Model'}});

  $('revealTestBtn').addEventListener('click',()=>window.nexa3d.revealPath($('revealTestBtn').dataset.file));
  $('openLogsBtn').addEventListener('click',()=>window.nexa3d.openPath(state.paths.logs));
  $('openDataBtn').addEventListener('click',()=>window.nexa3d.openPath(state.paths.userData));
  $('clearWorkerLog').addEventListener('click',()=>{state.logs=[];$('workerLog').textContent=''});
  $('clearEngineLog').addEventListener('click',()=>{state.engineLogs=[];$('engineLog').textContent=''});

  window.nexa3d.onWorkerStatus(renderWorker);window.nexa3d.onWorkerLog(appendWorkerLog);window.nexa3d.onEngineLog(appendEngineLog);window.nexa3d.onJob(renderJob);
}

document.addEventListener('DOMContentLoaded',async()=>{wire();try{await refreshAll()}catch(e){toast(e.message,'bad')}});
