import { z } from "zod";
import { AnalysisPayloadSchema, type Evidence } from "../contracts";
import { modelStep, type Message } from "../agent/transport";
import type { Connection } from "../agent/providers";
import { investigationSystemPrompt } from "./prompt";
import { validateAnalysis } from "./validate";
import { modelBudget, selectForModel, type AnalyzeOutcome } from "./openai-compatible";

export async function analyzeWithConnection(evidence:Evidence[],config:Connection):Promise<AnalyzeOutcome> {
  const {selected,meta}=selectForModel(evidence);let room=modelBudget().totalChars,truncated=0;
  const visible:Evidence[]=[];
  for(const e of selected){if(e.kind==="image")continue;const content=e.content.slice(0,room);room-=content.length;if(content.length<e.content.length)truncated++;if(content)visible.push({...e,content});}
  const messages:Message[]=[{role:"system",content:investigationSystemPrompt+"\n输出结构："+JSON.stringify(z.toJSONSchema(AnalysisPayloadSchema))},{role:"user",content:JSON.stringify(visible)}];
  // Existing explicit image consent belongs to chat/investigation; shared analysis currently sends text only.
  let last:unknown;
  for(let attempt=0;attempt<2;attempt++) {
    const reply=await modelStep(config,messages,[],AbortSignal.timeout(180000));
    try{return {analysis:validateAnalysis(JSON.parse(reply.text.replace(/^```(?:json)?\s*|\s*```$/g,"")),visible,"model"),meta:{...meta,truncated,droppedImages:meta.droppedImages+selected.filter(e=>e.kind==="image").length,images:0}};}
    catch(e){last=e;messages.push({role:"assistant",content:reply.text},{role:"user",content:"结构或引文校验未通过。只引用已提供文本中的逐字原文，删除无依据结论，重新输出JSON。"});}
  }
  throw last;
}
