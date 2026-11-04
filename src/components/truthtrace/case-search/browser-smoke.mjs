import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const directory=mkdtempSync(join(tmpdir(),'tt-case-search-ui-')),port=3437,base=`http://127.0.0.1:${port}`,token='synthetic-browser-test-token-'.repeat(3);
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port),TRUTHTRACE_DATA_DIR:directory,TRUTHTRACE_MACHINE_TOKEN:token,TRUTHTRACE_LOCAL_BOOTSTRAP:'1',TRUTHTRACE_SESSION_SECRET:token}});
let browser;
try{
 for(let i=0;i<60;i++){try{await fetch(base);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 const oldText='2026-11-04 退款尚未到账',newText='2026-11-05 更新退款记录';
 const ref={evidenceId:'e',quote:oldText,provenance:{schemaVersion:2,caseId:'fictional-case',evidenceId:'e',version:1,segmentId:'e@1:0',originalHash:null,parserVersion:null,locator:{type:'text_range',start:0,end:oldText.length},verificationMethod:'exact_text'}};
 const analysis={caseTitle:'虚构退款案',summary:'待核查 <script>window.evil=1</script>',people:[],relationships:[],events:[{id:'event1',title:'原始退款记录',description:'虚构测试事件',occurredAt:'2026-11-04T10:00:00+08:00',timeLabel:'2026-11-04',timePrecision:'exact',participantIds:[],evidenceRefs:[ref]}],contradictions:[],commitments:[{id:'c1',personId:'candidate',commitment:'虚构明确期限承诺',dueLabel:'2020-01-01T00:00:00+08:00',status:'pending',evidenceRefs:[ref]},{id:'c2',personId:'candidate',commitment:'虚构模糊期限承诺',dueLabel:'有空时',status:'unknown',evidenceRefs:[ref]}],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
 for(const content of [oldText,newText]){const response=await fetch(base+'/api/cases',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({caseId:'fictional-case',analysis,evidence:[{id:'e',kind:'text',name:'虚构聊天',mimeType:'text/plain',content}]})});assert.equal(response.status,200);}
 browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(base);
 const panel=page.getByRole('region',{name:'案件搜索与承诺追踪'});await panel.waitFor();
 await panel.getByLabel('关键词',{exact:true}).fill('退款');await panel.getByRole('button',{name:'搜索',exact:true}).click();
 await panel.getByRole('button',{name:'打开案件并定位原文'}).waitFor();assert.match(await panel.innerText(),/更新退款记录/);
 await panel.getByRole('button',{name:'承诺追踪',exact:true}).click();await panel.getByLabel('承诺状态').selectOption('due');await panel.getByText('虚构退款案 · 虚构明确期限承诺',{exact:true}).waitFor();assert.equal(await panel.getByText('虚构模糊期限承诺',{exact:false}).count(),0);
 await panel.getByRole('button',{name:'跨案件搜索',exact:true}).click();await panel.getByRole('button',{name:'打开案件并定位原文'}).click();
 await page.locator('dialog mark').filter({hasText:newText}).waitFor();await page.getByRole('button',{name:'关闭原文',exact:true}).click();
 await page.getByRole('button',{name:'时间线',exact:true}).click();const slider=page.getByRole('slider',{name:'时间线回看'});await slider.fill('0');assert.equal(await page.locator('.timeline-item').count(),0);await slider.fill('1');await page.getByRole('heading',{name:'原始退款记录'}).waitFor();
 await page.locator('.timeline-item').getByRole('button',{name:'虚构聊天',exact:true}).click();await page.locator('dialog mark').filter({hasText:oldText}).waitFor();assert.match(await page.locator('dialog').innerText(),/引用版本 v1/);await page.getByRole('button',{name:'关闭原文',exact:true}).click();
 await page.getByRole('navigation',{name:'调查视图'}).getByRole('button',{name:'承诺追踪',exact:true}).click();await page.getByLabel('筛选承诺').selectOption('due');await page.getByRole('region',{name:'承诺追踪',exact:true}).getByRole('button',{name:'来源 e',exact:true}).click();await page.locator('dialog mark').filter({hasText:oldText}).waitFor();await page.getByRole('button',{name:'关闭原文',exact:true}).click();
 for(const format of ['markdown','html']){await page.getByLabel('报告格式',{exact:true}).selectOption(format);const waiting=page.waitForEvent('download');await page.getByRole('button',{name:'导出报告',exact:true}).click();const download=await waiting;const path=join(directory,'report.'+(format==='html'?'html':'md'));await download.saveAs(path);const body=readFileSync(path,'utf8');assert.match(body,/虚构明确期限承诺/);if(format==='html'){assert.ok(!body.includes('<script>window.evil'));assert.ok(body.includes('&lt;script&gt;'));}else assert.match(body,/原始材料索引/);}
 console.log('PASS: real session search -> v2 highlight -> v1 history, commitment filter, timeline slider, HTML/MD downloads');
}finally{await browser?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(directory,{recursive:true,force:true});}
