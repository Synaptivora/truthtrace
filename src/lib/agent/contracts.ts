import { z } from "zod";
import { AnalysisResultSchema, EvidenceSchema } from "../contracts";
import { ConnectionSchema } from "./providers";
export const ChatMessageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(12000) });
export const AgentRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(24).refine(m => m.at(-1)?.role === "user", "最后一条必须为用户问题"),
  evidence: z.array(EvidenceSchema).max(30).default([]).refine(e => new Set(e.map(x => x.id)).size === e.length, "证据 ID 重复"),
  analysis: AnalysisResultSchema.optional(),
  connection: ConnectionSchema.optional(),
  mode: z.enum(["server", "demo", "custom"]).default("server"),
  allowImages: z.boolean().default(false),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type Citation = { id: string; evidenceId: string; name: string; excerpt: string };
export type AgentReply = { text: string; mode: "model" | "demo"; model?: string; citations: Citation[]; steps: string[] };
export type AgentEvent = { type: "status"; text: string } | { type: "result"; reply: AgentReply } | { type: "error"; error: string };
