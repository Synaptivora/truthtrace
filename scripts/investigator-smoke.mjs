// Security fixtures: generated session/machine credentials; no production credentials.
const fixtureToken=crypto.randomUUID()+crypto.randomUUID();
const fetch=(input,init={})=>{const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${fixtureToken}`);return globalThis.fetch(input,{...init,headers});};
import { chromium } from 'playwright';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Entirely fictional inputs and a deterministic local model. No real accounts or credentials.
const dir=await mkdtemp(join(tmpdir(),'truthtrace-browser-'));
const model=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  const system=body.messages[0].content;
  const input=JSON.parse(body.messages[1].content);
  const step=/name: ([\w-]+)/.exec(system)?.[1];
  let name='submit_artifact',args={summary:'虚构测试完成',gaps:['缺少到账记录']};
  if(step==='investigation-master')args.plan=['查找退款承诺','核对到账'];
  if(step==='claim-extraction'){
    const s=input.segments[0];
    if(!body.messages.some(m=>m.role==='tool')){name='read_evidence';args={segmentId:s.id};}
    else args.claims=[{id:'C1',content:'小王称周五退款',kind:'statement',refs:[{evidenceId:s.evidenceId,version:s.version,segmentId:s.id,quote:'周五退款'}]}];
  }
  if(step==='investigation-report')args.answer={text:'原文有周五退款承诺，但没有到账凭证，尚不能认定已经退款。',claimIds:['C1']};
  if(step==='evidence-verification')args.checks=[{claimId:'C1',status:'supported',reason:'仅支持承诺存在，不证明履行'}];
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]}));
});
await new Promise(r=>model.listen(18767,'127.0.0.1',r));
const env={...process.env,PORT:'18766',TRUTHTRACE_MODE:'local',TRUTHTRACE_LOCAL_BOOTSTRAP:'1',TRUTHTRACE_SESSION_SECRET:fixtureToken,TRUTHTRACE_MACHINE_TOKEN:fixtureToken,TRUTHTRACE_INGESTION_TOKEN:fixtureToken,AGENT_API_KEY:'',AI_API_KEY:'',AI_PROVIDER:'rule',TRUTHTRACE_MODEL_PRIVATE_ORIGINS:'http://127.0.0.1:18767',TRUTHTRACE_DATA_DIR:dir,AGENT_PROVIDER:'ollama',AGENT_MODEL:'fixture',AGENT_BASE_URL:'http://127.0.0.1:18767/v1'};
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','18766'],{env,windowsHide:true,stdio:'pipe'});
const worker=spawn(process.execPath,['--import','tsx','scripts/investigator-worker.ts'],{env,windowsHide:true,stdio:'pipe'});
let logs='';for(const child of [app,worker]){child.stdout.on('data',s=>{logs+=s;});child.stderr.on('data',s=>{logs+=s;});}
const base='http://127.0.0.1:18766';let browser,page;
async function waitTask(predicate){for(let i=0;i<80;i++){const d=await (await fetch(base+'/api/cases/smoke-case/investigations')).json();if(predicate(d.tasks[0]))return;await new Promise(r=>setTimeout(r,250));}throw new Error('Task did not reach expected state');}
try{
  for(let i=0;i<60;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}
  const analysis={caseTitle:'虚构退款测试',summary:'待核实',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-02',analysisMode:'rule'};
  const saved=await fetch(base+'/api/cases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caseId:'smoke-case',caseName:'虚构退款测试',analysis,evidence:[{id:'e1',name:'虚构聊天',kind:'text',mimeType:'text/plain',content:'小王说周五退款。'}]})});assert.equal(saved.status,200);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];await page.route('**/api/source/**',route=>route.fulfill({status:503,json:{error:'Offline fixture: unconfigured channel route'}}));await page.route('**/api/setup**',route=>route.fulfill({status:503,json:{error:'Offline fixture: installation disabled'}}));page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('[data-entry-case="smoke-case"]').click();
  // PR16 exposes an explicit investigation shortcut; keep checking it exists.
  assert.equal(await page.getByRole('button',{name:'自主调查',exact:true}).count(),1);
  await page.getByRole('button',{name:'和咪探长聊聊'}).click();
  await page.getByLabel('输入问题').fill('帮我完整调查退款承诺和实际到账');await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByLabel('调查目标',{exact:true}).waitFor();
  assert.match(await page.getByLabel('调查目标',{exact:true}).inputValue(),/退款/);
  await page.getByRole('button',{name:'开始核查',exact:true}).click();
  await page.locator('.investigator-result').getByText('原文有周五退款承诺，但没有到账凭证，尚不能认定已经退款。',{exact:true}).waitFor({timeout:20000});
  await page.getByRole('button',{name:'查看原文：周五退款'}).click();await page.locator('.investigator-panel pre').getByText('小王说周五退款。',{exact:true}).waitFor();
  let tasks=await (await fetch(base+'/api/cases/smoke-case/investigations')).json();const taskId=tasks.tasks[0].id;
  const report=await (await fetch(base+`/api/investigations/${taskId}/report`)).text();assert.match(report,/e1 v1/);assert.match(report,/对目标的回答/);
  await mkdir('artifacts/investigator',{recursive:true});await page.locator('.investigator-panel').evaluate(el=>el.scrollTop=0);await page.screenshot({path:'artifacts/investigator/desktop.png'});
  // One action to add evidence: no manual pause/revise/resume sequence.
  await page.locator('.agent-panel').getByRole('button',{name:'补充材料',exact:true}).click();
  await page.locator('.agent-settings input[type=file]').setInputFiles({name:'补充.txt',mimeType:'text/plain',buffer:Buffer.from('补充说明：尚未收到退款。')});
  await waitTask(t=>t?.revision===2&&t?.state==='completed');
  tasks=await (await fetch(base+'/api/cases/smoke-case/investigations')).json();assert.equal(tasks.tasks[0].id,taskId);assert.equal(tasks.tasks[0].snapshot.length,2);
  await page.reload();await page.locator('[data-entry-case="smoke-case"]').click();
  await page.locator('.investigator-result').waitFor({timeout:15000});
  await page.getByText('调整目标或开始新调查',{exact:true}).click();
  await page.getByLabel('调查目标',{exact:true}).fill('核查是否有明确的退款日期');
  await page.getByRole('button',{name:'开始核查',exact:true}).click();
  await waitTask(t=>t?.mode==='fact'&&t?.state==='completed');
  await page.setViewportSize({width:390,height:844});await page.locator('.investigator-panel').evaluate(el=>el.scrollTop=0);await page.screenshot({path:'artifacts/investigator/mobile.png'});const bounds=await page.locator('.agent-panel').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390);assert.deepEqual(errors,[]);
  console.log('PASS: unified goal routing, cited answer, one-step evidence supplement, revision fencing, persisted refresh, fact route and mobile UI. Fixture model only.');
}catch(e){console.error(logs);console.error(await page?.locator("body").innerText());throw e;}
finally{await browser?.close();app.kill();worker.kill();model.close();console.log('Isolated test data:',dir);}
