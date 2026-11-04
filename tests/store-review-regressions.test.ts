import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '@/lib/investigator/store';
import {ArtifactSchema} from '@/lib/investigator/contracts';
import {createEvidenceRef} from '@/lib/evidence/provenance';
const analysis={caseTitle:'fixture',summary:'fixture',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026',analysisMode:'rule'};
function fixture(run:(s:Store)=>void){const dir=mkdtempSync(join(tmpdir(),'tt-review-'));const s=new Store(dir);try{s.saveCase({caseId:'c',analysis,evidence:[{id:'e',name:'fixture',kind:'text',mimeType:'text/plain',content:'承诺退款。尚未到账。',parserVersion:'old'}]});run(s);}finally{s.close();rmSync(dir,{recursive:true,force:true});}}
it('versions provenance metadata independently of compatible content hashes',()=>fixture(s=>{
 const before=s.case('c');const old=createEvidenceRef(before.evidence[0],0,4,{caseId:'c',evidence:before.evidence,segments:s.snapshot('c')});
 const updated=s.saveCase({...before,evidence:before.evidence.map(e=>({...e,parserVersion:'new'}))});expect(updated.evidence[0].version).toBe(2);expect(s.evidenceVersion('c','e',1).evidence.parserVersion).toBe('old');expect(s.evidenceVersion('c','e',1).hash).toBe(s.evidenceVersion('c','e',2).hash);
 const current=createEvidenceRef(updated.evidence[0],0,4,{caseId:'c',evidence:updated.evidence,segments:s.snapshot('c')});
 const saved=s.saveCase({...updated,analysis:{...analysis,people:[{id:'p',name:'fixture',role:'unknown',summary:'fixture',evidenceRefs:[old,current]}]}});expect(saved.analysis.people[0].evidenceRefs.map(r=>r.provenance?.version)).toEqual([1,2]);expect(s.saveCase(saved).evidence[0].version).toBe(2);
}));
it('binds first-import unique quotes after persistence but leaves repeated quotes unresolved',()=>fixture(s=>{
 const saved=s.saveCase({...s.case('c'),evidence:[{...s.case('c').evidence[0],content:'重复。唯一。重复。'}],analysis:{...analysis,people:[{id:'p',name:'fixture',role:'unknown',summary:'fixture',evidenceRefs:[{evidenceId:'e',quote:'唯一',citationValidation:'legacy_unresolved'},{evidenceId:'e',quote:'重复',citationValidation:'legacy_unresolved'}]}]}});
 const [unique,repeated]=saved.analysis.people[0].evidenceRefs;expect(unique.provenance?.version).toBe(2);expect(unique.provenance?.locator).toEqual({type:'text_range',start:3,end:5});expect(unique.citationValidation).toBe('validated');expect(repeated.provenance).toBeUndefined();expect(repeated.citationValidation).toBe('legacy_unresolved');
}));
it('preserves replan counterclaims when a decision invalidates derived results',()=>fixture(s=>{
 const t=s.createTask('c',{goal:'fixture',idempotencyKey:'a'});const claim=(id:string)=>({id,content:'尚未到账',kind:'statement',refs:[{evidenceId:'e',version:1,segmentId:t.snapshot[0].id,quote:'尚未到账'}]});
 t.artifacts=[ArtifactSchema.parse({summary:'plan',plan:['fixture']}),ArtifactSchema.parse({summary:'collect'}),ArtifactSchema.parse({summary:'extract',claims:[claim('c0')]}),ArtifactSchema.parse({summary:'replan',claims:[claim('c1')]}),ArtifactSchema.parse({summary:'report',decisions:[{id:'d',question:'fixture',claimIds:['c1']}],checks:[{claimId:'c1',status:'supported',reason:'fixture'}]})];t.state='waiting_user';s.saveTask(t);
 const result=s.decision(t.id,{id:'d',value:'yes',reason:'retain'});expect(result.artifacts.flatMap(a=>a.claims).map(c=>c.id)).toEqual(['c0','c1']);expect(result.artifacts.flatMap(a=>a.checks)).toEqual([]);expect(result.executionPlan).toBeUndefined();expect(result.step).toBe(3);
 result.state='paused';s.saveTask(result);expect(()=>s.decision(t.id,{id:'d',value:'yes',reason:'again'})).toThrow('已提交');
}));
it('rejects cancelled decisions and prevents parallel active tasks',()=>fixture(s=>{
 const a=s.createTask('c',{goal:'A',idempotencyKey:'a'});a.artifacts=[ArtifactSchema.parse({summary:'fixture',decisions:[{id:'d',question:'fixture',claimIds:['c0']}]})];a.state='cancelled';s.saveTask(a);s.createTask('c',{goal:'B',idempotencyKey:'b'});
 expect(()=>s.decision(a.id,{id:'d',value:'yes',reason:'fixture'})).toThrow('状态');a.state='paused';s.saveTask(a);expect(()=>s.decision(a.id,{id:'d',value:'yes',reason:'fixture'})).toThrow('其他');expect(s.task(a.id).state).toBe('paused');
}));

it('retains prior gaps as historical coverage notes without retaining stale judgments',()=>fixture(s=>{
 const t=s.createTask('c',{goal:'fixture',idempotencyKey:'gap'});t.state='waiting_user';t.collectionNotes=['解析服务报告附件截断'];
 t.artifacts=[ArtifactSchema.parse({summary:'collection',gaps:['附件无法读取']}),ArtifactSchema.parse({summary:'extraction',claims:[{id:'c',content:'承诺退款',kind:'statement',refs:[{evidenceId:'e',version:1,segmentId:t.snapshot[0].id,quote:'承诺退款'}]}],gaps:['缺少到账凭证']}),ArtifactSchema.parse({summary:'verification',checks:[{claimId:'c',status:'supported',reason:'OLD_CHECK_MUST_NOT_SURVIVE'}],decisions:[{id:'d',question:'人工确认',claimIds:['c']}]})];s.saveTask(t);
 const next=s.decision(t.id,{id:'d',value:'accepted',reason:'用户提交判断'});expect(next.collectionNotes).toContain('解析服务报告附件截断');expect(next.collectionNotes?.some(n=>n.includes('附件无法读取')&&n.includes('修订 1')&&n.includes('不作为本轮核查结论'))).toBe(true);expect(next.collectionNotes?.some(n=>n.includes('缺少到账凭证'))).toBe(true);expect(next.artifacts.flatMap(a=>a.checks)).toEqual([]);expect(next.artifacts.flatMap(a=>a.gaps)).toEqual([]);expect(JSON.stringify(next.collectionNotes)).not.toContain('OLD_CHECK');expect(next.step).toBe(3);
 expect(s.action(t.id,'revise').collectionNotes).toEqual([]);
}));
