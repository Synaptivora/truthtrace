import type { AnalysisResult, EvidenceRef, TimelineEvent } from "@/lib/contracts";
import type { CaseAnalysis } from "./api-client";

// Merge exact duplicate events only; keep differing accounts separate and retain sources.
export function mergeTimeline(events: TimelineEvent[]): TimelineEvent[] {
  const merged = new Map<string, TimelineEvent>();
  for (const event of events) {
    const key = JSON.stringify([event.occurredAt, event.timeLabel.trim(), event.timePrecision, event.title.trim(), event.description.trim()]);
    const previous = merged.get(key);
    if (!previous) merged.set(key, { ...event, evidenceRefs: [...event.evidenceRefs], participantIds: [...event.participantIds] });
    else {
      previous.participantIds = [...new Set([...previous.participantIds, ...event.participantIds])];
      previous.evidenceRefs = uniqueRefs([...previous.evidenceRefs, ...event.evidenceRefs]);
    }
  }
  return [...merged.values()].sort((a, b) => a.occurredAt === b.occurredAt ? 0 : !a.occurredAt ? 1 : !b.occurredAt ? -1 : a.occurredAt.localeCompare(b.occurredAt));
}
export function uniqueRefs(refs: EvidenceRef[]): EvidenceRef[] {
  return [...new Map(refs.map(ref => [JSON.stringify([ref.evidenceId, ref.quote, ref.locator,ref.provenance]), ref])).values()];
}
export function referenceLocation(ref:EvidenceRef):string {
 const p=ref.provenance;if(!p)return ref.locator?`旧定位提示：${ref.locator}；版本未解析`:"旧引用：版本未解析";
 const location=p.locator.type==="text_range"?`字符 ${p.locator.start}–${p.locator.end}（UTF-16，末尾不含）`:"整份材料，未提供局部坐标";
 return `案件 ${p.caseId} · v${p.version} · ${p.verificationMethod==="exact_text"?"原文字符范围引用":"图像识别，未经逐字校验"} · ${location} · 片段 ${p.segmentId??"跨片段或未记录"} · 原件 SHA-256：${p.originalHash??"未记录"} · 解析器版本：${p.parserVersion??"未记录"}`;
}
export function analysisReport(result: CaseAnalysis, notes: Record<string, string>): string {
  const { analysis, evidence } = result;
  const sources = (refs: EvidenceRef[]) => uniqueRefs(refs).map(ref => `  - [${ref.evidenceId}] ${evidence.find(e => e.id === ref.evidenceId)?.name || "来源缺失"}：${ref.quote}（${referenceLocation(ref)}）`);
  return ["# " + (result.caseName || analysis.caseTitle), "", ({ mock: "模拟分析 · 不代表真实识别结论。", rule: "规则整理 · 依据材料统计，未经模型推理。", model: "模型整理 · 以下疑点尚待人工核实。" }[analysis.analysisMode]), `生成时间：${analysis.generatedAt}`, "", "## 事件概况", analysis.summary, "", "## 涉及人物与主体", ...analysis.people.flatMap(p => [`- ${p.name} / ${p.role}：${p.summary}`, ...sources(p.evidenceRefs)]), "", "## 事件时间线", ...mergeTimeline(analysis.events).flatMap(e => [`- ${e.timeLabel} ${e.title}：${e.description}`, ...sources(e.evidenceRefs)]), "", "## 待核查问题", ...analysis.contradictions.flatMap(c => [`- 待核实：${c.title}。${c.description}`, ...sources(c.evidenceRefs)]), "", "## 补充材料", ...analysis.evidenceGaps.flatMap(g => [`- ${g.title}：${g.suggestedEvidence}`, ...sources(g.evidenceRefs)]), "", "## 核查备注（人工填写，未经模型重分析）", ...Object.entries(notes).filter(([, note]) => note.trim()).map(([id, note]) => `- [${id}] ${note}`), "", "## 原始材料索引", ...evidence.map(e => `- [${e.id}] ${e.name} / ${e.source || e.kind} · 版本 ${e.version??"未记录"} · 原件 ${e.originalHash??"未记录"}`)].join("\n");
}
export const materialKinds: Record<string, string> = { text: "文本", chat: "聊天记录", image: "图片", pdf: "PDF 文件" };
export type { AnalysisResult };
