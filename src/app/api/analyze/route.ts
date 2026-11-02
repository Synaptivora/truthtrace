import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeEvidence } from "@/lib/ai/provider";
import { EvidenceSchema } from "@/lib/contracts";

export const runtime = "nodejs";
// 证据变多之后分析会更久（20 张图 + 长正文），给到 5 分钟；模型侧还有 AI_TIMEOUT_MS 兜底。
export const maxDuration = 300;

// 条数上限只用来挡病态输入（一次丢几万条过来），不再承担「控制模型成本」的职责——
// 那是 openai-compatible.ts 里按类型分档的预算（字符 / 图片张数 / 图片字节）该干的事。
const MAX_EVIDENCE = (() => {
  const value = Number(process.env.ANALYZE_MAX_EVIDENCE);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 200;
})();

const RequestSchema = z.object({
  evidence: z.array(EvidenceSchema).min(1).max(MAX_EVIDENCE).refine(
    items => new Set(items.map(item => item.id)).size === items.length,
    "证据 ID 不可重复",
  ),
});
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "请求必须为有效 JSON" }, { status: 400 }); }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "证据不符合数据契约", details: parsed.error.issues }, { status: 400 });
  }
  try {
    const { analysis, meta } = await analyzeEvidence(parsed.data.evidence);
    // meta 只是提示信息（正文是否被截断），不进 contracts.ts，C 可忽略
    return NextResponse.json({ analysis, meta });
  } catch {
    return NextResponse.json({ error: "分析服务失败或返回结果未通过校验，请稍后重试" }, { status: 502 });
  }
}
