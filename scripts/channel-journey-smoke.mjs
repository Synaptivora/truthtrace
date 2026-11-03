import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'truthtrace-channel-'));
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','18866'],{env:{...process.env,TRUTHTRACE_DATA_DIR:dir,AI_PROVIDER:'rule'},windowsHide:true,stdio:'pipe'});
let logs='';app.stdout.on('data',s=>logs+=s);app.stderr.on('data',s=>logs+=s);
const base='http://127.0.0.1:18866';let browser,page;
const analysis={caseTitle:'退款核查',summary:'材料已整理',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-03',analysisMode:'rule'};
const evidence={id:'chat-1',name:'项目群',kind:'text',mimeType:'text/plain',content:'小王：周五退款。'};
let authorized=false,polls=0,liveBody,extractBody,scans=0;
try{
  for(let i=0;i<60;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  let releaseCases;const casesReady=new Promise(resolve=>{releaseCases=resolve;});
  await page.route('**/api/cases',async route=>{if(route.request().method()==='GET')await casesReady;await route.continue();});
  const fulfill=(route,body)=>route.fulfill({json:body});
  await page.route('**/api/assistant/intent',route=>fulfill(route,{action:'investigate',mode:'fact',reason:'核查退款依据',source:'rules'}));
  await page.route('**/api/source/status?*',route=>fulfill(route,{source:'dingtalk',authorized,status:authorized?'ready':'need_auth'}));
  await page.route('**/api/setup*',route=>{
    if(route.request().method()==='POST')return fulfill(route,{jobId:'fixture-auth'});
    polls++;if(polls>1)authorized=true;
    return fulfill(route,{status:authorized?'ok':'running',ok:authorized,lines:['https://login.dingtalk.com/oauth2/device/verify.htm?user_code=TEST'],steps:[]});
  });
  await page.route('**/api/source/sessions',route=>{scans++;return fulfill(route,{sessions:[{id:'selected',title:'项目群',count:1},{id:'other',title:'无关群',count:5}]});});
  await page.route('**/api/source/live',route=>{liveBody=route.request().postDataJSON();return fulfill(route,{handle:'fixture',conversations:[{id:'selected',title:'项目群',count:1,start:'2026-11-01 12:00:00',end:'2026-11-01 12:00:00'}]});});
  await page.route('**/api/source/preview',route=>fulfill(route,{conversations:[{id:'selected',title:'项目群',source:'dingtalk',total:1,total_in_range:1,truncated:false,messages:[{seq:0,sender:'小王',time:'2026-11-01 12:00:00',type:'text',text:'周五退款。'}]}]}));
  await page.route('**/api/source/extract',route=>{extractBody=route.request().postDataJSON();return fulfill(route,{evidences:[evidence],synced:1});});
  await page.route('**/api/analyze',route=>fulfill(route,{analysis}));
  await page.goto(base);
  await page.getByLabel('这次想解决的问题').fill('核查钉钉里的退款承诺');
  const loaded=page.waitForResponse(r=>r.url()===base+'/api/cases');releaseCases();await loaded;
  await page.getByRole('button',{name:'交给咪探长',exact:true}).click();
  await page.getByRole('button',{name:'选择钉钉会话',exact:true}).click();
  await page.getByRole('button',{name:'连接钉钉',exact:true}).click();
  await page.getByRole('link',{name:'打开钉钉授权页 ↗',exact:true}).waitFor();
  await page.getByLabel('搜索联系人或群名').waitFor({timeout:15000});
  assert.equal(scans,1);assert.equal(await page.locator('.ci-sess-row input:checked').count(),0);
  await page.getByLabel('搜索联系人或群名').fill('项目');assert.equal(await page.locator('.ci-sess-row').count(),1);
  await page.locator('.ci-sess-row input').check();
  await page.getByRole('button',{name:'读取选中的 1 段',exact:true}).click();
  await page.getByRole('button',{name:'导入并继续',exact:true}).click();
  await page.getByLabel('调查目标',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('调查目标',{exact:true}).inputValue(),'核查钉钉里的退款承诺');
  assert.deepEqual(liveBody.conversations.map(c=>c.id),['selected']);assert.deepEqual(extractBody.conversation_ids,['selected']);
  const cases=(await (await fetch(base+'/api/cases')).json()).cases;assert.equal(cases[0].goal,'核查钉钉里的退款承诺');assert.equal(cases[0].evidence.length,1);
  await page.getByLabel('调查目标',{exact:true}).fill('核查退款承诺及到账日期');
  await page.getByRole('button',{name:'连接模型并继续',exact:true}).click();await page.getByRole('heading',{name:'模型设置',exact:true}).waitFor();await page.getByRole('button',{name:'返回并继续',exact:true}).click();
  assert.equal(await page.getByLabel('调查目标',{exact:true}).inputValue(),'核查退款承诺及到账日期');
  await mkdir('artifacts/journey',{recursive:true});await page.screenshot({path:'artifacts/journey/desktop.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/journey/mobile.png'});
  const bounds=await page.locator('.agent-panel').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390);assert.deepEqual(errors,[]);
  console.log('PASS: goal-first onboarding, OAuth continuation, default no selection, named conversation search, selected-only import, goal persistence, contextual setup and mobile. No real channel reads.');
}catch(e){console.error(logs);console.error(await page?.locator('body').innerText());throw e;}
finally{await browser?.close();app.kill();console.log('Isolated data:',dir);}
