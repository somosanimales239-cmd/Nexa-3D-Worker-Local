'use strict';
const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');
const required=['package.json','main.js','preload.js','src/index.html','src/app.js','src/styles.css','src/backend/config-store.js','src/backend/system-probe.js','src/backend/engine-manager.js','src/backend/nexa-worker.js','README.md','.github/workflows/nexa-windows-build.yml'];
const missing=required.filter(f=>!fs.existsSync(path.join(root,f)));if(missing.length){console.error('Missing required delivery files:',missing.join(', '));process.exit(1)}
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if(pkg.build?.productName!=='Nexa 3D Worker Local')throw new Error('productName must be Nexa 3D Worker Local');
for(const script of ['build:win','validate:delivery','validate:project','test','ui:smoke'])if(!pkg.scripts?.[script])throw new Error(`Missing package script ${script}`);
console.log(`Delivery validator PASS — ${required.length} required files present.`);
