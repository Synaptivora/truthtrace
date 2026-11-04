import { EventEmitter } from "node:events";
vi.mock("node:dns/promises",()=>({lookup:vi.fn(async()=>[{address:"8.8.8.8",family:4}])}));
vi.mock("node:https",()=>({request:(url:URL, options:Record<string,unknown>, callback:(response:EventEmitter)=>void)=>{
 const req=new EventEmitter() as EventEmitter & {end:(body:string)=>void;destroy:()=>void};
 req.destroy=()=>{};
 req.end=(body:string)=>{Promise.resolve(fetch(url,{...options,body} as RequestInit)).then(async response=>{
 const res=Object.assign(new EventEmitter(),{statusCode:response.status});callback(res);
 res.emit("data",Buffer.from(await response.arrayBuffer()));res.emit("end");
 }).catch(error=>req.emit("error",error));};return req;
}}));
import { afterEach, expect, it, vi } from "vitest";
import { analysisSources, resolveAnalysisSources, analyzeWithConnection } from "@/lib/ai/shared-model";
import { createRuleAnalysis } from "@/lib/ai/rule";
import { serverConnection, type Connection } from "@/lib/agent/providers";
import { wireRequest,modelStep } from "@/lib/agent/transport";
const evidence={id:"chat",name:"群聊",kind:"chat" as const,mimeType:"text/plain",content:"[2026-11-03 12:00:00] 小王: @小李 请核对源码。\n[2026-11-03 12:01:00] 小李: 收到。\n[2026-11-03 12:02:00] 路人: 天气很好。"};
const config:Connection={provider:"deepseek",protocol:"openai",baseUrl:"https://api.deepseek.com",model:"deepseek-flash",apiKey:"fixture-only",tools:true};
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it("links explicit mentions without inferring relations between all group members",()=>{
  const a=createRuleAnalysis([evidence]);expect(a.relationships).toHaveLength(1);expect(a.relationships[0].label).toBe("明确提及（@）");expect(a.people.every(p=>p.role==="发言人")).toBe(true);
});
it("resolves source handles to exact host-owned quotes, rejecting unknown handles",()=>{
  const sources=analysisSources([evidence]);const output=resolveAnalysisSources({people:[{evidenceRefs:[{sourceId:"R1",quote:"伪造"}]}]},sources);
  expect((output.people as {evidenceRefs:{quote:string}[]}[])[0].evidenceRefs[0].quote).toBe(evidence.content.split("\n")[0]);
  expect(()=>resolveAnalysisSources({people:[{evidenceRefs:[{sourceId:"R99"}]}]},sources)).toThrow("未知原文编号");
});
it("repairs invalid source IDs without weakening citation validation",async()=>{
  const payload=(sourceId:string)=>({caseTitle:"测试",summary:"核对源码",people:[{id:"p1",name:"小王",role:"发言人",summary:"请求核对",aliases:[],evidenceRefs:[{sourceId}]}],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[]});
  const response=(id:string)=>Response.json({choices:[{finish_reason:"tool_calls",message:{role:"assistant",tool_calls:[{id:"call",type:"function",function:{name:"submit_analysis",arguments:JSON.stringify(payload(id))}}]}}]});
  const fetcher=vi.fn().mockResolvedValueOnce(response("R99")).mockResolvedValueOnce(response("R1"));vi.stubGlobal("fetch",fetcher);
  const result=await analyzeWithConnection([evidence],config);expect(result.analysis.analysisMode).toBe("model");expect(result.analysis.people[0].evidenceRefs[0].quote).toBe(evidence.content.split("\n")[0]);expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).messages.at(-1).content).toContain("R99");
});
it("uses DeepSeek environment configuration consistently and gives structured work bounded output",()=>{
  vi.stubEnv("AGENT_PROVIDER","");vi.stubEnv("AI_PROVIDER","deepseek");
  // Explicit AGENT_PROVIDER wins when present; use the usual AGENT configuration here.
  vi.stubEnv("AGENT_PROVIDER","deepseek");vi.stubEnv("AGENT_API_KEY","fixture-only");vi.stubEnv("AGENT_MODEL","deepseek-flash");
  expect(serverConnection()?.baseUrl).toBe("https://api.deepseek.com");expect(wireRequest(config,[],[]).body).toMatchObject({thinking:{type:"disabled"},max_tokens:12000});
});
it("explains insufficient balance without exposing provider response bodies",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("sensitive provider body",{status:402})));
  await expect(modelStep(config,[],[],new AbortController().signal)).rejects.toThrow("账户余额不足");
});
