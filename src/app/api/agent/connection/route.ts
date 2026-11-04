import { secureRoute } from "@/lib/security/boundary";
import { effectiveConnection as resolveConnection, effectiveConnection as serverConnection } from "@/lib/investigator/connections";
import { z } from "zod";
import { ConnectionSchema } from "@/lib/agent/providers";
import { modelStep } from "@/lib/agent/transport";
import { readJson } from "@/lib/agent/http";
export const runtime = "nodejs";
export const maxDuration = 60;
async function rawGET() {
  try {
    const config = serverConnection();
    return Response.json({ configured: !!config, provider: config?.provider ?? "mock", model: config?.model ?? "", protocol: config?.protocol ?? "openai" }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ configured: false, error: "服务端模型配置不完整。" }); }
}
async function rawPOST(request: Request) {
  try {
    const body = z.object({ connection: ConnectionSchema.optional() }).parse(await readJson(request, 16000));
    const config = resolveConnection(body.connection);
    if (!config) return Response.json({ ok: true, message: "当前为本地演示模式，未调用模型。" });
    const reply = await modelStep(config, [{ role: "user", content: "Reply with OK only." }], [], AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]));
    if (!reply.text.trim()) throw new Error("模型返回空回复。");
    return Response.json({ ok: true, message: `连接成功：${config.model}。已验证文本回复；工具能力取决于具体模型。` });
  } catch (error) { return Response.json({ error: error instanceof Error && error.name !== "ZodError" && !(error instanceof TypeError) ? error.message : "连接失败，请检查地址、协议、模型和密钥。" }, { status: 400 }); }
}

export const GET = secureRoute(rawGET);

export const POST = secureRoute(rawPOST);
