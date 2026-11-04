import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '@/lib/investigator/store';
import {runTask,validateStageCall} from '@/lib/investigator/runtime';
const analysis={caseTitle:'fixture',summary:'fixture',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
it.each([false,true])('runs bounded counterevidence loop, cap=%s',async capped=>{
 const dir=mkdtempSync(join(tmpdir(),'tt-plan-'));const store=new Store(dir);const previous={provider:process.env.AGENT_PROVIDER,model:process.env.AGENT_MODEL};process.env.AGENT_PROVIDER='ollama';process.env.AGENT_MODEL='fixture';
 try{
 store.saveCase({caseId:'a',analysis,evidence:[{id:'e',name:'fiction',kind:'text',mimeType:'text/plain',content:'承诺退款。尚未到账。'}]});const original=store.createTask('a',{goal:'完整核查',mode:'deep',idempotencyKey:'one'});const visited:number[]=[];
 await runTask(store,store.claim('fixture')!,async()=>{
 const t=store.task(original.id),segment=t.snapshot[0];let name='submit_artifact';let args:unknown={summary:'fixture'};
 if(t.step===2&&!t.reads.length){name='read_evidence';args={segmentId:segment.id};}
 else if(t.step===6&&(capped||!t.executionPlan?.replans)){name='request_replan';args={reason:'发现未到账反证，重新提取',segmentIds:[segment.id],affectedClaimIds:['c0']};}
 else {visited.push(t.step);if(t.step===0)args={summary:'fixture',plan:['核对承诺及履行']};if(t.step===2){const round=t.executionPlan?.replans||0;args={summary:'fixture',claims:[{id:'c'+round,content:round?'尚未到账':'承诺退款',kind:'statement',refs:[{evidenceId:'e',version:1,segmentId:segment.id,quote:round?'尚未到账':'承诺退款'}]}]};}if(t.step===6)args={summary:'fixture',checks:t.artifacts.flatMap(a=>a.claims).map(c=>({claimId:c.id,status:'supported',reason:'只支持原文陈述'}))};}
 return {text:'',raw:undefined,calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]};
 });
 const result=store.task(original.id);expect(result.executionPlan?.replans).toBe(capped?2:1);expect(visited.filter(s=>s===3)).toHaveLength(1);expect(visited.filter(s=>s===4)).toHaveLength(1);expect(result.artifacts.flatMap(a=>a.claims)).toHaveLength(capped?3:2);expect(result.executionOutcome).toBe(capped?'insufficient':'completed');expect(result.state).toBe(capped?'paused':'completed');expect(result.lifetimeModelCalls).toBeGreaterThan(0);expect(result.executionPlan?.nodes.every(n=>n.revision===1)).toBe(true);
 if(capped){store.action(result.id,"resume");await runTask(store,store.claim("resume")!,async()=>{throw Error("capped plan must not invoke model");});expect(store.task(result.id).executionOutcome).toBe("insufficient");expect(store.task(result.id).state).toBe("paused");}
 }finally{store.close();if(previous.provider===undefined)delete process.env.AGENT_PROVIDER;else process.env.AGENT_PROVIDER=previous.provider;if(previous.model===undefined)delete process.env.AGENT_MODEL;else process.env.AGENT_MODEL=previous.model;rmSync(dir,{recursive:true,force:true});}
});
it('enforces replan stage and strict contract',()=>{expect(()=>validateStageCall(2,'request_replan',{reason:'x',segmentIds:['e'],affectedClaimIds:['c']})).toThrow();expect(()=>validateStageCall(6,'request_replan',{reason:'x',segmentIds:['e'],affectedClaimIds:['c'],claims:[]})).toThrow();});
