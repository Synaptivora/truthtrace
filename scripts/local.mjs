import { spawn } from 'node:child_process';
const mode=process.argv.includes('--production')?'start':'dev';
const children=[spawn(process.execPath,['node_modules/next/dist/bin/next',mode,'--hostname','127.0.0.1'],{stdio:'inherit',windowsHide:true}),spawn(process.execPath,['--import','tsx','scripts/investigator-worker.ts'],{stdio:'inherit',windowsHide:true})];
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children)child.kill();}
for(const child of children)child.on('exit',code=>{stop();process.exitCode=code||0;});
process.on('SIGINT',stop);process.on('SIGTERM',stop);
