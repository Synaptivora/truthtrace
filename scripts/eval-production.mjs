import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cases,datasetVersion } from '../evals/cases.mjs';
const root=resolve(process.env.TT_EVAL_REPO||process.cwd());
const load=p=>import(pathToFileURL(join(root,p)).href);
const {runAgent}=await load('src/lib/agent/runner.ts');
const {runTask}=await load('src/lib/investigator/runtime.ts');
const {Store}=await load('src/lib/investigator/store.ts');
const dir=await mkdtemp(join(tmpdir(),'tt-offline-eval-'));
const saved={...process.env};
Object.assign(process.env,{TRUTHTRACE_DATA_DIR:dir,AGENT_PROVIDER:'ollama',AGENT_MODEL:'offline-script',AGENT_BASE_URL:'http://127.0.0.1:1',AGENT_API_KEY:'',AI_API_KEY:''});
// Fail closed if production accidentally calls a network transport.
globalThis.fetch=async()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
const results=[];
try {
 for(const c of cases){
  const evidence=c.evidence.map(e=>({id:e.evidenceId,name:c.id,kind:'text',mimeType:'text/plain',content:e.text}));
  const start=performance.now();
  const reply=await runAgent({mode:'demo',allowImages:false,messages:[{role:'user',content:c.evidence[0].text.slice(0,2)}],evidence},new AbortController().signal,()=>{});
  const valid=reply.citations.every(ref=>evidence.some(e=>e.id===ref.evidenceId&&e.content.includes(ref.excerpt)));
  results.push({id:c.id,path:'runAgent/demo',latencyMs:performance.now()-start,output:reply,checks:{citationIdentityAndExcerpt:valid,nonemptyResult:!!reply.text},semanticGroundedness:null,realModelCalls:0});
 }
 for(const mode of ['fact','timeline','deep'])for(const malicious of [false,true]){
  const store=new Store(join(dir,`${mode}-${malicious}`));
  try{
   const caseId='fictional';store.saveCase({caseId,evidence:[{id:'e',name:'fixture',kind:'text',mimeType:'text/plain',content:'阿禾说：周五回复。'}],analysis:{caseTitle:'fixture',summary:'pending',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'}});
   const task=store.createTask(caseId,{goal:'核查原文',mode,idempotencyKey:'eval'});let attempted=false;let rejected=null;let calls=0;
   const start=performance.now();
   await runTask(store,store.claim('eval-worker'),async()=>{
    calls++;const t=store.task(task.id),s=t.snapshot[0];
    if(malicious&&!attempted){attempted=true;return {text:'',raw:null,calls:[{id:'bad',name:'submit_artifact',arguments:JSON.stringify({summary:'bad',plan:['read'],unauthorizedField:'must-not-be-silently-stripped'})}]};}
    if(malicious&&rejected===null)rejected=t.step===0&&t.artifacts.length===0;
    if(t.step===2&&!t.reads.length)return {text:'',raw:null,calls:[{id:'read',name:'read_evidence',arguments:JSON.stringify({segmentId:s.id})}]};
    const artifact={summary:'scripted transport fixture',...(t.step===0?{plan:['read original']}:{}),...(t.step===2?{claims:[{id:'c',kind:'statement',content:s.content,refs:[{evidenceId:s.evidenceId,version:s.version,segmentId:s.id,quote:s.content}]}]}:{}),...(t.step===6?{checks:[{claimId:'c',status:'supported',reason:'Exact statement fixture; not external verification'}]}:{})};
    return {text:'',raw:null,calls:[{id:'submit',name:'submit_artifact',arguments:JSON.stringify(artifact)}]};
   });
   const final=store.task(task.id);results.push({id:`runtime-${mode}-${malicious?'adversarial':'valid'}`,path:'runTask/scripted-transport',latencyMs:performance.now()-start,scriptedCalls:calls,realModelCalls:0,output:{state:final.state,step:final.step,artifacts:final.artifacts},checks:{completed:final.state==='completed',...(malicious?{crossStageRejected:rejected===true}:{})},semanticGroundedness:null});
  }finally{store.close();}
 }
 const checks=results.flatMap(r=>Object.values(r.checks));
 const report={kind:'production-offline-deterministic',datasetVersion,adapterVersion:'tt-production-v1',sourceSHA:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),humanGoldReview:'PENDING_AI_AUTHORED',semanticMetrics:'NOT_MEASURED',realModelCalls:0,summary:{passed:checks.filter(Boolean).length,total:checks.length},results};
 await writeFile(process.env.TT_EVAL_OUTPUT||'evals/offline-result.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report.summary));if(checks.some(v=>!v))process.exitCode=1;
}finally{process.env=saved;await rm(dir,{recursive:true,force:true});}

