import { z } from "zod";

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
export const TaskInputSchema = z.object({ goal: z.string().trim().min(1).max(4000), idempotencyKey: z.string().min(1).max(200), scope: ScopeSchema.default({ allowImages: false, sources: [] }) });
export type TaskState = "queued" | "running" | "waiting_user" | "paused" | "completed" | "failed" | "cancelled";
export type Task = { id: string; caseId: string; goal: string; scope: z.infer<typeof ScopeSchema>; state: TaskState; step: number; revision: number; modelCalls: number; toolCalls: number; activeMs: number; error: string; snapshot: Segment[]; artifacts: Artifact[]; reads: string[]; collectedSources?: number; collectionNotes?: string[]; model?: {provider:string;name:string}; decisions: { id: string; value: string; reason: string; at: string }[]; createdAt: string; lease: number; owner: string };
