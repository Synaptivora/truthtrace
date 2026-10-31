import type { AnalysisResult, Evidence } from "../contracts";
import { createMockAnalysis } from "./mock";
import { createModelAnalysis } from "./openai-compatible";

export async function analyzeEvidence(evidence: Evidence[]): Promise<AnalysisResult> {
  const provider = process.env.AI_PROVIDER ?? "mock";

  if (provider === "openai") {
    return createModelAnalysis(evidence);
  }

  if (provider !== "mock") {
    throw new Error(`不支持的 AI_PROVIDER：${provider}`);
  }

  return createMockAnalysis(evidence);
}
