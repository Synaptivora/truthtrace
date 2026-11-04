import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { z } from "zod";
import type { Connection } from "./providers";

export type Tool = { name: string; description: string; parameters: Record<string, unknown> };
export type Call = { id: string; name: string; arguments: string };
export type Message = { role: "system" | "user" | "assistant" | "tool"; content: string; image?: string; calls?: Call[]; callId?: string; raw?: unknown };
export type Step = { text: string; calls: Call[]; raw: unknown };
const object = z.record(z.string(), z.unknown());
const callSchema = z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) });

export function wireRequest(config: Connection, messages: Message[], tools: Tool[]) {
  if (config.protocol === "anthropic") {
    const turns: { role: string; content: unknown[] }[] = [];
    for (const m of messages.filter(m => m.role !== "system")) {
      const role = m.role === "tool" ? "user" : m.role;
      const content = m.role === "tool" ? [{ type: "tool_result", tool_use_id: m.callId, content: m.content }] : Array.isArray(m.raw) ? m.raw : [{ type: "text", text: m.content }, ...(m.image ? [{ type: "image", source: { type: "base64", media_type: m.image.slice(5, m.image.indexOf(";")), data: m.image.slice(m.image.indexOf(",") + 1) } }] : [])];
      const previous = turns.at(-1);
      if (previous?.role === role) previous.content.push(...content);
      else turns.push({ role, content });
    }
    return { path: "/messages", headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", ...(["commandcode", "opencode"].includes(config.provider) ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, body: {
      model: config.model, max_tokens: 4096,
      system: messages.filter(m => m.role === "system").map(m => m.content).join("\n"),
      messages: turns,
      ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    } };
  }
  if (config.protocol === "responses") {
    return { path: "/responses", headers: { Authorization: `Bearer ${config.apiKey}` }, body: {
      model: config.model, store: false, include: ["reasoning.encrypted_content"],
      input: messages.flatMap(m => m.role === "tool" ? [{ type: "function_call_output", call_id: m.callId, output: m.content }] : m.raw && Array.isArray(m.raw) ? m.raw : [{ role: m.role, content: m.image ? [{ type: "input_text", text: m.content }, { type: "input_image", image_url: m.image }] : m.content }]),
      ...(tools.length ? { tools: tools.map(t => ({ type: "function", ...t, strict: false })) } : {}),
    } };
  }
  return { path: "/chat/completions", headers: { Authorization: `Bearer ${config.apiKey || "ollama"}`, ...(config.provider === "mimo" ? { "api-key": config.apiKey } : {}) }, body: {
    model: config.model,
    ...(config.provider === "deepseek" ? { thinking: { type: "disabled" }, max_tokens: 12000 } : {}),
    messages: messages.map(m => m.role === "tool" ? { role: "tool", tool_call_id: m.callId, content: m.content } : m.raw ?? { role: m.role, content: m.image ? [{ type: "text", text: m.content }, { type: "image_url", image_url: { url: m.image } }] : m.content }),
    ...(tools.length ? { tools: tools.map(t => ({ type: "function", function: t })) } : {}),
  } };
}

export function parseStep(protocol: Connection["protocol"], data: unknown): Step {
  const root = object.parse(data);
  if (protocol === "anthropic") {
    if (root.stop_reason === "max_tokens") throw new Error("模型回复达到长度限制，请缩小问题范围后重试。");
    const blocks = z.array(object).parse(root.content);
    return { raw: blocks, text: blocks.filter(b => b.type === "text").map(b => z.string().parse(b.text)).join("\n"), calls: blocks.filter(b => b.type === "tool_use").map(b => ({ id: z.string().parse(b.id), name: z.string().parse(b.name), arguments: JSON.stringify(b.input) })) };
  }
  if (protocol === "responses") {
    const blocks = z.array(object).parse(root.output);
    if (root.status === "incomplete" || root.error) throw new Error("模型回复未完成，请缩小问题范围后重试。");
    return { raw: blocks, text: blocks.filter(b => b.type === "message").flatMap(b => z.array(object).parse(b.content)).filter(b => b.type === "output_text").map(b => z.string().parse(b.text)).join("\n"), calls: blocks.filter(b => b.type === "function_call").map(b => ({ id: z.string().parse(b.call_id), name: z.string().parse(b.name), arguments: z.string().parse(b.arguments) })) };
  }
  const choice = z.array(object).min(1).parse(root.choices)[0];
  if (choice.finish_reason === "length") throw new Error("模型回复达到长度限制，请缩小问题范围后重试。");
  const msg = object.parse(choice.message);
  return { raw: msg, text: typeof msg.content === "string" ? msg.content : "", calls: z.array(callSchema).parse(msg.tool_calls ?? []).map(c => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })) };
}

