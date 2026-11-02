import { z } from "zod";

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["text", "chat", "image", "pdf"]),
  mimeType: z.string().min(1),
  content: z.string().min(1),
  source: z.string().optional(),
});

export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1),
  quote: z.string().min(1),
  locator: z.string().optional(),
});

export const PersonSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  summary: z.string().min(1),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
});

export const RelationshipSchema = z.object({
  id: z.string().min(1),
  sourcePersonId: z.string().min(1),
  targetPersonId: z.string().min(1),
  label: z.string().min(1),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
});

export const TimelineEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  occurredAt: z.string().nullable(),
  timeLabel: z.string().min(1),
  timePrecision: z.enum(["exact", "approximate", "unknown"]),
  participantIds: z.array(z.string()).default([]),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
});

export const ContradictionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
  status: z.literal("needs_review"),
  evidenceRefs: z.array(EvidenceRefSchema).min(2),
});

export const CommitmentSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  commitment: z.string().min(1),
  dueLabel: z.string().min(1),
  status: z.enum(["fulfilled", "pending", "disputed", "unknown"]),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
});

export const EvidenceGapSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  reason: z.string().min(1),
  suggestedEvidence: z.string().min(1),
  relatedEventIds: z.array(z.string()).default([]),
  evidenceRefs: z.array(EvidenceRefSchema).default([]),
});

export const AnalysisPayloadSchema = z.object({
  caseTitle: z.string().min(1),
  summary: z.string().min(1),
  people: z.array(PersonSchema),
  relationships: z.array(RelationshipSchema),
  events: z.array(TimelineEventSchema),
  contradictions: z.array(ContradictionSchema),
  commitments: z.array(CommitmentSchema),
  evidenceGaps: z.array(EvidenceGapSchema),
});

export const AnalysisResultSchema = AnalysisPayloadSchema.extend({
  generatedAt: z.string(),
  analysisMode: z.enum(["mock", "model", "rule"]),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type AnalysisPayload = z.infer<typeof AnalysisPayloadSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type Contradiction = z.infer<typeof ContradictionSchema>;
