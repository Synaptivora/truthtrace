import {requestReplan,currentClaimCheck} from "@/lib/investigator/plan";
import {ArtifactSchema} from "@/lib/investigator/contracts";
import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '@/lib/investigator/store';
import {runTask,validateStageCall} from '@/lib/investigator/runtime';
const analysis={caseTitle:'fixture',summary:'fixture',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
// Real SQLite checkpoints across eight stages plus bounded replan/resume; allow CI disk contention.
it.each([false,true])('runs bounded counterevidence loop, cap=%s',async capped=>{
 const dir=mkdtempSync(join(tmpdir(),'tt-plan-'));const store=new Store(dir);const previous={provider:process.env.AGENT_PROVIDER,model:process.env.AGENT_MODEL};process.env.AGENT_PROVIDER='ollama';process.env.AGENT_MODEL='fixture';
 try{
 store.saveCase({caseId:'a',analysis,evidence:[{id:'e',name:'fiction',kind:'text',mimeType:'text/plain',content:'承诺退款。尚未到账。'}]});const original=store.createTask('a',{goal:'完整核查',mode:'deep',idempotencyKey:'one'});const visited:number[]=[];
 await runTask(store,store.claim('fixture')!,async(_config,messages)=>{
 const t=store.task(original.id),segment=t.snapshot[0];if(t.step===2&&t.executionPlan?.replans){const payload=JSON.parse(messages[1].content);expect(payload.replan.request.reason).toContain('反证');expect(payload.replan.request.affectedClaimIds).toEqual(['c0']);expect(payload.replan.coverageTarget).toEqual([segment.id]);expect(payload.replan.existingClaimIds).toContain('c0');expect(payload.replan.extractionRule).toContain('唯一claim ID');}let name='submit_artifact';let args:unknown={summary:'fixture'};
 if(t.step===2&&!t.reads.length){name='read_evidence';args={segmentId:segment.id};}
 else if(t.step===6&&(capped||!t.executionPlan?.replans)){name='request_replan';args={reason:'发现未到账反证，重新提取',segmentIds:[segment.id],affectedClaimIds:['c0']};}
 else {visited.push(t.step);if(t.step===0)args={summary:'fixture',plan:['核对承诺及履行']};if(t.step===2){const round=t.executionPlan?.replans||0;args={summary:'fixture',claims:[{id:'c'+round,content:round?'尚未到账':'承诺退款',kind:'statement',refs:[{evidenceId:'e',version:1,segmentId:segment.id,quote:round?'尚未到账':'承诺退款'}]}]};}if(t.step===6)args={summary:'fixture',checks:t.artifacts.flatMap(a=>a.claims).map(c=>({claimId:c.id,status:'supported',reason:'只支持原文陈述'}))};}
 return {text:'',raw:undefined,calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]};
 });
 const result=store.task(original.id);expect(result.executionPlan?.replans).toBe(capped?2:1);expect(visited.filter(s=>s===3)).toHaveLength(1);expect(visited.filter(s=>s===4)).toHaveLength(1);expect(result.artifacts.flatMap(a=>a.claims)).toHaveLength(capped?3:2);expect(result.executionOutcome).toBe(capped?'insufficient':'completed');expect(result.state).toBe(capped?'paused':'completed');expect(result.lifetimeModelCalls).toBeGreaterThan(0);expect(result.executionPlan?.nodes.every(n=>n.revision===1)).toBe(true);
 if(capped){expect(result.executionPlan?.requests).toHaveLength(3);expect(result.executionPlan?.requests.at(-1)?.round).toBe(3);expect(result.executionPlan?.staleResultIds).toContain('c0');
 result.artifacts.push(ArtifactSchema.parse({summary:'old',checks:[{claimId:'c2',status:'supported',reason:'old'}],events:[{id:'event',content:'dependent',claimIds:['c2']}]}));
 result.executionPlan!.staleResultIds=[];expect(currentClaimCheck(result,'c2')?.status).toBe('supported');result.artifacts.push(ArtifactSchema.parse({summary:'new',checks:[{claimId:'c2',status:'disputed',reason:'counterevidence'}]}));expect(currentClaimCheck(result,'c2')?.status).toBe('disputed');
 result.step=6;requestReplan(result,{reason:'third new counterevidence',segmentIds:[result.snapshot[0].id],affectedClaimIds:['c2']});expect(currentClaimCheck(result,'c2')).toBeUndefined();expect(result.executionPlan!.staleResultIds).toContain('event');expect(result.executionPlan!.requests.at(-1)?.affectedClaimIds).toEqual(['c2']);
 store.action(result.id,"resume");await runTask(store,store.claim("resume")!,async()=>{throw Error("capped plan must not invoke model");});expect(store.task(result.id).executionOutcome).toBe("insufficient");expect(store.task(result.id).state).toBe("paused");}
 }finally{store.close();if(previous.provider===undefined)delete process.env.AGENT_PROVIDER;else process.env.AGENT_PROVIDER=previous.provider;if(previous.model===undefined)delete process.env.AGENT_MODEL;else process.env.AGENT_MODEL=previous.model;rmSync(dir,{recursive:true,force:true});}
},20_000);
it('enforces replan stage and strict contract',()=>{expect(()=>validateStageCall(2,'request_replan',{reason:'x',segmentIds:['e'],affectedClaimIds:['c']})).toThrow();expect(()=>validateStageCall(6,'request_replan',{reason:'x',segmentIds:['e'],affectedClaimIds:['c'],claims:[]})).toThrow();});
