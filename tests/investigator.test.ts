import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, saveOriginal } from "@/lib/investigator/store";
import { saveConnection, savedConnection } from "@/lib/investigator/connections";
import { readJson } from "@/lib/agent/http";
import { ArtifactSchema, taskStages, suggestMode } from "@/lib/investigator/contracts";
import { validateArtifact, runTask } from "@/lib/investigator/runtime";
import type { modelStep } from "@/lib/agent/transport";

let dir:string,store:Store;
const evidence={id:"e1",name:"聊天",kind:"text",mimeType:"text/plain",content:"小王说：周五退款。"};
const analysis={caseTitle:"退款",summary:"待核对",people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:"2026-11-02",analysisMode:"rule"};
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),"truthtrace-test-"));vi.stubEnv("TRUTHTRACE_DATA_DIR",dir);vi.stubEnv("AGENT_PROVIDER","ollama");vi.stubEnv("AGENT_MODEL","fixture");store=new Store(dir);store.saveCase({caseId:"case1",evidence:[evidence],analysis});});
afterEach(()=>{store.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
const create=()=>store.createTask("case1",{goal:"核对退款",idempotencyKey:"one"});
describe("investigator durability and provenance",()=>{
  it("revises a running task atomically and rejects the old worker result",()=>{
    const t=create();store.claim("old-worker");
    store.saveCase({caseId:"case1",evidence:[evidence,{...evidence,id:"e2",content:"尚未到账"}],analysis});
    const next=store.action(t.id,"revise");
    expect(next.revision).toBe(2);expect(next.snapshot).toHaveLength(2);expect(next.state).toBe("queued");
    expect(store.owned(t.id,"old-worker",task=>{task.step=8;})).toBe(false);
  });
  it("detects live worker heartbeats and expires stale workers",()=>{
    expect(store.workerReady()).toBe(false);store.workerHeartbeat("worker");expect(store.workerReady()).toBe(true);
    store.db.prepare("UPDATE worker_health SET updated=?").run(Date.now()-20000);expect(store.workerReady()).toBe(false);
  });
  it("rejects answers that cite unknown or unreviewed claims",()=>{
    const t=create();t.step=7;
    expect(()=>validateArtifact(t,{summary:"",answer:{text:"已退款",claimIds:["invented"]}})).toThrow("已经独立核查");
  });
  it("recommends a route while keeping ambiguous goals and legacy tasks comprehensive",()=>{
    expect(suggestMode("核查有没有退款日期")).toBe("fact");
    expect(suggestMode("梳理事件时间线")).toBe("timeline");
    expect(suggestMode("梳理矛盾与其他解释")).toBe("deep");
    expect(suggestMode("帮我看看")).toBe("deep");
    expect(taskStages()).toHaveLength(8);
  });
  it.each(["fact", "timeline"] as const)("executes the %s route without skipping independent verification",async mode=>{
    const t=store.createTask("case1",{goal:"核对退款",mode,idempotencyKey:mode});
    const visited:number[]=[];
    await runTask(store,store.claim("worker")!,async()=>{
      const current=store.task(t.id),s=current.snapshot[0];
      if(current.step===2&&!current.reads.length)return {text:"",raw:undefined,calls:[{id:"read",name:"read_evidence",arguments:JSON.stringify({segmentId:s.id})}]};
      visited.push(current.step);
      const artifact={summary:"处理完成",...(current.step===0?{plan:["核查退款"]}:{}),...(current.step===2?{claims:[{id:"c",content:"承诺周五退款",kind:"statement",refs:[{evidenceId:s.evidenceId,version:s.version,segmentId:s.id,quote:"周五退款"}]}]}:{}),...(current.step===6?{checks:[{claimId:"c",status:"supported",reason:"仅支持承诺存在"}]}:{})};
      return {text:"",raw:undefined,calls:[{id:"submit",name:"submit_artifact",arguments:JSON.stringify(artifact)}]};
    });
    expect(visited).toEqual(taskStages(mode));
    expect(store.task(t.id).state).toBe("completed");
    store.close();store=new Store(dir);expect(store.task(t.id).mode).toBe(mode);
  });
  it("resumes a fact-check decision at verification, not a skipped entity stage",()=>{
    const t=store.createTask("case1",{goal:"核查退款",mode:"fact",idempotencyKey:"decision"});
    t.state="waiting_user";t.step=8;
    t.artifacts=[ArtifactSchema.parse({summary:"",decisions:[{id:"d",question:"补充凭证？",claimIds:["c"]}]})];
    store.saveTask(t);
    expect(store.decision(t.id,{id:"d",value:"accepted",reason:"已补充"}).step).toBe(6);
  });
  it("persists across reopen, deduplicates requests and prevents competing tasks",()=>{
    const first=create();expect(create().id).toBe(first.id);
    expect(()=>store.createTask("case1",{goal:"另一任务",idempotencyKey:"two"})).toThrow("未结束");
    store.close();store=new Store(dir);expect(store.task(first.id).goal).toBe("核对退款");expect(store.cases()).toHaveLength(1);
  });
  it("keeps exact versions and rejects unread, fabricated and cross-version quotes",()=>{
    const t=create(),s=t.snapshot[0];t.step=2;
    const raw={summary:"提取",claims:[{id:"c1",content:"有人承诺退款",kind:"statement",refs:[{evidenceId:s.evidenceId,version:s.version,segmentId:s.id,quote:"周五退款"}]}]};
    expect(()=>validateArtifact(t,raw)).toThrow("已读取");t.reads.push(s.id);expect(validateArtifact(t,raw).claims).toHaveLength(1);
    raw.claims[0].refs[0].quote="已收到退款";expect(()=>validateArtifact(t,raw)).toThrow("原文");
    raw.claims[0].refs[0].quote="周五退款";raw.claims[0].refs[0].version=2;expect(()=>validateArtifact(t,raw)).toThrow("版本");
    store.saveCase({caseId:"case1",evidence:[{...evidence,content:"周六退款"}],analysis});expect(store.snapshot("case1")[0].version).toBe(2);expect(store.task(t.id).snapshot[0].content).toContain("周五");
  });
  it("rejects late results after pause and allows lease recovery",()=>{
    const t=create();store.claim("first");store.action(t.id,"pause");expect(store.owned(t.id,"first",v=>{v.step=8;})).toBe(false);
    store.action(t.id,"resume");const resumed=store.claim("second")!;expect(resumed.step).toBe(0);
    resumed.lease=Date.now()-1;store.saveTask(resumed);expect(store.claim("third")?.owner).toBe("third");expect(store.owned(t.id,"second",()=>{})).toBe(false);
  });
  it("requires alternative explanations for conflicts",()=>{
    const t=create();t.step=5;t.artifacts=[ArtifactSchema.parse({summary:"",claims:[{id:"a",content:"a",kind:"statement",refs:[{evidenceId:"e1",version:1,segmentId:"x",quote:"a"}]},{id:"b",content:"b",kind:"statement",refs:[{evidenceId:"e1",version:1,segmentId:"x",quote:"b"}]}]})];
    expect(()=>validateArtifact(t,{summary:"",conflicts:[{id:"conflict",content:"可能冲突",claimIds:["a","b"]}]})).toThrow("替代解释");
  });
  it("executes eight skills with read-before-claim and produces a traceable report",async()=>{
    const t=create();const leased=store.claim("worker")!;
    const invoke:typeof modelStep=async()=>{
      const current=store.task(t.id),s=current.snapshot[0];
      if(current.step===2&&!current.reads.length)return {text:"",raw:undefined,calls:[{id:"read",name:"read_evidence",arguments:JSON.stringify({segmentId:s.id})}]};
      const a={summary:"阶段完成",...(current.step===0?{plan:["查找退款承诺并核实履行"]}:{}),...(current.step===2?{claims:[{id:"c1",content:"小王说周五退款",kind:"statement",refs:[{evidenceId:s.evidenceId,version:s.version,segmentId:s.id,quote:"周五退款"}]}]}:{}),...(current.step===6?{checks:[{claimId:"c1",status:"supported",reason:"原文支持承诺存在，不证明已经履行"}]}:{}),gaps:["缺少实际到账记录"]};
      return {text:"",raw:undefined,calls:[{id:`step${current.step}`,name:"submit_artifact",arguments:JSON.stringify(a)}]};
    };
    await runTask(store,leased,invoke);const done=store.task(t.id);expect(done.error).toBe("");expect(done.state).toBe("completed");expect(done.step).toBe(8);
    const row=store.db.prepare("SELECT body FROM reports WHERE task_id=?").get(t.id) as {body:string};expect(row.body).toContain("e1 v1");expect(row.body).toContain("缺少实际到账记录");
  });
  it("does not commit a model response that arrives after cancellation",async()=>{
    const t=create(),leased=store.claim("worker")!;
    await runTask(store,leased,async()=>{store.action(t.id,"cancel");return {text:"",raw:undefined,calls:[{id:"x",name:"submit_artifact",arguments:JSON.stringify({summary:"",plan:["late"]})}]};});
    expect(store.task(t.id).state).toBe("cancelled");expect(store.task(t.id).artifacts).toHaveLength(0);
  });
  it("preserves original bytes without overwriting and keeps them separate from parsed text",()=>{
    const bytes=Buffer.from([0,255,1,128]);const hash=saveOriginal(bytes);expect(saveOriginal(bytes)).toBe(hash);expect(readFileSync(join(dir,"originals",hash))).toEqual(bytes);
  });
  it("accepts the actual loopback Host and rejects a different Origin",async()=>{
    const headers={"Content-Type":"application/json",host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000"};
    expect(await readJson(new Request("http://localhost:3000/api/cases",{method:"POST",headers,body:'{"ok":true}'}))).toEqual({ok:true});
    await expect(readJson(new Request("http://localhost:3000/api/cases",{method:"POST",headers:{...headers,origin:"https://evil.example"},body:"{}"}))).rejects.toThrow("跨站");
  });
  it.skipIf(process.platform!=="win32")("encrypts persisted credentials using the OS user and supports task overrides",()=>{
    const config={provider:"custom",protocol:"openai",baseUrl:"https://fixture.example/v1",model:"fixture",apiKey:"never-store-this-in-cleartext",tools:true};
    saveConnection(config);expect(savedConnection()?.apiKey).toBe(config.apiKey);expect(readFileSync(join(dir,"connection.enc")).includes(Buffer.from(config.apiKey))).toBe(false);
    saveConnection({...config,model:"reviewer"},"investigation");expect(savedConnection("investigation")?.model).toBe("reviewer");expect(savedConnection()?.model).toBe("fixture");
  },15000);
  it("collects only the frozen channel and time range, then checkpoints the imported evidence",async()=>{
    const t=store.createTask("case1",{goal:"核实退款",idempotencyKey:"source",scope:{sources:[{source:"dingtalk",conversationIds:["selected"],start:"2026-10-01T00:00",end:"2026-10-02T00:00"}]}});
    vi.stubEnv("INGESTION_SERVICE_URL","http://127.0.0.1:18000");
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({evidences:[{...evidence,id:"from-source",content:"指定会话补充材料"}],truncated:true}),{status:200}));vi.stubGlobal("fetch",fetcher);
    try{await runTask(store,store.claim("source-worker")!,async()=>{store.action(t.id,"pause");throw new Error("test stop");});
      const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body.conversation_ids).toEqual(["selected"]);expect(body.time_start).toBe("2026-10-01T00:00");expect(store.task(t.id).collectedSources).toBe(1);expect(store.task(t.id).collectionNotes?.[0]).toContain("截断");
    }finally{vi.unstubAllGlobals();}
  });
  it("does not accept an image citation without consent and never marks visual transcription as fully verified",()=>{
    const t=create();t.step=2;t.snapshot[0].kind="image";t.reads=[t.snapshot[0].id];
    const claim={id:"visual",kind:"observation",content:"图像可能含退款文字",refs:[{evidenceId:"e1",version:1,segmentId:t.snapshot[0].id,quote:"退款"}]};
    expect(()=>validateArtifact(t,{summary:"",claims:[claim]})).toThrow("已读取");
    t.scope.allowImages=true;const extracted=validateArtifact(t,{summary:"",claims:[claim]});t.artifacts=[extracted];t.step=6;
    const checked=validateArtifact(t,{summary:"",checks:[{claimId:"visual",status:"supported",reason:"模型识别"}]});expect(checked.checks[0].status).toBe("partially_supported");expect(checked.checks[0].reason).toContain("人工");
  });
  it("requires semantic review of derived findings as well as quoted claims",()=>{
    const t=create();t.step=6;t.artifacts=[ArtifactSchema.parse({summary:"",claims:[{id:"c",kind:"statement",content:"承诺",refs:[{evidenceId:"e1",version:1,segmentId:"x",quote:"退款"}]}],events:[{id:"event",content:"退款事件候选",claimIds:["c"]}]})];
    expect(()=>validateArtifact(t,{summary:"",checks:[{claimId:"c",status:"supported",reason:"原文陈述"}]})).toThrow("时间线");
  });
});
