import {createEvidenceRef,validateEvidenceRef} from "../evidence/provenance";
import {EvidenceIndex} from "../search";
import {segmentEvidence} from "../evidence-index/segments";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AnalysisResultSchema, EvidenceSchema, type Evidence, type EvidenceRef } from "../contracts";
import { z } from "zod";
import { TaskInputSchema, taskStages, type Task, type Segment, type TaskLease } from "./contracts";

export const CaseSchema = z.object({ caseId: z.string().min(1).default(() => randomUUID()), caseName: z.string().optional(), goal: z.string().max(4000).optional(), evidence: z.array(EvidenceSchema), analysis: AnalysisResultSchema, reviewNotes: z.record(z.string(), z.string()).optional(), notice: z.record(z.string(), z.unknown()).optional() });
export type SavedCase = z.infer<typeof CaseSchema>;
export function dataDir() { return resolve(/* turbopackIgnore: true */ process.env.TRUTHTRACE_DATA_DIR || ".truthtrace"); }
export function saveOriginal(bytes:Uint8Array) {
  const hash=createHash("sha256").update(bytes).digest("hex");const directory=join(dataDir(),"originals");mkdirSync(directory,{recursive:true});
  try{writeFileSync(join(directory,hash),bytes,{flag:"wx"});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  return hash;
}
export class Store {
  db: DatabaseSync;
  index:EvidenceIndex;
  constructor(public directory = dataDir()) {
    mkdirSync(join(directory, "objects"), { recursive: true });
    this.db = new DatabaseSync(join(directory, "cases.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS worker_health(id TEXT PRIMARY KEY, updated INTEGER);
      CREATE TABLE IF NOT EXISTS analysis_history(seq INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT, at TEXT, body TEXT);
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence(case_id TEXT, id TEXT, version INTEGER, hash TEXT, body TEXT, PRIMARY KEY(case_id,id,version));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, case_id TEXT, idem TEXT, state TEXT, lease INTEGER, owner TEXT, body TEXT, UNIQUE(case_id,idem));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, at TEXT, body TEXT);
      CREATE TABLE IF NOT EXISTS reports(task_id TEXT, revision INTEGER, body TEXT, PRIMARY KEY(task_id,revision));`);
    this.migrate();
    this.index=new EvidenceIndex(this.db);
  }
  private migrate(){const version=Number(this.db.prepare("PRAGMA user_version").get()!.user_version);if(version>2)throw new Error("数据库版本高于当前应用");if(version===2)return;this.transaction(()=>{
    const cols=new Set((this.db.prepare("PRAGMA table_info(tasks)").all() as {name:string}[]).map(x=>x.name));
    for(const name of ["revision","lease_epoch","active_ms","lifetime_active_ms"])if(!cols.has(name))this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
    this.db.exec("CREATE TABLE IF NOT EXISTS task_snapshots(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS task_revisions(task_id TEXT,revision INTEGER,body TEXT,PRIMARY KEY(task_id,revision));");
    for(const row of this.db.prepare("SELECT body FROM tasks").all() as {body:string}[]){const t=JSON.parse(row.body) as Task;if(t.schemaVersion!==2)this.saveTask(t);}
    this.db.exec("PRAGMA user_version=2");
  });}
  workerHeartbeat(id:string) { this.db.prepare("INSERT INTO worker_health VALUES(?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated").run(id,Date.now()); }
  workerReady() {return !!this.db.prepare("SELECT id FROM worker_health WHERE updated>? LIMIT 1").get(Date.now()-10000);}
  removeWorker(id:string) {this.db.prepare("DELETE FROM worker_health WHERE id=?").run(id);}
  transaction<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  cases(): SavedCase[] { return (this.db.prepare("SELECT body FROM cases").all() as {body:string}[]).map(r => JSON.parse(r.body)); }
  case(id: string): SavedCase { const row = this.db.prepare("SELECT body FROM cases WHERE id=?").get(id) as {body:string} | undefined; if (!row) throw new Error("案件不存在"); return JSON.parse(row.body); }
  saveCase(input: unknown, insideTransaction=false) {
    const c = CaseSchema.parse(input);
    const write = () => {
      const old=this.db.prepare("SELECT body FROM cases WHERE id=?").get(c.caseId) as {body:string}|undefined;
      const before=old?JSON.parse(old.body) as SavedCase:undefined;
      c.evidence = [...new Map(c.evidence.map(e => {const saved=this.saveEvidence(c.caseId,e);return [saved.id,saved] as const;})).values()];
      for(const collection of [c.analysis.people,c.analysis.relationships,c.analysis.events,c.analysis.contradictions,c.analysis.commitments,c.analysis.evidenceGaps])for(const item of collection)item.evidenceRefs=item.evidenceRefs.map(ref=>this.validateStoredRef(c.caseId,ref,c.evidence));
      this.db.prepare("INSERT INTO cases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(c.caseId, JSON.stringify(c));
      if(!insideTransaction&&before&&JSON.stringify(before.evidence.map(e=>[e.id,e.kind,e.content,e.version]))!==JSON.stringify(c.evidence.map(e=>[e.id,e.kind,e.content,e.version])))for(const t of this.tasks(c.caseId)){
        t.stale={reason:"evidence_changed",since:new Date().toISOString(),evidenceIds:c.evidence.map(e=>e.id)};
        if(["running","queued"].includes(t.state))t.state="paused";
        t.owner="";t.lease=0;t.leaseEpoch=(t.leaseEpoch||0)+1;this.saveTask(t);this.event(t.id,{type:"stale",revision:t.revision});
      }
      return c;
    };
    return insideTransaction?write():this.transaction(write);
  }
  private validateStoredRef(caseId:string,ref:EvidenceRef,current:Evidence[]):EvidenceRef {
    if(ref.citationValidation==="validated"&&!ref.provenance)throw new Error("已校验引用必须包含版本来源");
    const p=ref.provenance;
    if(!p){
      const checked=validateEvidenceRef(ref,current);
      const e=current.find(e=>e.id===ref.evidenceId)!;
      // Bind only after saveEvidence assigned a durable version. Repeated quotes are ambiguous.
      if(e.kind==="image")return checked;
      const start=e.content.indexOf(ref.quote);
      if(start<0||e.content.indexOf(ref.quote,start+1)!==-1)return checked;
      const segments:Segment[]=[];
      for(let offset=0;offset<e.content.length;offset+=4000)segments.push({id:`${e.id}@${e.version}:${offset}`,evidenceId:e.id,version:e.version!,name:e.name,kind:e.kind,start:offset,end:Math.min(offset+4000,e.content.length),content:e.content.slice(offset,offset+4000)});
      const bound=createEvidenceRef(e,start,start+ref.quote.length,{caseId,evidence:[e],segments});
      return this.validateStoredRef(caseId,{...checked,...bound},current);
    }
    if(p.caseId!==caseId||p.evidenceId!==ref.evidenceId)throw new Error("引用案件或证据身份不匹配");
    const row=this.db.prepare("SELECT body,hash FROM evidence WHERE case_id=? AND id=? AND version=?").get(caseId,ref.evidenceId,p.version) as {body:string;hash:string}|undefined;
    if(!row)throw new Error("引用历史版本不存在");
    const e={...JSON.parse(row.body),version:p.version} as Evidence;
    if(createHash("sha256").update(e.kind+"\0"+e.content).digest("hex")!==row.hash)throw new Error("证据存储hash不匹配");
    if(p.originalHash){let original:Buffer;try{original=readFileSync(join(this.directory,"originals",p.originalHash));}catch{throw new Error("引用原件不存在");}if(createHash("sha256").update(original).digest("hex")!==p.originalHash)throw new Error("引用原件hash不匹配");}
    if(ref.citationValidation==="validated"&&(e.kind==="image"||p.verificationMethod!=="exact_text"))throw new Error("视觉推测不能标记逐字校验");
    const segments:Segment[]=[];const size=e.kind==="image"?e.content.length:4000;
    for(let start=0;start<e.content.length;start+=size)segments.push({id:`${e.id}@${p.version}:${start}`,evidenceId:e.id,version:p.version,name:e.name,kind:e.kind,start,end:Math.min(start+size,e.content.length),content:e.content.slice(start,start+size)});
    return validateEvidenceRef(ref,[e],{caseId,evidence:[e],segments});
  }
  private saveEvidence(caseId: string, e: Evidence) {
    const hash = createHash("sha256").update(e.kind + "\0" + e.content).digest("hex");
    const last=this.db.prepare("SELECT version,hash,body FROM evidence WHERE case_id=? AND id=? ORDER BY version DESC LIMIT 1").get(caseId,e.id) as {version:number;hash:string;body:string}|undefined;
    const identity=(value:Evidence)=>[value.name,value.mimeType,value.source??null,value.originalHash??null,value.parserVersion??null];
    const unchanged=last?.hash===hash&&JSON.stringify(identity(JSON.parse(last.body)))===JSON.stringify(identity(e));
    const version=unchanged?last!.version:(last?.version||0)+1;
    const saved={...e,version};if(unchanged)return saved;
    try { writeFileSync(join(this.directory, "objects", hash), e.content, { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?)").run(caseId, e.id, version, hash, JSON.stringify(saved));
    this.index.replaceVersion({caseId,evidenceId:e.id,version},segmentEvidence({caseId,evidenceId:e.id,version,kind:e.kind,content:e.content,source:e.source}));
    return saved;
  }
  private boundVersion(caseId:string,e:Evidence):number {
    const hash=createHash("sha256").update(e.kind+"\0"+e.content).digest("hex");
    const row=(e.version!==undefined?this.db.prepare("SELECT version FROM evidence WHERE case_id=? AND id=? AND version=? AND hash=?").get(caseId,e.id,e.version,hash):this.db.prepare("SELECT version FROM evidence WHERE case_id=? AND id=? AND hash=? ORDER BY version DESC LIMIT 1").get(caseId,e.id,hash)) as {version:number}|undefined;
    if(!row)throw new Error("案件材料无法绑定确切历史版本");return row.version;
  }
  snapshot(caseId: string): Segment[] {
    return this.case(caseId).evidence.flatMap(e => {
      const last = {version:this.boundVersion(caseId,e)};
      const segments: Segment[] = [];
      // Exact character ranges remain valid even when a parser supplies no page/message coordinates.
      const size = e.kind === "image" ? e.content.length : 4000;
      for (let start=0; start<e.content.length; start+=size) segments.push({ id:`${e.id}@${last.version}:${start}`, evidenceId:e.id, version:last.version, name:e.name, kind:e.kind, content:e.content.slice(start,start+size), start, end:Math.min(start+size,e.content.length) });
      return segments;
    });
  }
  task(id:string):Task{
    const r=this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as {body:string;state:Task["state"];owner:string;lease:number;revision:number;lease_epoch:number;active_ms:number;lifetime_active_ms:number}|undefined;if(!r)throw new Error("任务不存在");
    const t=JSON.parse(r.body) as Task;
    if(t.snapshotId){const snap=this.db.prepare("SELECT body FROM task_snapshots WHERE id=?").get(t.snapshotId) as {body:string}|undefined;if(!snap)throw new Error("快照缺失");t.snapshot=JSON.parse(snap.body);}
    return {...t,state:r.state,owner:r.owner,lease:r.lease,revision:r.revision,leaseEpoch:r.lease_epoch,activeMs:r.active_ms,lifetimeActiveMs:r.lifetime_active_ms};
  }
  tasks(caseId:string):Task[]{return (this.db.prepare("SELECT id FROM tasks WHERE case_id=? ORDER BY rowid DESC").all(caseId) as {id:string}[]).map(r=>this.task(r.id));}
  taskSummaries(caseId:string){return (this.db.prepare("SELECT id,state,revision,body FROM tasks WHERE case_id=? ORDER BY rowid DESC").all(caseId) as {id:string;state:string;revision:number;body:string}[]).map(r=>{const t=JSON.parse(r.body);return {id:r.id,state:r.state,revision:r.revision,goal:t.goal,step:t.step,mode:t.mode,stale:t.stale,modelCalls:t.modelCalls,toolCalls:t.toolCalls,snapshotId:t.snapshotId};});}
  private indexVersion(caseId:string,evidenceId:string,version:number){
    const exists=this.db.prepare("SELECT 1 FROM tt_search_segments WHERE case_id=? AND evidence_id=? AND version=? LIMIT 1").get(caseId,evidenceId,version);if(exists)return;
    const {evidence}=this.evidenceVersion(caseId,evidenceId,version);this.index.replaceVersion({caseId,evidenceId,version},segmentEvidence({caseId,evidenceId,version,kind:evidence.kind,content:evidence.content,source:evidence.source}));
  }
  searchCase(caseId:string,query:string,offset=0){const c=this.case(caseId);const grants=c.evidence.map(e=>({caseId,evidenceId:e.id,version:this.boundVersion(caseId,e)}));for(const g of grants)this.indexVersion(g.caseId,g.evidenceId,g.version);return this.index.search(query,{authorizedVersions:grants,topK:20,offset,expand:true});}
  searchSnapshot(t:Task,query:string){const grants=[...new Map(t.snapshot.map(s=>[s.evidenceId+"@"+s.version,{caseId:t.caseId,evidenceId:s.evidenceId,version:s.version}])).values()];for(const g of grants)this.indexVersion(g.caseId,g.evidenceId,g.version);const result=this.index.search(query,{authorizedVersions:grants,topK:100,expand:true});const matches=[...new Map(result.hits.flatMap(h=>t.snapshot.filter(s=>h.evidenceId===s.evidenceId&&h.version===s.version&&h.start<s.end&&h.end>s.start)).map(s=>[s.id,s])).values()];return {...result,matches};}
  evidenceVersion(caseId:string,id:string,version:number){this.case(caseId);if(!Number.isSafeInteger(version)||version<1)throw new Error("无效版本");const r=this.db.prepare("SELECT version,hash,body FROM evidence WHERE case_id=? AND id=? AND version=?").get(caseId,id,version) as {version:number;hash:string;body:string}|undefined;if(!r)throw new Error("版本不存在");return {evidence:{...JSON.parse(r.body),version:r.version},version:r.version,hash:r.hash};}
  evidenceVersions(caseId:string,id:string){this.case(caseId);return this.db.prepare("SELECT version,hash FROM evidence WHERE case_id=? AND id=? ORDER BY version").all(caseId,id);}
  createTask(caseId:string, input:unknown): Task {
    const data = TaskInputSchema.parse(input);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM tasks WHERE case_id=? AND idem=?").get(caseId,data.idempotencyKey) as {id:string}|undefined;
      if(existing) return this.task(existing.id);
      if(this.tasks(caseId).some(t=>["queued","running","waiting_user","paused"].includes(t.state))) throw new Error("本案已有未结束调查，请先继续或取消该任务");
      const task: Task = {id:randomUUID(),caseId,goal:data.goal,mode:data.mode,scope:data.scope,state:"queued",step:0,revision:1,modelCalls:0,toolCalls:0,activeMs:0,error:"",snapshot:this.snapshot(caseId),artifacts:[],reads:[],decisions:[],createdAt:new Date().toISOString(),lease:0,owner:""};
      this.db.prepare("INSERT INTO tasks(id,case_id,idem,state,lease,owner,body) VALUES(?,?,?,?,?,?,?)").run(task.id,caseId,data.idempotencyKey,task.state,0,"",JSON.stringify(task));
      this.saveTask(task);this.event(task.id,{type:"created"}); return this.task(task.id);
    });
  }
  saveTask(t:Task){const snapshot=JSON.stringify(t.snapshot);const snapshotId=createHash("sha256").update(snapshot).digest("hex");this.db.prepare("INSERT OR IGNORE INTO task_snapshots VALUES(?,?)").run(snapshotId,snapshot);
    const body={...t,schemaVersion:2,snapshotId,snapshot:undefined,lifetimeModelCalls:t.lifetimeModelCalls??t.modelCalls,lifetimeToolCalls:t.lifetimeToolCalls??t.toolCalls,lifetimeActiveMs:t.lifetimeActiveMs??t.activeMs};
    this.db.prepare("UPDATE tasks SET state=?,lease=?,owner=?,body=?,revision=?,lease_epoch=?,active_ms=?,lifetime_active_ms=? WHERE id=?").run(t.state,t.lease,t.owner,JSON.stringify(body),t.revision,t.leaseEpoch||0,t.activeMs,body.lifetimeActiveMs,t.id);
  }
  lease(t:Task):TaskLease{return {taskId:t.id,owner:t.owner,revision:t.revision,leaseEpoch:t.leaseEpoch||0};}
  renewLease(l:TaskLease,now=Date.now(),elapsed=0){return this.db.prepare("UPDATE tasks SET lease=?,active_ms=active_ms+?,lifetime_active_ms=lifetime_active_ms+? WHERE id=? AND owner=? AND revision=? AND lease_epoch=? AND state='running' AND lease>=?").run(now+30000,elapsed,elapsed,l.taskId,l.owner,l.revision,l.leaseEpoch,now).changes===1;}
  saveReport(l:TaskLease,body:string):void{if(!this.db.isTransaction){this.transaction(()=>this.saveReport(l,body));return;}const t=this.task(l.taskId);if(t.owner!==l.owner||t.revision!==l.revision||t.leaseEpoch!==l.leaseEpoch||t.lease<Date.now())throw new Error("报告租约失效");this.db.prepare("INSERT INTO reports VALUES(?,?,?) ON CONFLICT(task_id,revision) DO UPDATE SET body=excluded.body").run(t.id,t.revision,body);}
  event(id:string, body:unknown) { this.db.prepare("INSERT INTO events(task_id,at,body) VALUES(?,?,?)").run(id,new Date().toISOString(),JSON.stringify(body)); }
  events(id:string, after=0) { this.task(id); return this.db.prepare("SELECT seq,at,body FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 200").all(id,after); }
  claim(owner:string): Task | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT id FROM tasks WHERE state='queued' OR (state='running' AND lease<?) ORDER BY rowid LIMIT 1").get(Date.now()) as {id:string}|undefined;
      if(!row) return;
      const t=this.task(row.id); t.state="running";t.leaseEpoch=(t.leaseEpoch||0)+1; t.owner=owner; t.lease=Date.now()+30000; this.saveTask(t); return t;
    });
  }
  owned(l:TaskLease,fn:(t:Task)=>void){return this.transaction(()=>{const t=this.task(l.taskId);if(t.state!=="running"||t.owner!==l.owner||t.revision!==l.revision||t.leaseEpoch!==l.leaseEpoch||t.lease<Date.now())return false;const calls=t.modelCalls,tools=t.toolCalls;fn(t);t.lifetimeModelCalls=(t.lifetimeModelCalls??calls)+Math.max(0,t.modelCalls-calls);t.lifetimeToolCalls=(t.lifetimeToolCalls??tools)+Math.max(0,t.toolCalls-tools);this.saveTask(t);return true;});}
  action(id:string,action:string,goal?:string) {
    return this.transaction(()=>{
      const t=this.task(id);
      this.db.prepare("INSERT OR IGNORE INTO task_revisions VALUES(?,?,?)").run(t.id,t.revision,JSON.stringify(t));
      if(action==="pause" && ["running","queued","waiting_user"].includes(t.state)) t.state="paused";
      else if(action==="cancel" && t.state!=="completed") t.state="cancelled";
      else if(["resume","retry"].includes(action) && ["paused","failed","waiting_user"].includes(t.state)) { t.state="queued"; t.error=""; }
      else if(action==="revise") { if(this.tasks(t.caseId).some(other=>other.id!==t.id&&["queued","running","waiting_user","paused"].includes(other.state)))throw new Error("本案已有其他正在进行的调查"); t.stale=undefined;t.executionPlan=undefined;t.executionOutcome=undefined;t.goal=goal?.trim()||t.goal; t.snapshot=this.snapshot(t.caseId); t.artifacts=[]; t.reads=[]; t.step=0; t.revision++; t.modelCalls=0;t.toolCalls=0;t.activeMs=0;t.collectedSources=0;t.collectionNotes=[];t.error="";t.state="queued"; }
      else throw new Error("当前状态不支持此操作");
      if(action==="cancel")t.executionOutcome="stop";t.owner=""; t.lease=0; this.saveTask(t);this.event(id,{type:"action",action});return t;
    });
  }
  decision(id:string,decision:{id:string;value:string;reason:string}) {
    return this.transaction(()=>{
      const t=this.task(id);
      if(!["waiting_user","paused"].includes(t.state))throw new Error("当前状态不支持提交判断，请先暂停调查");
      if(this.tasks(t.caseId).some(other=>other.id!==id&&["queued","running","waiting_user","paused"].includes(other.state)))throw new Error("本案已有其他正在进行的调查");
      if(t.decisions.some(d=>d.id===decision.id))throw new Error("决定项已提交，请勿重复提交");
      if(!t.artifacts.some(a=>a.decisions.some(d=>d.id===decision.id)))throw new Error("决定项不存在");
      this.db.prepare("INSERT OR IGNORE INTO task_revisions VALUES(?,?,?)").run(t.id,t.revision,JSON.stringify(t));
      t.decisions.push({...decision,at:new Date().toISOString()});
      // Decisions invalidate derived findings, not source claims (including later replan extractions).
      t.artifacts=t.artifacts.filter(a=>a.claims.length||a.plan.length).map(a=>({...a,summary:"保留原文主张和计划；衍生结果将在用户判断后重新核查。",people:[],relationships:[],events:[],conflicts:[],commitments:[],checks:[],findingChecks:[],decisions:[],gaps:[],answer:undefined}));
      t.step=taskStages(t.mode).find(stage=>stage>=3)!;t.revision++;t.executionPlan=undefined;t.executionOutcome=undefined;t.error="";t.state="queued";t.owner="";t.lease=0;t.leaseEpoch=(t.leaseEpoch||0)+1;
      this.saveTask(t);this.event(id,{type:"decision",...decision});return t;
    });
  }
  close() {this.db.close();}
}
