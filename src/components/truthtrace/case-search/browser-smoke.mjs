import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const directory=mkdtempSync(join(tmpdir(),'tt-case-search-ui-')),port=3437,base=`http://127.0.0.1:${port}`,token='synthetic-browser-test-token-'.repeat(3);
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port),TRUTHTRACE_DATA_DIR:directory,TRUTHTRACE_MACHINE_TOKEN:token,TRUTHTRACE_LOCAL_BOOTSTRAP:'1',TRUTHTRACE_SESSION_SECRET:token}});
let browser;
try{
 for(let i=0;i<60;i++){try{await fetch(base);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 const analysis={caseTitle:'虚构退款案',summary:'待核查',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
 const response=await fetch(base+'/api/cases',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({caseId:'fictional-case',analysis,evidence:[{id:'e',kind:'text',name:'虚构聊天',mimeType:'text/plain',content:'2026-11-04 退款尚未到账'}]})});assert.equal(response.status,200);
 browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(base);
 const panel=page.getByRole('region',{name:'案件搜索与承诺追踪'});await panel.waitFor();
 await panel.getByLabel('关键词',{exact:true}).fill('退款');await panel.getByRole('button',{name:'搜索',exact:true}).click();
 await panel.getByRole('button',{name:'打开案件并定位原文'}).waitFor();assert.match(await panel.innerText(),/退款尚未到账/);
 await panel.getByRole('button',{name:'承诺追踪',exact:true}).click();await panel.getByText('当前筛选没有承诺。').waitFor();
 console.log('PASS: real browser session, case search result and commitments entry');
}finally{await browser?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(directory,{recursive:true,force:true});}
