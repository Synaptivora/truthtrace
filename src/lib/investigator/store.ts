import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AnalysisResultSchema, EvidenceSchema, type Evidence } from "../contracts";
import { z } from "zod";
import { TaskInputSchema, taskStages, type Task, type Segment } from "./contracts";

export const CaseSchema = z.object({ caseId: z.string().min(1).default(() => randomUUID()), caseName: z.string().optional(), evidence: z.array(EvidenceSchema), analysis: AnalysisResultSchema, reviewNotes: z.record(z.string(), z.string()).optional(), notice: z.record(z.string(), z.unknown()).optional() });
export type SavedCase = z.infer<typeof CaseSchema>;
export function dataDir() { return resolve(/* turbopackIgnore: true */ process.env.TRUTHTRACE_DATA_DIR || ".truthtrace"); }
export function saveOriginal(bytes:Uint8Array) {
  const hash=createHash("sha256").update(bytes).digest("hex");const directory=join(dataDir(),"originals");mkdirSync(directory,{recursive:true});
  try{writeFileSync(join(directory,hash),bytes,{flag:"wx"});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  return hash;
}
export class Store {
  db: DatabaseSync;
  constructor(public directory = dataDir()) {
    mkdirSync(join(directory, "objects"), { recursive: true });
    this.db = new DatabaseSync(join(directory, "cases.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence(case_id TEXT, id TEXT, version INTEGER, hash TEXT, body TEXT, PRIMARY KEY(case_id,id,version));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, case_id TEXT, idem TEXT, state TEXT, lease INTEGER, owner TEXT, body TEXT, UNIQUE(case_id,idem));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, at TEXT, body TEXT);
      CREATE TABLE IF NOT EXISTS reports(task_id TEXT, revision INTEGER, body TEXT, PRIMARY KEY(task_id,revision));`);
  }
  transaction<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  cases(): SavedCase[] { return (this.db.prepare("SELECT body FROM cases").all() as {body:string}[]).map(r => JSON.parse(r.body)); }
  case(id: string): SavedCase { const row = this.db.prepare("SELECT body FROM cases WHERE id=?").get(id) as {body:string} | undefined; if (!row) throw new Error("案件不存在"); return JSON.parse(row.body); }
  saveCase(input: unknown, insideTransaction=false) {
    const c = CaseSchema.parse(input);
    const write = () => {
      const aliases=new Map<string,string>();
      c.evidence = [...new Map(c.evidence.map(e => {const saved=this.saveEvidence(c.caseId,e);aliases.set(e.id,saved.id);return [saved.id,saved] as const;})).values()];
      for(const collection of [c.analysis.people,c.analysis.relationships,c.analysis.events,c.analysis.contradictions,c.analysis.commitments,c.analysis.evidenceGaps])for(const item of collection)for(const ref of item.evidenceRefs)ref.evidenceId=aliases.get(ref.evidenceId)||ref.evidenceId;
      this.db.prepare("INSERT INTO cases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(c.caseId, JSON.stringify(c));
      return c;
    };
    return insideTransaction?write():this.transaction(write);
  }
  private saveEvidence(caseId: string, e: Evidence) {
    const hash = createHash("sha256").update(e.kind + "\0" + e.content).digest("hex");
    const same = this.db.prepare("SELECT body FROM evidence WHERE case_id=? AND hash=? ORDER BY version DESC LIMIT 1").get(caseId, hash) as {body:string} | undefined;
    if (same) return JSON.parse(same.body) as Evidence;
    const last = this.db.prepare("SELECT MAX(version) AS version FROM evidence WHERE case_id=? AND id=?").get(caseId, e.id) as {version:number|null};
    const version = (last.version || 0) + 1;
    try { writeFileSync(join(this.directory, "objects", hash), e.content, { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?)").run(caseId, e.id, version, hash, JSON.stringify(e));
    return e;
  }
  snapshot(caseId: string): Segment[] {
    return this.case(caseId).evidence.flatMap(e => {
      const last = this.db.prepare("SELECT MAX(version) AS version FROM evidence WHERE case_id=? AND id=?").get(caseId,e.id) as {version:number};
      const segments: Segment[] = [];
      // Exact character ranges remain valid even when a parser supplies no page/message coordinates.
      const size = e.kind === "image" ? e.content.length : 4000;
      for (let start=0; start<e.content.length; start+=size) segments.push({ id:`${e.id}@${last.version}:${start}`, evidenceId:e.id, version:last.version, name:e.name, kind:e.kind, content:e.content.slice(start,start+size), start, end:Math.min(start+size,e.content.length) });
      return segments;
    });
  }
  task(id: string): Task { const row = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id) as {body:string} | undefined; if (!row) throw new Error("任务不存在"); return JSON.parse(row.body); }
  tasks(caseId: string): Task[] { return (this.db.prepare("SELECT body FROM tasks WHERE case_id=? ORDER BY rowid DESC").all(caseId) as {body:string}[]).map(r=>JSON.parse(r.body)); }
  createTask(caseId:string, input:unknown): Task {
    const data = TaskInputSchema.parse(input);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM tasks WHERE case_id=? AND idem=?").get(caseId,data.idempotencyKey) as {id:string}|undefined;
      if(existing) return this.task(existing.id);
      if(this.tasks(caseId).some(t=>["queued","running","waiting_user","paused"].includes(t.state))) throw new Error("本案已有未结束调查，请先继续或取消该任务");
      const task: Task = {id:randomUUID(),caseId,goal:data.goal,mode:data.mode,scope:data.scope,state:"queued",step:0,revision:1,modelCalls:0,toolCalls:0,activeMs:0,error:"",snapshot:this.snapshot(caseId),artifacts:[],reads:[],decisions:[],createdAt:new Date().toISOString(),lease:0,owner:""};
      this.db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)").run(task.id,caseId,data.idempotencyKey,task.state,0,"",JSON.stringify(task));
      this.event(task.id,{type:"created"}); return task;
    });
  }
  saveTask(t:Task) { this.db.prepare("UPDATE tasks SET state=?,lease=?,owner=?,body=? WHERE id=?").run(t.state,t.lease,t.owner,JSON.stringify(t),t.id); }
  event(id:string, body:unknown) { this.db.prepare("INSERT INTO events(task_id,at,body) VALUES(?,?,?)").run(id,new Date().toISOString(),JSON.stringify(body)); }
  events(id:string, after=0) { this.task(id); return this.db.prepare("SELECT seq,at,body FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 200").all(id,after); }
  claim(owner:string): Task | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT id FROM tasks WHERE state='queued' OR (state='running' AND lease<?) ORDER BY rowid LIMIT 1").get(Date.now()) as {id:string}|undefined;
      if(!row) return;
      const t=this.task(row.id); t.state="running"; t.owner=owner; t.lease=Date.now()+30000; this.saveTask(t); return t;
    });
  }
  owned(id:string,owner:string,fn:(t:Task)=>void) {
    return this.transaction(()=>{const t=this.task(id); if(t.state!=="running"||t.owner!==owner||t.lease<Date.now()) return false; fn(t); this.saveTask(t); return true;});
  }
  action(id:string,action:string,goal?:string) {
    return this.transaction(()=>{
      const t=this.task(id);
      if(action==="pause" && ["running","queued","waiting_user"].includes(t.state)) t.state="paused";
      else if(action==="cancel" && t.state!=="completed") t.state="cancelled";
      else if(["resume","retry"].includes(action) && ["paused","failed","waiting_user"].includes(t.state)) { t.state="queued"; t.error=""; }
      else if(action==="revise" && t.state!=="running") { t.goal=goal?.trim()||t.goal; t.snapshot=this.snapshot(t.caseId); t.artifacts=[]; t.reads=[]; t.step=0; t.revision++; t.modelCalls=0;t.toolCalls=0;t.activeMs=0;t.collectedSources=0;t.collectionNotes=[];t.error="";t.state="queued"; }
      else throw new Error("当前状态不支持此操作");
      t.owner=""; t.lease=0; this.saveTask(t);this.event(id,{type:"action",action});return t;
    });
  }
  decision(id:string,decision:{id:string;value:string;reason:string}) {
    return this.transaction(()=>{const t=this.task(id);if(t.state==="running")throw new Error("请先暂停调查，再提交判断");if(!t.artifacts.some(a=>a.decisions.some(d=>d.id===decision.id))) throw new Error("决定项不存在"); t.decisions.push({...decision,at:new Date().toISOString()});t.artifacts=t.artifacts.slice(0,3);t.step=taskStages(t.mode).find(stage=>stage>=3)!;t.revision++;t.state="queued";t.owner="";t.lease=0; this.saveTask(t); this.event(id,{type:"decision",...decision}); return t;});
  }
  close() {this.db.close();}
}
