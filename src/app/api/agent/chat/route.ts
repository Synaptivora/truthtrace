import { Conversations, type Conversation } from "@/lib/conversation/store";
import { conversationContext } from "@/lib/conversation/context";
import { Store } from "@/lib/investigator/store";
import type { EvidenceContext } from "@/lib/evidence/provenance";
import { safeError } from "@/lib/security/safe-error";
import { secureRoute } from "@/lib/security/boundary";
import { AgentRequestSchema, type AgentEvent } from "@/lib/agent/contracts";
import { runAgent } from "@/lib/agent/runner";
import { readJson } from "@/lib/agent/http";
export const runtime = "nodejs";
export const maxDuration = 120;
async function rawPOST(request: Request) {
  let input;
  try { input = AgentRequestSchema.parse(await readJson(request)); }
  catch { return Response.json({ error: "请求格式无效、材料超过 2 MiB 或来源不允许，请检查后重试。" }, { status: 400 }); }
  const question=input.messages.at(-1)!.content;
  let conversation:Conversation|undefined;
  let summary:Conversation["summary"]=null;
  if(input.conversationId&&(!input.caseId||!input.conversationRevision))return Response.json({error:"会话需要案件及版本"},{status:400});
  let evidenceContext:EvidenceContext|undefined;
  if(input.caseId){
    const store=new Store();
    try{const saved=store.case(input.caseId);evidenceContext={caseId:input.caseId,evidence:saved.evidence,segments:store.snapshot(input.caseId)};input={...input,evidence:saved.evidence,analysis:saved.analysis};
      if(input.conversationId){conversation=new Conversations(store.db).get(input.caseId!,input.conversationId);if(conversation.revision!==input.conversationRevision)throw Error("会话已修改");const bounded=conversationContext(conversation,question);summary=bounded.summary;input={...input,messages:bounded.messages};}}
    catch{return Response.json({error:"案件不存在或不可访问"},{status:404});}
    finally{store.close();}
  }
  const stop = new AbortController();
  const signal = AbortSignal.any([request.signal, stop.signal, AbortSignal.timeout(110_000)]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function emit(event: AgentEvent) { if (!stop.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
      try { const reply = await runAgent(input, signal, text => emit({ type: "status", text }),evidenceContext); signal.throwIfAborted();
        if(conversation){const store=new Store();try{new Conversations(store.db).append(conversation.caseId,conversation.id,conversation.revision,question,reply,summary);}finally{store.close();}}
        emit({ type: "result", reply }); }
      catch (error) { emit({ type: "error", error: signal.aborted ? "请求已取消或超时，请重试。" : safeError(error).error }); }
      finally { if (!stop.signal.aborted) controller.close(); }
    },
    cancel() { stop.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

export const POST = secureRoute(rawPOST);
