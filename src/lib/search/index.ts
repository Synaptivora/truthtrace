import { expandQuery } from './queries';
import { DatabaseSync } from 'node:sqlite';
import type { IndexedSegment,VersionScope } from '../evidence-index/segments';
export type SearchOptions={authorizedVersions:VersionScope[];topK?:number;offset?:number;source?:string;expand?:boolean};
export class EvidenceIndex {
 readonly strategy='fts5-trigram-with-short-substring' as const;
 constructor(readonly db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS tt_search_segments(id TEXT PRIMARY KEY,case_id TEXT NOT NULL,evidence_id TEXT NOT NULL,version INTEGER NOT NULL,source TEXT NOT NULL,body TEXT NOT NULL,payload TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS tt_search_scope ON tt_search_segments(case_id,evidence_id,version);
  CREATE VIRTUAL TABLE IF NOT EXISTS tt_search_fts USING fts5(body,tokenize='trigram');`);
 }
 replaceVersion(scope:VersionScope,segments:IndexedSegment[]){
  if(segments.some(s=>s.caseId!==scope.caseId||s.evidenceId!==scope.evidenceId||s.version!==scope.version||s.end-s.start!==s.content.length))throw Error('Segment scope mismatch');
  this.db.exec('SAVEPOINT tt_index_write');
  try{
   this.db.prepare('DELETE FROM tt_search_fts WHERE rowid IN (SELECT rowid FROM tt_search_segments WHERE case_id=? AND evidence_id=? AND version=?)').run(scope.caseId,scope.evidenceId,scope.version);
   this.db.prepare('DELETE FROM tt_search_segments WHERE case_id=? AND evidence_id=? AND version=?').run(scope.caseId,scope.evidenceId,scope.version);
   const insert=this.db.prepare('INSERT INTO tt_search_segments(id,case_id,evidence_id,version,source,body,payload) VALUES(?,?,?,?,?,?,?)');
   for(const s of segments){const r=insert.run(s.id,s.caseId,s.evidenceId,s.version,s.source,s.content,JSON.stringify(s));this.db.prepare('INSERT INTO tt_search_fts(rowid,body) VALUES(?,?)').run(r.lastInsertRowid,s.content);}
   this.db.exec('RELEASE tt_index_write');
  }catch(e){this.db.exec('ROLLBACK TO tt_index_write; RELEASE tt_index_write');throw e;}
 }
 nearby(segmentId:string,options:SearchOptions,radius=1):IndexedSegment[]{
  if(!Number.isInteger(radius)||radius<0||radius>5)throw Error('Invalid context radius');
  // Reuse scope validation before looking up any identifier.
  this.search('',{...options,topK:1});
  const row=this.db.prepare('SELECT payload FROM tt_search_segments WHERE id=?').get(segmentId);
  if(!row)return [];
  const target=JSON.parse(String(row.payload)) as IndexedSegment;
  if(!options.authorizedVersions.some(s=>s.caseId===target.caseId&&s.evidenceId===target.evidenceId&&s.version===target.version)||options.source!==undefined&&options.source!==target.source)return [];
  const rows=this.db.prepare("SELECT payload FROM tt_search_segments WHERE case_id=? AND evidence_id=? AND version=? AND source=? ORDER BY CAST(json_extract(payload,'$.start') AS INTEGER),id").all(target.caseId,target.evidenceId,target.version,target.source);
  const segments=rows.map(r=>JSON.parse(String(r.payload)) as IndexedSegment);const at=segments.findIndex(s=>s.id===segmentId);
  return segments.slice(Math.max(0,at-radius),at+radius+1);
 }

 search(query:string,options:SearchOptions){
  const topK=options.topK??10,offset=options.offset??0;
  if(!Number.isInteger(topK)||topK<1||topK>100||!Number.isInteger(offset)||offset<0||query.length>200)throw Error('Invalid query bounds');
  if(!Array.isArray(options.authorizedVersions)||options.authorizedVersions.length>256)throw Error('Authorized scope exceeds 256 versions or is invalid; split explicit scope batches, never truncate');
  const scopes=options.authorizedVersions;
  if(scopes.some(s=>!s.caseId||!s.evidenceId||!Number.isInteger(s.version)||s.version<1))throw Error("Invalid version grant");
  if(!scopes.length)return {hits:[],total:0,nextOffset:null,coverage:{authorizedSegments:0,returned:0,unreturned:0},strategy:this.strategy};
  const where=`(${scopes.map(()=>'(s.case_id=? AND s.evidence_id=? AND s.version=?)').join(' OR ')})${options.source!==undefined?' AND s.source=?':''}`;
  const params:(string|number)[]=scopes.flatMap(s=>[s.caseId,s.evidenceId,s.version]);if(options.source!==undefined)params.push(options.source);
  const authorizedSegments=Number(this.db.prepare(`SELECT count(*) n FROM tt_search_segments s WHERE ${where}`).get(...params)!.n);
  const trimmed=query.trim();const queries=options.expand?expandQuery(query):[trimmed];const useFts=queries.every(q=>[...q].length>=3);
  const from=useFts?'tt_search_fts JOIN tt_search_segments s ON s.rowid=tt_search_fts.rowid':'tt_search_segments s';
  const clause=useFts?' AND tt_search_fts MATCH ?':trimmed?' AND ('+queries.map(()=> 'instr(lower(s.body),lower(?))>0').join(' OR ')+')':'';
  const values=[...params,...(trimmed?(useFts?[queries.map(q=>'"'+q.replaceAll('"','""')+'"').join(' OR ')]:queries):[])];
  const total=Number(this.db.prepare(`SELECT count(*) n FROM ${from} WHERE ${where}${clause}`).get(...values)!.n);
  const rows=this.db.prepare(`SELECT s.payload FROM ${from} WHERE ${where}${clause} ORDER BY ${useFts?'bm25(tt_search_fts),':''}s.id LIMIT ? OFFSET ?`).all(...values,topK,offset);
  const hits=rows.map(row=>JSON.parse(String(row.payload)) as IndexedSegment);
  return {hits,total,nextOffset:offset+hits.length<total?offset+hits.length:null,coverage:{authorizedSegments,returned:hits.length,unreturned:authorizedSegments-hits.length},queries,strategy:this.strategy};
 }
}
/** Auditable suggestions only; callers record which queries actually execute. */
export function counterevidenceQueries(topic:string){const q=topic.trim().slice(0,100);return q?[q,`${q} 未`,`${q} 没有`,`${q} 部分`,`${q} 更正`]:[];}
