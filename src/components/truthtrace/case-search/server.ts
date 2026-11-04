import { commitmentProjection } from "@/lib/commitments";
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store } from '@/lib/investigator/store';
import { EvidenceIndex } from '@/lib/search';
import { segmentEvidence } from '@/lib/evidence-index/segments';
export const FilterSchema=z.object({q:z.string().max(200).default(''),caseId:z.string().optional(),source:z.string().max(100).optional(),from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),personId:z.string().optional(),tag:z.string().max(40).optional(),archived:z.enum(['all','yes','no']).default('no'),offset:z.coerce.number().int().min(0).default(0)}).strict();
export const MetadataSchema=z.object({caseId:z.string().min(1),tags:z.array(z.string().trim().min(1).max(40)).max(20),archived:z.boolean()}).strict();
export function metadata(store:Store){store.db.exec('CREATE TABLE IF NOT EXISTS tt_case_metadata(case_id TEXT PRIMARY KEY,tags TEXT NOT NULL,archived INTEGER NOT NULL)');return new Map((store.db.prepare('SELECT * FROM tt_case_metadata').all() as {case_id:string;tags:string;archived:number}[]).map(r=>[r.case_id,{tags:JSON.parse(r.tags) as string[],archived:!!r.archived}]));}
export function updateMetadata(store:Store,input:unknown){const value=MetadataSchema.parse(input);store.case(value.caseId);metadata(store);store.db.prepare('INSERT INTO tt_case_metadata VALUES(?,?,?) ON CONFLICT(case_id) DO UPDATE SET tags=excluded.tags,archived=excluded.archived').run(value.caseId,JSON.stringify([...new Set(value.tags)]),Number(value.archived));return value;}
export function searchCases(store:Store,input:unknown){
 const filters=FilterSchema.parse(input);if(filters.from&&filters.to&&filters.from>filters.to)throw Error('Invalid date range');
 const meta=metadata(store);const cases=store.cases(); // Local single-user only; route remote mode fails closed.
 const catalog=cases.map(c=>({caseId:c.caseId,name:c.caseName||c.analysis.caseTitle,...(meta.get(c.caseId)||{tags:[],archived:false}),people:c.analysis.people.map(p=>({id:p.id,name:p.name})),commitments:c.analysis.commitments.length}));
 const db=new DatabaseSync(':memory:');
 try{const index=new EvidenceIndex(db);const matches=[];
 for(const c of cases){const m=meta.get(c.caseId)||{tags:[],archived:false};if(filters.caseId&&c.caseId!==filters.caseId||filters.tag&&!m.tags.includes(filters.tag)||filters.archived!=='all'&&m.archived!==(filters.archived==='yes'))continue;
 const person=filters.personId?c.analysis.people.find(p=>p.id===filters.personId):null;if(filters.personId&&!person)continue;
 for(const e of c.evidence){if(person&&!person.evidenceRefs.some(ref=>ref.evidenceId===e.id))continue;
 const scope={caseId:c.caseId,evidenceId:e.id,version:e.version||1};const segments=segmentEvidence({...scope,content:e.content,kind:e.kind,source:e.source});index.replaceVersion(scope,segments);
 let offset=0;for(;;){const page=index.search(filters.q,{authorizedVersions:[scope],source:filters.source,topK:100,offset,expand:true});
 for(const hit of page.hits){if(filters.from||filters.to){const dates=hit.content.match(/\d{4}-\d{2}-\d{2}/g)||[];if(!dates.some(d=>(!filters.from||d>=filters.from)&&(!filters.to||d<=filters.to)))continue;}
 matches.push({...hit,caseName:c.caseName||c.analysis.caseTitle,evidenceName:e.name,verification:'not_checked' as const});if(matches.length>10000)throw Error('Too many matches; narrow search');}
 if(page.nextOffset===null)break;offset=page.nextOffset;}
 index.replaceVersion(scope,[]);
 }}
 matches.sort((a,b)=>a.caseId.localeCompare(b.caseId)||a.evidenceId.localeCompare(b.evidenceId)||a.start-b.start);
 return {cases:catalog,commitments:cases.flatMap(c=>commitmentProjection(c)),hits:matches.slice(filters.offset,filters.offset+20),total:matches.length,nextOffset:filters.offset+20<matches.length?filters.offset+20:null,note:'按材料原文检索；未做事实核实。日期仅匹配明确日期，人物仅为候选关联。'};
 }finally{db.close();}
}
