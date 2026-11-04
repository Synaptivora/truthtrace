import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const directory=await mkdtemp(join(tmpdir(),'tt-reading-'));
const token=crypto.randomUUID()+crypto.randomUUID(), port=18784, base=`http://127.0.0.1:${port}`;
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port),TRUTHTRACE_DATA_DIR:directory,TRUTHTRACE_LOCAL_BOOTSTRAP:'1',TRUTHTRACE_SESSION_SECRET:token,TRUTHTRACE_MACHINE_TOKEN:token,AI_PROVIDER:'rule',AGENT_PROVIDER:'',AGENT_API_KEY:'',AI_API_KEY:''}});
const api=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
let browser;
try {
  for(let i=0;i<60;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
  const transcript=Array.from({length:3534},(_,i)=>`[2026-11-04 12:00:00] 测试者: 记录${i} ${'合成测试文字'.repeat(36)}`).join('\n');
  const evidence=[{id:'bulk',name:'3534条合成聊天',kind:'chat',mimeType:'text/plain',content:transcript}];
  const payload={evidence,allowFallback:true};assert(Buffer.byteLength(JSON.stringify(payload))>2*1024*1024);
  const large=await api('/api/analyze',payload);assert.equal(large.status,200,await large.text());
  const markdown='# 项目核查材料\n\n**待核实，不代表事实成立。**\n\n| 事项 | 当前记录 |\n| --- | --- |\n| 交付 | 待核对原件 |\n| 退款 | 暂无凭证 |\n\n## 下一步\n\n1. 核对日期\n   - 保留原始附件\n2. 联系记录人\n\n> 第一行引文\n> 第二行引文\n\n```json\n{"status":"待核查"}\n```\n\n<img src=x onerror=alert(1)>\n';
  const analysis={caseTitle:'阅读排版验收',summary:'## 核查摘要\n\n**待核实**\n\n| 事项 | 进度 |\n| --- | --- |\n| 交付 | 待核查 |',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],analysisMode:'model',generatedAt:'2026-11-04'};
  const result=await api('/api/cases',{caseId:'reading',caseName:'阅读排版验收',analysis,evidence:[{id:'md',name:'核查材料.md',kind:'text',mimeType:'text/markdown',content:markdown}]});assert.equal(result.status,200);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/source/**',r=>r.fulfill({status:503,json:{error:'Offline fixture'}}));
  await mkdir('artifacts/reading',{recursive:true});
  await page.goto(base);await page.screenshot({path:'artifacts/reading/home-desktop.png'});
  await page.locator('[data-entry-case="reading"]').click();
  await page.locator('.contract-summary table').waitFor();
  await page.locator('.contract-catalog button').filter({hasText:'核查材料.md'}).click();
  const source=page.getByRole('dialog',{name:'证据原文'});
  await source.locator('table').waitFor();assert.equal(await source.locator('blockquote').count(),1);assert.equal(await source.locator('pre code').count(),1);assert.equal(await source.locator('.markdown-content img').count(),0);
  assert.equal(await source.locator('.markdown-content').evaluate(el=>getComputedStyle(el).fontSize),'16px');
  await page.screenshot({path:'artifacts/reading/material-desktop.png'});
  await source.getByRole('button',{name:'原始文本',exact:true}).click();assert.equal(await source.locator('.evidence-raw').textContent(),markdown);
  await source.getByRole('button',{name:'排版阅读',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/reading/material-mobile.png'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile page overflow');
  await source.getByRole('button',{name:'关闭原文',exact:true}).click();await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'预览报告',exact:true}).click();const frame=page.frameLocator('iframe[title]');await frame.getByRole('heading',{name:'阅读排版验收',exact:true}).waitFor();
  await page.screenshot({path:'artifacts/reading/report-desktop.png'});
  await frame.locator('table').waitFor();
  const preview=page.getByRole('dialog',{name:/报告/});const downloadEvent=page.waitForEvent('download');await preview.getByRole('button',{name:/导出Markdown/}).click();const download=await downloadEvent;const output=join(directory,'report.md');await download.saveAs(output);const text=await readFile(output,'utf8');assert.match(text,/原始材料索引/);assert.match(text,/暂无记录/);assert.match(text,/\| 事项 \| 进度 \|/);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({pass:true,messages:3534,bytes:Buffer.byteLength(JSON.stringify(payload)),markdown:true,rawSourceUnchanged:true,mobile:true,realModel:false,directory}));
} finally {await browser?.close();app.kill();}