export async function modelStep(config: Connection, messages: Message[], tools: Tool[], signal: AbortSignal): Promise<Step> {
  const wire = wireRequest(config, messages, tools);
  const response = await secureModelRequest(new URL(config.baseUrl + wire.path), { "Content-Type": "application/json", ...wire.headers }, JSON.stringify(wire.body), signal);
  if (!response.ok) {
    // Do not expose upstream bodies: some providers echo credentials or evidence.
    const hints: Record<number, string> = { 401: "API Key 无效或与地域不匹配", 402: "账户余额不足，请在模型供应商控制台充值", 403: "账号无权调用该模型", 404: "模型名称、协议或 API 地址不正确", 429: "请求过于频繁或额度受限，请稍后重试", 400: "请求不兼容：请检查协议、模型及工具调用支持" };
    throw new Error(`模型服务 HTTP ${response.status}：${hints[response.status] ?? "服务暂时不可用，请稍后重试"}`);
  }
  return parseStep(config.protocol, await response.json());
}

// Conservative public-address policy: IPv6 global unicast only; reject transition
// ranges so IPv4 restrictions cannot be bypassed through mapped/tunnel addresses.
export function publicModelAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b] = address.split(".").map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || a===169&&b===254 || a===172&&b>=16&&b<=31 || a===192&&(b===168||b===0||b===2) || a===100&&b>=64&&b<=127 || a===198&&(b===18||b===19||b===51) || a===203&&b===0);
  }
  return isIP(address)===6 && /^[23]/i.test(address) && !/^200[12]:/i.test(address) && !/^2001:db8:/i.test(address);
}
export class ModelTransportError extends Error {
  constructor(public code: string, message: string, public retryable=false) { super(message); this.name="ModelTransportError"; }
}
export async function secureModelRequest(url: URL, headers: Record<string,string>, body: string, signal: AbortSignal): Promise<Response> {
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(60000)]);
  deadline.throwIfAborted();
  const allowed=(process.env.TRUTHTRACE_MODEL_PRIVATE_ORIGINS??"").split(",").map(s=>s.trim()).includes(url.origin);
  if(url.username||url.password||url.search||url.hash||!(url.protocol==="https:"||allowed&&url.protocol==="http:"))throw new ModelTransportError("MODEL_DESTINATION","模型目的地址未授权");
  const host=url.hostname.replace(/^\[|\]$/g,"");
  // DNS also observes the total deadline; late results are never used.
  const addresses=await new Promise<Awaited<ReturnType<typeof lookup>>|{address:string;family:number}[]>((resolve,reject)=>{
    const cancel=()=>reject(new ModelTransportError("MODEL_TIMEOUT","模型请求已取消或超时"));
    deadline.addEventListener("abort",cancel,{once:true});
    lookup(host,{all:true,verbatim:true}).then(resolve,()=>reject(new ModelTransportError("MODEL_NETWORK","模型连接失败",true))).finally(()=>deadline.removeEventListener("abort",cancel));
  });
  const list=Array.isArray(addresses)?addresses:[addresses];
  if(!list.length||!allowed&&list.some(a=>!publicModelAddress(a.address)))throw new ModelTransportError("MODEL_DESTINATION","模型目的地址未授权");
  deadline.throwIfAborted();
  const selected=list[0];
  return new Promise((resolve,reject)=>{
    const request=url.protocol==="https:"?httpsRequest:httpRequest;
    const req=request(url,{method:"POST",agent:false,family:selected.family,headers,signal:deadline,lookup:(_host,_options,callback)=>callback(null,selected.address,selected.family)},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>8*1024*1024){req.destroy();reject(new ModelTransportError("MODEL_SIZE","模型响应超过大小限制"));}else chunks.push(chunk);});
      res.on("error",()=>reject(new ModelTransportError("MODEL_NETWORK","模型响应中断",true)));
      res.on("end",()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode??502})));
    });
    req.on("error",()=>reject(new ModelTransportError(deadline.aborted?"MODEL_TIMEOUT":"MODEL_NETWORK",deadline.aborted?"模型请求已取消或超时":"模型连接失败",!deadline.aborted)));
    req.end(body);
  });
}


