import { expect,test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EvidenceIndex,counterevidenceQueries } from '../src/lib/search';
import { segmentEvidence } from '../src/lib/evidence-index/segments';
test('original UTF16 ranges and explicit page anchors remain traceable',()=>{
 const input={caseId:'a',evidenceId:'e',version:1,kind:'pdf',content:'甲😀退款\n未到账',anchors:[{start:0,end:6,page:3},{start:6,end:10,page:4}]};
 // Reject fabricated out-of-range anchors rather than correcting them.
 expect(()=>segmentEvidence(input,3)).toThrow();
 const valid={...input,anchors:[{start:0,end:input.content.length,page:3}]};
 const pieces=segmentEvidence(valid,3);expect(pieces.map(s=>s.content).join('')).toBe(input.content);
 for(const s of pieces){expect(input.content.slice(s.start,s.end)).toBe(s.content);expect(s.page).toBe(3);expect(s.messageId).toBeNull();}
});
test('Chinese long/short lookup, exact scope filtering, pagination and atomic replacement',()=>{
 const db=new DatabaseSync(':memory:');try{
 const index=new EvidenceIndex(db);const scope={caseId:'a',evidenceId:'e',version:1};
 for(const version of [1,2])index.replaceVersion({...scope,version},segmentEvidence({...scope,version,kind:'chat',content:'承诺退款100元\n退款尚未到账\n仅部分退款40元'}));
 index.replaceVersion({caseId:'other',evidenceId:'secret',version:1},segmentEvidence({caseId:'other',evidenceId:'secret',version:1,kind:'text',content:'退款尚未到账 私密'}));
 const opts={authorizedVersions:[scope],topK:1};const first=index.search('退款',opts);
 expect(first.total).toBe(3);expect(first.nextOffset).toBe(1);expect(first.coverage.authorizedSegments).toBe(3);
 expect(index.search('未到账',opts).hits[0].content).toContain('未到账');
 expect(index.search('退款',{authorizedVersions:[]}).total).toBe(0);
 expect(index.search('私密',opts).total).toBe(0);
 expect(index.search('" OR *',opts).total).toBe(0);
 const second=index.search('退款',{...opts,offset:1});expect(second.hits[0].id).not.toBe(first.hits[0].id);
 expect(first.hits.every(s=>s.version===1&&s.caseId==='a')).toBe(true);
 index.replaceVersion(scope,segmentEvidence({...scope,kind:'text',content:'新索引'}));expect(index.search('退款',opts).total).toBe(0);
 expect(index.search('退款',{authorizedVersions:[{...scope,version:2}]}).total).toBe(3);
 expect(counterevidenceQueries('退款')).toContain('退款 未');
 }finally{db.close();}
});
test('measured trigram vs unicode61 on an unspaced Chinese substring',()=>{
 const db=new DatabaseSync(':memory:');try{for(const tokenizer of ['unicode61','trigram'])db.exec(`CREATE VIRTUAL TABLE ${tokenizer} USING fts5(body,tokenize='${tokenizer}'); INSERT INTO ${tokenizer}(body) VALUES('客户表示退款尚未到账');`);
 expect(db.prepare("SELECT count(*) n FROM unicode61 WHERE unicode61 MATCH '未到账'").get()!.n).toBe(0);
 expect(db.prepare("SELECT count(*) n FROM trigram WHERE trigram MATCH '未到账'").get()!.n).toBe(1);
 }finally{db.close();}
});
