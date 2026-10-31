import type { AnalysisResult, Evidence } from "../contracts";
import { demoAnalysis, demoEvidence } from "../demo-case";
import { validateAnalysis } from "./validate";

export async function createMockAnalysis(evidence: Evidence[]): Promise<AnalysisResult> {
  const isDemoCase =
    evidence.length === demoEvidence.length &&
    demoEvidence.every((demo) => evidence.some((item) => item.id === demo.id));

  if (isDemoCase) {
    return validateAnalysis(demoAnalysis, evidence, "mock");
  }

  return validateAnalysis(
    {
      caseTitle: "本地骨架分析（未启用真实模型）",
      summary:
        "当前仅完成证据登记和接口联调，没有执行人物、事件或矛盾识别。配置模型或载入演示案件后可查看完整分析效果。",
      people: [],
      relationships: [],
      events: evidence.map((item, index) => ({
        id: `local-event-${index + 1}`,
        title: `已接收：${item.name}`,
        description: "该条目表示证据已进入系统，不代表 AI 已识别其中事件。",
        occurredAt: null,
        timeLabel: "时间未分析",
        timePrecision: "unknown",
        participantIds: [],
        evidenceRefs: [
          {
            evidenceId: item.id,
            quote: item.kind === "image" ? "图像证据已接收，等待真实模型识别。" : item.content.slice(0, 120),
          },
        ],
      })),
      contradictions: [],
      commitments: [],
      evidenceGaps: [
        {
          id: "local-gap-model",
          title: "真实分析模型尚未启用",
          reason: "当前 AI_PROVIDER=mock，系统不会把本地占位结果包装成真实 AI 结论。",
          suggestedEvidence: "配置 OpenAI 兼容模型，或由 B 接入团队的证据推理流程。",
          relatedEventIds: [],
          evidenceRefs: [],
        },
      ],
    },
    evidence,
    "mock",
  );
}
