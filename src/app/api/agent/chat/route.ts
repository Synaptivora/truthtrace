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
  const stop = new AbortController();
  const signal = AbortSignal.any([request.signal, stop.signal, AbortSignal.timeout(110_000)]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function emit(event: AgentEvent) { if (!stop.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
      try { const reply = await runAgent(input, signal, text => emit({ type: "status", text })); emit({ type: "result", reply }); }
      catch (error) { emit({ type: "error", error: signal.aborted ? "请求已取消或超时，请重试。" : safeError(error).error }); }
      finally { if (!stop.signal.aborted) controller.close(); }
    },
    cancel() { stop.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

export const POST = secureRoute(rawPOST);
