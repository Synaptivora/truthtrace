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
  if(step==='evidence-verification')args.checks=[{claimId:'C1',status:'supported',reason:'仅支持承诺存在，不证明履行'}];
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]}));
});
await new Promise(r=>model.listen(18767,'127.0.0.1',r));
const env={...process.env,TRUTHTRACE_DATA_DIR:dir,AGENT_PROVIDER:'ollama',AGENT_MODEL:'fixture',AGENT_BASE_URL:'http://127.0.0.1:18767/v1'};
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','18766'],{env,windowsHide:true,stdio:'pipe'});
const worker=spawn(process.execPath,['--import','tsx','scripts/investigator-worker.ts'],{env,windowsHide:true,stdio:'pipe'});
let logs='';for(const child of [app,worker]){child.stdout.on('data',s=>{logs+=s;});child.stderr.on('data',s=>{logs+=s;});}
const base='http://127.0.0.1:18766';let browser,page;
try{
  for(let i=0;i<60;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}
  const analysis={caseTitle:'虚构退款测试',summary:'待核实',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-02',analysisMode:'rule'};
  const saved=await fetch(base+'/api/cases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caseId:'smoke-case',caseName:'虚构退款测试',analysis,evidence:[{id:'e1',name:'虚构聊天',kind:'text',mimeType:'text/plain',content:'小王说周五退款。'}]})});assert.equal(saved.status,200);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('[data-entry-case="smoke-case"]').click();
  await page.getByRole('button',{name:'自主调查',exact:true}).click();await page.getByLabel('调查目标',{exact:true}).fill('核实退款承诺和实际到账');await page.getByRole('button',{name:'开始调查',exact:true}).click();
  await page.getByRole('heading',{name:'报告已生成 · 8/8'}).waitFor({timeout:15000});
  await page.getByRole('button',{name:'查看原文：周五退款'}).click();await page.locator('.investigator-panel pre').getByText('小王说周五退款。',{exact:true}).waitFor();
  const tasks=await (await fetch(base+'/api/cases/smoke-case/investigations')).json();const report=await (await fetch(base+`/api/investigations/${tasks.tasks[0].id}/report`)).text();assert.match(report,/e1 v1/);
  await mkdir('artifacts/investigator',{recursive:true});await page.screenshot({path:'artifacts/investigator/desktop.png'});
  await page.reload();await page.locator('[data-entry-case="smoke-case"]').click();await page.getByRole('button',{name:'自主调查',exact:true}).click();await page.getByRole('heading',{name:'报告已生成 · 8/8'}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/investigator/mobile.png'});const bounds=await page.locator('.investigator-panel').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390);assert.deepEqual(errors,[]);
  console.log('PASS: eight skills, worker, persistent case/task, refresh, report references, desktop and 390px UI. Fixture model only.');
}catch(e){console.error(logs);console.error(await page?.locator("body").innerText());throw e;}
finally{await browser?.close();app.kill();worker.kill();model.close();console.log('Isolated test data:',dir);}
