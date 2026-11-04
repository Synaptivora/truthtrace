// Security fixtures: generated session/machine credentials; no production credentials.
const fixtureToken=crypto.randomUUID()+crypto.randomUUID();
const fetch=(input,init={})=>{const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${fixtureToken}`);return globalThis.fetch(input,{...init,headers});};
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const dir=await mkdtemp(join(tmpdir(),'truthtrace-reliability-'));
let failing=true;
const model=http.createServer(async(req,res)=>{
  req.resume();
  if(failing){res.writeHead(402,{'Content-Type':'application/json'});res.end('{}');return;}
  const payload={caseTitle:'源码提交',summary:'小王向小李确认源码提交。',people:[{id:'p1',name:'小王',role:'询问者',summary:'咨询提交',aliases:[],evidenceRefs:[{sourceId:'R1'}]},{id:'p2',name:'小李',role:'答复者',summary:'回复源码要求',aliases:[],evidenceRefs:[{sourceId:'R2'}]}],relationships:[{id:'r1',sourcePersonId:'p1',targetPersonId:'p2',label:'询问并确认源码提交要求',evidenceRefs:[{sourceId:'R1'},{sourceId:'R2'}]}],events:[],contradictions:[],commitments:[],evidenceGaps:[]};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'submit',type:'function',function:{name:'submit_analysis',arguments:JSON.stringify(payload)}}]}}]}));
});
await new Promise(r=>model.listen(18969,'127.0.0.1',r));
const base='http://127.0.0.1:18968';
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','18968'],{env:{...process.env,PORT:'18968',TRUTHTRACE_MODE:'local',TRUTHTRACE_LOCAL_BOOTSTRAP:'1',TRUTHTRACE_SESSION_SECRET:fixtureToken,TRUTHTRACE_MACHINE_TOKEN:fixtureToken,TRUTHTRACE_INGESTION_TOKEN:fixtureToken,AGENT_API_KEY:'',AI_API_KEY:'',AI_PROVIDER:'rule',TRUTHTRACE_MODEL_PRIVATE_ORIGINS:'http://127.0.0.1:18969',TRUTHTRACE_DATA_DIR:dir,AGENT_PROVIDER:'ollama',AGENT_MODEL:'fixture',AGENT_BASE_URL:'http://127.0.0.1:18969'},windowsHide:true,stdio:'pipe'});
let logs='';app.stdout.on('data',s=>logs+=s);app.stderr.on('data',s=>logs+=s);
let browser;
const evidence=[{id:'chat',name:'提交群',kind:'chat',mimeType:'text/plain',content:'[2026-11-03 12:00:00] 小王: @小李 需要交源码吗？\n[2026-11-03 12:01:00] 小李: 源码必须提交。'}];
const analysis={caseTitle:'测试',summary:'尚未模型分析',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],analysisMode:'rule',generatedAt:'2026-11-03'};
try{
  for(let i=0;i<60;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const fallback=await (await post('/api/analyze',{evidence,allowFallback:true})).json();assert.equal(fallback.analysis.analysisMode,'rule');assert.match(fallback.meta.analysisError,/余额不足/);
  assert.equal((await post('/api/cases',{caseId:'reliability',caseName:'源码讨论',goal:'了解源码要求',analysis,evidence,reviewNotes:{chat:'保留我的备注'}})).status,200);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];await page.route('**/api/source/**',route=>route.fulfill({status:503,json:{error:'Offline fixture: unconfigured channel route'}}));await page.route('**/api/setup**',route=>route.fulfill({status:503,json:{error:'Offline fixture: installation disabled'}}));page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('[data-entry-case="reliability"]').click();
  // Goal-bearing cases open the assistant; close it to exercise the case's analysis action.
  const close=page.getByRole('button',{name:'关闭助手',exact:true});if(await close.isVisible())await close.click();
  await page.getByRole('button',{name:'用模型分析已有材料',exact:true}).click();await page.getByRole('alert').filter({hasText:'余额不足'}).waitFor();
  let saved=(await (await fetch(base+'/api/cases/reliability')).json()).case;assert.equal(saved.analysis.analysisMode,'rule');assert.deepEqual(saved.evidence,evidence);
  failing=false;await page.getByRole('button',{name:'用模型分析已有材料',exact:true}).click();await page.locator('.contract-mode').getByText('模型分析',{exact:true}).waitFor();
  saved=(await (await fetch(base+'/api/cases/reliability')).json()).case;assert.equal(saved.reviewNotes.chat,'保留我的备注');assert.equal(saved.goal,'了解源码要求');assert.equal(saved.analysis.relationships.length,1);
  await page.getByText('互动清单 · 1',{exact:true}).click();await page.locator('.graph-toolbar details button').click();await page.getByLabel('关系依据',{exact:true}).getByText(evidence[0].content.split('\n')[1],{exact:true}).waitFor();
  assert.equal(await page.locator('.react-flow__edge-text').first().evaluate(el=>getComputedStyle(el).stroke),'none');
  await mkdir('artifacts/reliability',{recursive:true});await page.screenshot({path:'artifacts/reliability/fixture-desktop.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/reliability/fixture-mobile.png'});
  const db=new DatabaseSync(join(dir,'cases.sqlite'));assert.equal(db.prepare('select count(*) as count from analysis_history').get().count,1);db.close();assert.deepEqual(errors,[]);
  console.log('PASS: failed analysis keeps evidence, meaningful model error, reanalysis preserves case and history, exact relation sources, readable edge labels, mobile. Fixture model only.');
}catch(e){console.error(logs);throw e;}finally{await browser?.close();app.kill();model.close();console.log('Isolated data:',dir);}
