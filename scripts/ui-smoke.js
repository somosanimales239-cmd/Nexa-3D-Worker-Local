'use strict';
const fs=require('fs');const path=require('path');const {spawn}=require('child_process');
const electron=require('electron');const root=path.resolve(__dirname,'..');const marker=path.join(root,'artifacts','ui-smoke-ok.json');fs.rmSync(marker,{force:true});fs.mkdirSync(path.dirname(marker),{recursive:true});
const child=spawn(electron,[root,'--nexa-ui-smoke'],{cwd:root,stdio:'inherit',windowsHide:true});const timer=setTimeout(()=>{try{child.kill()}catch{};console.error('UI smoke timed out.');process.exit(1)},30000);
child.on('exit',(code)=>{clearTimeout(timer);if(code!==0){console.error(`Electron smoke exited ${code}`);process.exit(code||1)}if(!fs.existsSync(marker)){console.error('UI smoke marker was not created.');process.exit(1)}const data=JSON.parse(fs.readFileSync(marker,'utf8'));if(!data.ok||data.title!=='Nexa 3D Worker Local')throw new Error('Invalid UI smoke result.');console.log('UI smoke PASS — Nexa 3D Worker Local window loaded.');});
