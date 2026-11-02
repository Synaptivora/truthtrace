import { savedConnection } from "../investigator/connections";
import { analyzeWithConnection } from "./shared-model";
import type { Evidence } from "../contracts";
import { createMockAnalysis } from "./mock";
import { createModelAnalysis, type AnalyzeOutcome } from "./openai-compatible";
import { createRuleAnalysis } from "./rule";

export type { AnalyzeOutcome };

/** mock / rule 不送模型，谈不上「放弃了什么」；结构仍与模型侧一致，调用方不用分叉。 */
function localMeta(): AnalyzeOutcome["meta"] {
  return { truncated: 0, droppedEvidence: 0, droppedImages: 0, images: 0 };
}

export async function analyzeEvidence(evidence: Evidence[]): Promise<AnalyzeOutcome> {
  const shared = savedConnection("analysis") ?? savedConnection();
  if (shared) return analyzeWithConnection(evidence, shared);
  const provider = (process.env.AI_PROVIDER ?? "auto").toLowerCase();

  // auto：有密钥就走真实模型，没有就走本地规则——避免「配了 key 却忘了改 provider」
  // 和「没配 key 却看到 00 位人物」这两种常见困惑。
  if (provider === "auto") {
    if (process.env.AI_API_KEY) return createModelAnalysis(evidence);
    return { analysis: createRuleAnalysis(evidence), meta: localMeta() };
  }

  if (provider === "openai") {
    return createModelAnalysis(evidence);
  }

  if (provider === "rule") {
    return { analysis: createRuleAnalysis(evidence), meta: localMeta() };
  }

  if (provider !== "mock") {
    throw new Error(`不支持的 AI_PROVIDER：${provider}`);
  }

  // mock 不读正文，不会有截断；返回结构保持一致，调用方不用分叉
  return { analysis: await createMockAnalysis(evidence), meta: localMeta() };
}
