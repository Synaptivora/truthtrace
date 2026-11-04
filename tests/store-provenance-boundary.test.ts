import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '@/lib/investigator/store';
const analysis={caseTitle:'fixture',summary:'fixture',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
const evidence={id:'e',name:'fiction',kind:'text',mimeType:'text/plain',content:'承诺退款'};
const provenance={schemaVersion:2,caseId:'new',evidenceId:'e',version:1,segmentId:'e@1:0',originalHash:null,parserVersion:null,locator:{type:'text_range',start:0,end:4},verificationMethod:'exact_text'};
it('validates save-boundary provenance transactionally including new cases and historical refs',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt-ref-save-'));const s=new Store(dir);try{
 const save=(ref:unknown,content='承诺退款')=>s.saveCase({caseId:'new',evidence:[{...evidence,content}],analysis:{...analysis,people:[{id:'p',name:'虚构甲',role:'陈述者',summary:'仅原文陈述',aliases:[],evidenceRefs:[ref]}]}});
 const ref={evidenceId:'e',quote:'承诺退款',citationValidation:'validated',provenance};
 for(const bad of [{...ref,provenance:undefined},{...ref,provenance:{...provenance,caseId:'foreign'}},{...ref,provenance:{...provenance,version:99}},{...ref,quote:'已经到账'},{...ref,provenance:{...provenance,parserVersion:'forged'}},{...ref,provenance:{...provenance,originalHash:'a'.repeat(64)}},{...ref,evidenceId:'missing'}])expect(()=>save(bad)).toThrow();
 expect(s.cases()).toHaveLength(0);const created=save(ref);expect(created.analysis.people[0].evidenceRefs[0].citationValidation).toBe('validated');
 const historical=save(ref,'现在内容已更新');expect(historical.evidence[0].version).toBe(2);expect(historical.analysis.people[0].evidenceRefs[0].provenance?.version).toBe(1);
 const legacy=save({evidenceId:'e',quote:'现在内容已更新'},'现在内容已更新');expect(legacy.analysis.people[0].evidenceRefs[0].citationValidation).toBe('validated');expect(legacy.analysis.people[0].evidenceRefs[0].provenance?.version).toBe(2);
 expect(()=>save({evidenceId:'missing',quote:'承诺退款'})).toThrow();expect(()=>save({evidenceId:'e',quote:'不存在的原文'})).toThrow();
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
