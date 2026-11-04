import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,basename,dirname} from 'node:path';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const token=crypto.randomUUID()+crypto.randomUUID();
const directory=await mkdtemp(join(tmpdir(),'truthtrace-conversation-e2e-'));
const port=18814,modelPort=18815,base=`http://127.0.0.1:${port}`;
const model=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
 const hasRead=input.messages.some(m=>m.role==='tool');
 const isB=JSON.stringify(input.messages).includes('B独立材料');
 const message=hasRead?{role:'assistant',content:`${isB?'B独立回复':'A独立回复'}：仅描述原文，事实仍待核查 [E1]。`}:{role:'assistant',content:null,tool_calls:[{id:'read',type:'function',function:{name:'read_evidence',arguments:'{"id":"E1"}'}}]};
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:hasRead?'stop':'tool_calls',message}]}));
});
await new Promise(r=>model.listen(modelPort,'127.0.0.1',r));
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,PORT:String(port),TRUTHTRACE_DATA_DIR:directory,TRUTHTRACE_MODE:'local',TRUTHTRACE_LOCAL_BOOTSTRAP:'1',TRUTHTRACE_SESSION_SECRET:token,TRUTHTRACE_MACHINE_TOKEN:token,TRUTHTRACE_INGESTION_TOKEN:token,AGENT_PROVIDER:'ollama',AGENT_MODEL:'local-scripted-conversation',AGENT_BASE_URL:`http://127.0.0.1:${modelPort}/v1`,AGENT_API_KEY:'',AI_API_KEY:'',AI_PROVIDER:'rule',TRUTHTRACE_MODEL_PRIVATE_ORIGINS:`http://127.0.0.1:${modelPort}`},windowsHide:true,stdio:'pipe'});
let logs='';app.stdout.on('data',b=>logs+=b);app.stderr.on('data',b=>logs+=b);
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.route('**/api/assistant/intent',route=>route.fulfill({json:{action:'chat'}}));
await page.route('**/api/source/**',route=>route.fulfill({status:503,json:{error:'offline fixture'}}));
await page.route('**/api/setup**',route=>route.fulfill({status:503,json:{error:'offline fixture'}}));
const api=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
async function openCase(id){await page.goto(base);await page.locator(`[data-entry-case="${id}"]`).click();await page.getByRole('button',{name:'和咪探长聊聊',exact:true}).click();await page.getByRole('button',{name:'对话',exact:true}).click();await page.waitForFunction(()=>{const select=document.querySelector('[aria-label="选择本案会话"]');return select&&!select.disabled&&select.options.length>0;});}
async function send(text,answer){await page.getByLabel('输入问题',{exact:true}).fill(text);await page.getByRole('button',{name:'发送',exact:true}).click();await page.locator('.agent-message.assistant').last().filter({hasText:answer}).waitFor({timeout:20000});await page.waitForFunction(()=>!document.querySelector('.agent-progress'));}
try{
 for(let n=0;n<80;n++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
 const analysis={caseTitle:'虚构会话测试',summary:'仅测试持久化',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
 for(const id of ['a','b']){const response=await api('/api/cases',{caseId:`conversation-${id}`,caseName:`会话${id}`,analysis,evidence:[{id:`e-${id}`,name:`${id.toUpperCase()}独立材料`,kind:'text',mimeType:'text/plain',content:`${id.toUpperCase()}独立材料：此处仅是虚构承诺。`}]});assert.equal(response.status,200);}
 await openCase('conversation-a');await send('核对A材料','A独立回复');
 const a=await (await api('/api/conversations?caseId=conversation-a')).json();assert.equal(a.turns.length,2);assert.equal(a.turns[1].reply.citations[0].refs[0].provenance.caseId,'conversation-a');
 await page.reload();await page.locator('[data-entry-case="conversation-a"]').click();await page.getByRole('button',{name:'和咪探长聊聊',exact:true}).click();await page.getByRole('button',{name:'对话',exact:true}).click();await page.locator('.agent-message.assistant').filter({hasText:'A独立回复'}).waitFor();
 await page.locator('.agent-message.user').first().getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('编辑消息',{exact:true}).fill('已编辑A问题');await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.getByText('已编辑A问题',{exact:true}).waitFor();assert.equal(await page.locator('.agent-message.assistant').count(),0);
 await send('再次核对A材料','A独立回复');await mkdir('artifacts/conversation',{recursive:true});await page.screenshot({path:'artifacts/conversation/desktop.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/conversation/mobile.png'});const box=await page.locator('.agent-panel').boundingBox();assert(box.x>=0&&box.x+box.width<=390);assert(await page.getByRole('button',{name:'发送',exact:true}).isVisible());await page.setViewportSize({width:1440,height:1100});
 await openCase('conversation-b');assert.equal(await page.locator('.agent-message').count(),0);await send('核对B材料','B独立回复');assert(!await page.locator('.agent-messages').innerText().then(t=>t.includes('A独立回复')));
 assert.equal((await api(`/api/conversations?caseId=conversation-b&id=${a.id}`)).status,409);
 await openCase('conversation-a');await page.getByText('已编辑A问题',{exact:true}).waitFor();assert(!await page.locator('.agent-messages').innerText().then(t=>t.includes('B独立回复')));
 await page.locator('.agent-message').first().getByRole('button',{name:'删除此条及后续',exact:true}).click();await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.agent-message').length===0);
 await openCase('conversation-a');assert.equal(await page.locator('.agent-message').count(),0);
 assert.equal(errors.length,0,errors.join('\n'));await mkdir('artifacts/conversation',{recursive:true});await page.screenshot({path:'artifacts/conversation/empty-after-delete.png'});
 console.log(JSON.stringify({pass:true,kind:'local-scripted-browser-e2e',refresh:true,edit:true,delete:true,crossCaseIsolation:true,realModel:false}));
}catch(error){console.error(logs);throw error;}finally{await browser.close();app.kill();await new Promise(r=>app.exitCode!==null?r():app.once('exit',r));model.closeAllConnections();await new Promise(r=>model.close(r));if(dirname(resolve(directory))===resolve(tmpdir())&&basename(directory).startsWith('truthtrace-conversation-e2e-'))await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
