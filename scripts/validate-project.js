'use strict';
const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));const project=JSON.parse(fs.readFileSync(path.join(root,'nexa.project.json'),'utf8'));
if(pkg.version!==project.application_version)throw new Error('package.json and nexa.project.json versions do not match.');
if(pkg.build?.appId!=='com.nexa.3dworkerlocal')throw new Error('Unexpected application ID.');
const sources=['main.js','preload.js','src/app.js','src/backend/engine-manager.js','src/backend/nexa-worker.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
const forbidden=[/OpenAIClient/g,/workflow_dispatch/g,/github token/i,/child_process.*powershell.*download/i];
for(const pattern of forbidden){if(pattern.test(sources))throw new Error(`Forbidden integration detected: ${pattern}`)}
for(const endpoint of ['worker-heartbeat.php','worker-next.php','worker-progress.php','worker-fail.php','worker-result.php'])if(!sources.includes(endpoint))throw new Error(`Required Nexa 3D endpoint missing from worker: ${endpoint}`);
console.log('Project validator PASS — isolated local worker contract verified.');
