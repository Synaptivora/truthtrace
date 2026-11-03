import { z } from "zod";

export const investigationModes = {
  fact: { label: "核查一个问题", description: "找原文、核对说法，给出依据和缺口。", stages: [0, 1, 2, 6, 7] },
  timeline: { label: "梳理事件经过", description: "整理时间、承诺与先后关系，再逐项核查。", stages: [0, 1, 2, 4, 6, 7] },
  deep: { label: "开展完整调查", description: "核对人物、时间线、矛盾与其他解释。", stages: [0, 1, 2, 3, 4, 5, 6, 7] },
} as const;
export type InvestigationMode = keyof typeof investigationModes;
export function taskStages(mode?: InvestigationMode): readonly number[] { return investigationModes[mode || "deep"].stages; }
export function suggestMode(goal: string): InvestigationMode {
  if (/矛盾|冲突|反证|复杂|完整调查|人物关系|多方/.test(goal)) return "deep";
  if (/时间线|经过|先后|梳理/.test(goal)) return "timeline";
  if (/核查|核对|是否|有没有|哪|何时|什么时候|原文|出处/.test(goal)) return "fact";
  return "deep";
}

export const skillNames = ["investigation-master", "evidence-collection", "claim-extraction", "entity-resolution", "timeline-analysis", "contradiction-analysis", "evidence-verification", "investigation-report"] as const;
export const skillLabels = ["制定调查计划", "搜索与阅读证据", "提取可核查陈述", "核对人物与关系", "整理时间线和承诺", "对照说法与其他解释", "独立核查依据", "整理报告和补证清单"] as const;
export const RefSchema = z.object({ evidenceId: z.string(), version: z.number().int().positive(), segmentId: z.string(), quote: z.string().min(1) });
export const ClaimSchema = z.object({ id: z.string().min(1), content: z.string().min(1), kind: z.enum(["statement", "observation", "inference"]), refs: z.array(RefSchema).min(1) });
export const FindingSchema = z.object({ id: z.string().min(1), content: z.string().min(1), claimIds: z.array(z.string()).min(1), time: z.string().nullable().default(null), alternatives: z.array(z.string()).default([]) });
export const ArtifactSchema = z.object({
  summary: z.string().max(12000),
  plan: z.array(z.string()).default([]),
  claims: z.array(ClaimSchema).default([]),
  people: z.array(FindingSchema).default([]), relationships: z.array(FindingSchema).default([]),
  events: z.array(FindingSchema).default([]), conflicts: z.array(FindingSchema).default([]), commitments: z.array(FindingSchema).default([]),
  gaps: z.array(z.string()).default([]),
  checks: z.array(z.object({ claimId: z.string(), status: z.enum(["supported", "partially_supported", "disputed", "insufficient"]), reason: z.string(), counterClaimIds: z.array(z.string()).default([]) })).default([]),
  findingChecks: z.array(z.object({findingId:z.string(),status:z.enum(["supported","partially_supported","disputed","insufficient"]),reason:z.string()})).default([]),
  decisions: z.array(z.object({ id: z.string(), question: z.string(), claimIds: z.array(z.string()).min(1) })).default([]),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Ref = z.infer<typeof RefSchema>;
export type Segment = { id: string; evidenceId: string; version: number; name: string; content: string; start: number; end: number; kind: string };
export const ScopeSchema = z.object({
  allowImages: z.boolean().default(false),
  sources: z.array(z.object({ source: z.enum(["wechat", "dingtalk", "feishu"]), handle: z.string().optional(), conversationIds: z.array(z.string().min(1)).min(1), start: z.string().min(1), end: z.string().min(1) }).refine(s=>Number.isFinite(Date.parse(s.start))&&Number.isFinite(Date.parse(s.end))&&Date.parse(s.start)<=Date.parse(s.end),"请提供有效且有序的时间范围")).default([]),
});
export const TaskInputSchema = z.object({ goal: z.string().trim().min(1).max(4000), mode: z.enum(["fact", "timeline", "deep"]).default("deep"), idempotencyKey: z.string().min(1).max(200), scope: ScopeSchema.default({ allowImages: false, sources: [] }) });
export type TaskState = "queued" | "running" | "waiting_user" | "paused" | "completed" | "failed" | "cancelled";
export type Task = { mode?: InvestigationMode; id: string; caseId: string; goal: string; scope: z.infer<typeof ScopeSchema>; state: TaskState; step: number; revision: number; modelCalls: number; toolCalls: number; activeMs: number; error: string; snapshot: Segment[]; artifacts: Artifact[]; reads: string[]; collectedSources?: number; collectionNotes?: string[]; model?: {provider:string;name:string}; decisions: { id: string; value: string; reason: string; at: string }[]; createdAt: string; lease: number; owner: string };
