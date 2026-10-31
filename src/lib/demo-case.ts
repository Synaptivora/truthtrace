import type { AnalysisResult, Evidence } from "./contracts";

export const demoEvidence: Evidence[] = [
  {
    id: "demo-chat-01",
    name: "兼职沟通记录.txt",
    kind: "chat",
    mimeType: "text/plain",
    source: "虚构演示案件",
    content:
      "10月28日 09:20 陈浩：林晓，入职前需要先交300元设备押金。\n10月28日 09:24 林晓：好的，我交完后什么时候开始工作？\n10月28日 09:26 陈浩：今天就会安排。",
  },
  {
    id: "demo-chat-02",
    name: "退款承诺.txt",
    kind: "chat",
    mimeType: "text/plain",
    source: "虚构演示案件",
    content:
      "10月29日 20:10 林晓：工作没有安排，我要求退回押金。\n10月29日 20:15 陈浩：明天18点前全额退300元。\n10月29日 20:17 校园兼职客服：如有争议，可提交付款和退款记录。",
  },
  {
    id: "demo-chat-03",
    name: "退款说明.txt",
    kind: "chat",
    mimeType: "text/plain",
    source: "虚构演示案件",
    content: "10月30日 14:05 陈浩：300元已经在下午两点全额退给你了，请查收。",
  },
  {
    id: "demo-receipt-01",
    name: "转账凭证.txt",
    kind: "text",
    mimeType: "text/plain",
    source: "虚构演示案件",
    content: "转账凭证（虚构）：付款方陈浩，收款方林晓，金额200元，完成时间2026-10-30 17:35。",
  },
];

export const demoAnalysis: AnalysisResult = {
  caseTitle: "校园兼职押金退款纠纷",
  summary:
    "材料显示招聘方承诺全额退还300元押金，但后续转账凭证的金额与其说法不一致。该差异需要人工核对完整流水，不能仅凭现有材料认定诈骗。",
  analysisMode: "mock",
  generatedAt: "2026-10-31T12:00:00.000Z",
  people: [
    {
      id: "person-linxiao",
      name: "林晓",
      role: "学生 / 付款方",
      aliases: [],
      summary: "支付设备押金并要求退款。",
      evidenceRefs: [{ evidenceId: "demo-chat-01", quote: "林晓：好的，我交完后什么时候开始工作？" }],
    },
    {
      id: "person-chenhao",
      name: "陈浩",
      role: "招聘联系人",
      aliases: [],
      summary: "收取押金、承诺退款，并称已全额退款。",
      evidenceRefs: [{ evidenceId: "demo-chat-02", quote: "陈浩：明天18点前全额退300元。" }],
    },
    {
      id: "person-service",
      name: "校园兼职客服",
      role: "平台客服",
      aliases: [],
      summary: "建议争议双方提交付款与退款记录。",
      evidenceRefs: [{ evidenceId: "demo-chat-02", quote: "校园兼职客服：如有争议，可提交付款和退款记录。" }],
    },
  ],
  relationships: [
    {
      id: "rel-01",
      sourcePersonId: "person-chenhao",
      targetPersonId: "person-linxiao",
      label: "收取押金并承诺退款",
      evidenceRefs: [{ evidenceId: "demo-chat-02", quote: "明天18点前全额退300元" }],
    },
    {
      id: "rel-02",
      sourcePersonId: "person-service",
      targetPersonId: "person-linxiao",
      label: "提供争议处理指引",
      evidenceRefs: [{ evidenceId: "demo-chat-02", quote: "可提交付款和退款记录" }],
    },
  ],
  events: [
    {
      id: "event-01",
      title: "要求支付设备押金",
      description: "陈浩要求林晓在入职前支付300元设备押金。",
      occurredAt: "2026-10-28T09:20:00+08:00",
      timeLabel: "10月28日 09:20",
      timePrecision: "exact",
      participantIds: ["person-chenhao", "person-linxiao"],
      evidenceRefs: [{ evidenceId: "demo-chat-01", quote: "入职前需要先交300元设备押金" }],
    },
    {
      id: "event-02",
      title: "承诺全额退款",
      description: "陈浩承诺在次日18点前退还300元。",
      occurredAt: "2026-10-29T20:15:00+08:00",
      timeLabel: "10月29日 20:15",
      timePrecision: "exact",
      participantIds: ["person-chenhao", "person-linxiao"],
      evidenceRefs: [{ evidenceId: "demo-chat-02", quote: "明天18点前全额退300元" }],
    },
    {
      id: "event-03",
      title: "声称已完成退款",
      description: "陈浩称300元已在下午两点全额退回。",
      occurredAt: "2026-10-30T14:05:00+08:00",
      timeLabel: "10月30日 14:05",
      timePrecision: "exact",
      participantIds: ["person-chenhao"],
      evidenceRefs: [{ evidenceId: "demo-chat-03", quote: "300元已经在下午两点全额退给你了" }],
    },
    {
      id: "event-04",
      title: "转账凭证显示200元",
      description: "凭证记录金额为200元，完成时间为17:35。",
      occurredAt: "2026-10-30T17:35:00+08:00",
      timeLabel: "10月30日 17:35",
      timePrecision: "exact",
      participantIds: ["person-chenhao", "person-linxiao"],
      evidenceRefs: [{ evidenceId: "demo-receipt-01", quote: "金额200元，完成时间2026-10-30 17:35" }],
    },
  ],
  contradictions: [
    {
      id: "contradiction-01",
      title: "退款金额与“全额退款”说法不一致",
      description: "聊天中的承诺和退款声明均为300元，但当前凭证仅显示200元。需核实是否另有100元退款记录。",
      severity: "high",
      status: "needs_review",
      evidenceRefs: [
        { evidenceId: "demo-chat-03", quote: "300元已经在下午两点全额退给你了" },
        { evidenceId: "demo-receipt-01", quote: "金额200元" },
      ],
    },
  ],
  commitments: [
    {
      id: "commitment-01",
      personId: "person-chenhao",
      commitment: "在10月30日18点前全额退还300元押金",
      dueLabel: "10月30日 18:00 前",
      status: "disputed",
      evidenceRefs: [{ evidenceId: "demo-chat-02", quote: "明天18点前全额退300元" }],
    },
  ],
  evidenceGaps: [
    {
      id: "gap-01",
      title: "缺少完整退款流水",
      reason: "现有200元凭证不足以证明剩余100元是否通过其他渠道退回。",
      suggestedEvidence: "补充10月30日前后的完整收款流水或第二笔退款凭证。",
      relatedEventIds: ["event-03", "event-04"],
      evidenceRefs: [{ evidenceId: "demo-receipt-01", quote: "金额200元" }],
    },
  ],
};
