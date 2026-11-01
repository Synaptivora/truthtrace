import { AnalysisResultSchema, EvidenceSchema } from "@/lib/contracts";
import type { AnalysisResult, Evidence } from "@/lib/contracts";

export type CaseAnalysis = { evidence: Evidence[]; analysis: AnalysisResult; caseName?: string };

async function readReply(response: Response, fallback: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error(fallback); }
  if (!value || typeof value !== "object") throw new Error(fallback);
  const reply = value as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof reply.error === "string" ? reply.error : fallback);
  return reply;
}

// These are the existing B-owned routes; C does not change their fields.
export async function analyzeFiles(files: File[], signal: AbortSignal, onParsed: () => void): Promise<CaseAnalysis> {
  const body = new FormData();
  files.forEach(file => body.append("files", file));
  const parsedReply = await readReply(await fetch("/api/evidence/parse", { method: "POST", body, signal }), "材料解析失败，请稍后重试。");
  const parsed = EvidenceSchema.array().min(1).safeParse(parsedReply.evidence);
  if (!parsed.success) throw new Error("材料解析结果无效，请重试。");
  onParsed();
  const analysisReply = await readReply(await fetch("/api/analyze", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evidence: parsed.data }),
  }), "分析失败，请稍后重试。");
  const result = AnalysisResultSchema.safeParse(analysisReply.analysis);
  if (!result.success) throw new Error("分析结果未通过格式校验，请重试。");
  return { evidence: parsed.data, analysis: result.data };
}
