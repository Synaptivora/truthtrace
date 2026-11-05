import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'truthtrace-restart-'));
const env={...process.env,PORT:'18900',INGESTION_SERVICE_URL:'http://127.0.0.1:18901',TRUTHTRACE_DATA_DIR:dir,TRUTHTRACE_SESSION_SECRET:'',TRUTHTRACE_INGESTION_TOKEN:'',SYNAPSE_AUTO_SETUP:'0',AI_API_KEY:'',AGENT_API_KEY:''};
let app,browser;let logs='';
async function start(){
 app=spawn(process.execPath,['scripts/local.mjs','--production'],{env,windowsHide:true,stdio:'pipe'});
 app.stdout.on('data',s=>logs+=s);app.stderr.on('data',s=>logs+=s);
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:18900')).ok)return;}catch{}await new Promise(r=>setTimeout(r,200));}
 throw Error('startup failed');
}
function stop(){if(!app)return; if(process.platform==='win32')execFileSync('taskkill',['/pid',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else app.kill('SIGTERM');app=undefined;}
try{
 await start();browser=await chromium.launch();const page=await browser.newPage();await page.goto('http://127.0.0.1:18900');
 assert.equal(await page.evaluate(async()=> (await fetch('/api/cases')).status),200);
 stop();await new Promise(r=>setTimeout(r,700));await start();
 assert.equal(await page.evaluate(async()=> (await fetch('/api/cases')).status),200,'existing page session survives restart');
 assert.equal(await page.evaluate(async()=> (await fetch('/api/source/list')).status),200,'parser credentials survive restart');
 await page.route('**/api/setup*',route=>{
  const req=route.request();
  if(req.method()==='POST'){assert.equal(req.postDataJSON().action,'install');return route.fulfill({json:{jobId:'fixture'}});}
  if(req.url().includes('job='))return route.fulfill({json:{id:'fixture',action:'install',status:'running',steps:[],lines:[],authUrl:'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=TEST'}});
  return route.fulfill({status:503,json:{error:'测试检测失败，请重试'}});
 });
 await page.getByRole('button',{name:'和咪探长聊聊',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('button',{name:'连接渠道',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'测试检测失败，请重试'}).waitFor();
 assert.equal(await page.getByText('正在检测本机工具…',{exact:true}).count(),0);
 await page.getByRole('button',{name:'一键配置本机工具',exact:true}).click();
 await page.getByRole('link',{name:'打开钉钉授权页',exact:true}).waitFor();
 console.log('PASS: launcher/restart session, parser auth, detection failure state and one-click authorization link');
} catch(e){console.error(logs);throw e;}finally{stop();await browser?.close();}
