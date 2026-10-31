import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeEvidence } from "@/lib/ai/provider";
import { EvidenceSchema } from "@/lib/contracts";

export const runtime = "nodejs";
export const maxDuration = 90;

const RequestSchema = z.object({
  evidence: z.array(EvidenceSchema).min(1).max(30),
});

export async function POST(request: Request) {
  try {
    const { evidence } = RequestSchema.parse(await request.json());
    const analysis = await analyzeEvidence(evidence);
    return NextResponse.json({ analysis });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "证据或模型结果不符合数据契约", details: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "分析失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
