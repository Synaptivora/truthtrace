import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeEvidence } from "@/lib/ai/provider";
import { EvidenceSchema } from "@/lib/contracts";

export const runtime = "nodejs";
export const maxDuration = 90;
const RequestSchema = z.object({
  evidence: z.array(EvidenceSchema).min(1).max(30).refine(
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
    return NextResponse.json({ analysis: await analyzeEvidence(parsed.data.evidence) });
  } catch {
    return NextResponse.json({ error: "分析服务失败或返回结果未通过校验，请稍后重试" }, { status: 502 });
  }
}
