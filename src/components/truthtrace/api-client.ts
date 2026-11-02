import { AnalysisResultSchema, EvidenceSchema } from "@/lib/contracts";
import type { AnalysisResult, Evidence } from "@/lib/contracts";

/** 导入/分析阶段需要让用户看见的一次性提示（弹层已关掉，所以挂在结果上带去工作台）。 */
export type ImportNotice = {
  synced?: number; // 本次导入的证据条数
  truncated?: boolean; // A 侧取数时被截断（不是 B 的分析上限）
  truncatedChars?: number; // 正文过长被截断的证据条数（B 侧 meta.truncated）
  droppedEvidence?: number; // 超出单次条数上限、没送进模型的材料条数
  droppedImages?: number; // 超出图片上限或字节预算、没送进模型的图片数
  note?: string; // A 的补充说明
  skipped?: { title: string; reason: string }[]; // 范围内没消息 / 被全部取消勾选的会话
};

export type CaseAnalysis = { evidence: Evidence[]; analysis: AnalysisResult; caseName?: string; caseId?: string; reviewNotes?: Record<string, string>; notice?: ImportNotice };

async function readReply(response: Response, fallback: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error(fallback); }
  if (!value || typeof value !== "object") throw new Error(fallback);
  const reply = value as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof reply.error === "string" ? reply.error : fallback);
  return reply;
}

/**
 * A 的 /source/extract 在「一条证据都凑不出来」时返回 status=empty + evidences=[] +
 * 每段的原因在 skipped[] 里。这种结果不能进 EvidenceSchema.array().min(1) ——
 * 那会抛一段 Zod 原始 JSON（`[{"code":"too_small",...}]`）直接甩给用户。
 * 这里把 A 的真实原因翻成一句人话：优先逐段原因，其次 hint，最后兜底。
 */
export function describeEmptyImport(reply: Record<string, unknown>): string {
  const skipped = Array.isArray(reply.skipped) ? reply.skipped : [];
  const detail = skipped
    .map(item => {
      const row = (item || {}) as { title?: unknown; reason?: unknown };
      const title = typeof row.title === "string" ? row.title.trim() : "";
      const reason = typeof row.reason === "string" ? row.reason.trim() : "";
      if (title && reason) return `${title}：${reason}`;
      return title || reason;
    })
    .filter(Boolean)
    .join("；");
  if (detail) return detail;
  if (typeof reply.hint === "string" && reply.hint.trim()) return reply.hint.trim();
  return "所选会话在范围内没有可导入的消息，请放宽时间范围或重新勾选。";
}

/** 从 /api/analyze 的 meta 取「正文被截断」的条数；没有就返回 undefined。 */
export function truncatedFromMeta(reply: Record<string, unknown>): number | undefined {
  const meta = reply.meta;
  if (!meta || typeof meta !== "object") return undefined;
  const count = (meta as { truncated?: unknown }).truncated;
  return typeof count === "number" && count > 0 ? count : undefined;
}

/** 从 meta 取「送进模型前放弃了什么」：条数上限与图片上限是分开计的两笔账。 */
export function droppedFromMeta(reply: Record<string, unknown>): { evidence: number; images: number } {
  const meta = reply.meta;
  if (!meta || typeof meta !== "object") return { evidence: 0, images: 0 };
  const row = meta as { droppedEvidence?: unknown; droppedImages?: unknown };
  return {
    evidence: typeof row.droppedEvidence === "number" && row.droppedEvidence > 0 ? row.droppedEvidence : 0,
    images: typeof row.droppedImages === "number" && row.droppedImages > 0 ? row.droppedImages : 0,
  };
}

// These are the existing B-owned routes; C does not change their fields.
// C 侧不再自己 slice：条数/图片的取舍由服务端按类型分档决定，并把放弃了什么
// 通过 meta 回传（以前 C 悄悄截到 30 条，用户以为「传进去的就是全部分析过的」）。
// 这里只留一个病态输入保护，避免把几万条证据塞进一次请求。
const MAX_ANALYZE_EVIDENCE = 200;

export async function analyzeFiles(files: File[], signal: AbortSignal, onParsed: () => void, existing: Evidence[] = []): Promise<CaseAnalysis> {
  const body = new FormData();
  files.forEach(file => body.append("files", file));
  const parsedReply = await readReply(await fetch("/api/evidence/parse", { method: "POST", body, signal }), "材料解析失败，请稍后重试。");
  const parsed = EvidenceSchema.array().min(1).safeParse(parsedReply.evidence);
  if (!parsed.success) throw new Error("材料解析结果无效，请重试。");
  onParsed();
  const combined = [...existing, ...parsed.data.map(item => existing.some(old => old.id === item.id) ? { ...item, id: crypto.randomUUID() } : item)];
  const kept = combined.slice(0, MAX_ANALYZE_EVIDENCE);
  const analysisReply = await readReply(await fetch("/api/analyze", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evidence: kept }),
  }), "分析失败，请稍后重试。");
  const result = AnalysisResultSchema.safeParse(analysisReply.analysis);
  if (!result.success) throw new Error("分析结果未通过格式校验，请重试。");

  const notice: ImportNotice = {};
  const truncatedChars = truncatedFromMeta(analysisReply);
  if (truncatedChars) notice.truncatedChars = truncatedChars;
  const dropped = droppedFromMeta(analysisReply);
  if (dropped.evidence) notice.droppedEvidence = dropped.evidence;
  if (dropped.images) notice.droppedImages = dropped.images;
  if (combined.length > kept.length) {
    notice.note = `解析出 ${combined.length} 条证据，本次最多送 ${MAX_ANALYZE_EVIDENCE} 条`;
  }
  return {
    evidence: kept,
    analysis: result.data,
    ...(Object.keys(notice).length ? { notice } : {}),
  };
}
