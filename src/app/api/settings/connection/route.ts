import { secureRoute } from "@/lib/security/boundary";
import { z } from "zod";
import { readJson } from "@/lib/agent/http";
import { ConnectionSchema } from "@/lib/agent/providers";
import { modelStep } from "@/lib/agent/transport";
import { effectiveConnection, saveConnection } from "@/lib/investigator/connections";
export const runtime="nodejs";
async function rawGET(){try{const c=effectiveConnection();return Response.json({configured:!!c,...(c?{provider:c.provider,model:c.model,baseUrl:c.baseUrl,protocol:c.protocol,tools:c.tools}:{})});}catch{return Response.json({error:"本地连接无法解密或配置不完整"},{status:400});}}
async function rawPOST(request:Request){try{
  const {connection,role}=z.object({connection:ConnectionSchema,role:z.enum(["shared","chat","analysis","investigation"]).default("shared")}).parse(await readJson(request,16000));
  const c=effectiveConnection(connection)!;const signal=AbortSignal.any([request.signal,AbortSignal.timeout(60000)]);
  const text=await modelStep(c,[{role:"user",content:"Reply OK."}],[],signal);
  if(!text.text.trim())throw new Error("文本测试失败");
  let tools=false;
  if(c.tools){const reply=await modelStep(c,[{role:"user",content:"Call connection_probe with value truthtrace. Do not answer in text."}],[{name:"connection_probe",description:"Test tool transport",parameters:{type:"object",properties:{value:{type:"string",enum:["truthtrace"]}},required:["value"],additionalProperties:false}}],signal);tools=reply.calls.some(x=>x.name==="connection_probe"&&JSON.parse(x.arguments).value==="truthtrace");if(!tools)throw new Error("文本连接正常，但工具调用测试未通过；可关闭工具后保存为普通问答连接");}
  saveConnection({...c,tools},role);return Response.json({message:`已测试并加密保存${({shared:"共享",chat:"对话",analysis:"分析",investigation:"调查"})[role]}连接；文本：通过；工具：${tools?"通过":"关闭"}；图片：未测试`,capabilities:{text:true,tools,images:"未测试"}});
}catch(e){return Response.json({error:e instanceof z.ZodError?"连接字段无效":e instanceof Error&& !e.message.includes("Command failed")?e.message:"保存连接失败"},{status:400});}}

export const GET = secureRoute(rawGET);

export const POST = secureRoute(rawPOST);
