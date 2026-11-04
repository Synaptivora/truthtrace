import type { CaseAnalysis } from "../../components/truthtrace/api-client";
import { analysisReport } from "../../components/truthtrace/case-view";
export type ReportDocument={schemaVersion:1;caseId:string|null;generatedAt:string;mode:string;markdown:string};
export function reportDocument(result:CaseAnalysis,notes:Record<string,string>={}):ReportDocument {
 const coverage=result.notice;
 const limitations=coverage&&Object.keys(coverage).length?Object.entries(coverage).filter(([key])=>["truncated","truncatedChars","droppedEvidence","droppedImages","skipped","note"].includes(key)).map(([key,value])=>`${key}: ${typeof value==="string"?value:JSON.stringify(value)}`):["未提供完整覆盖统计；不能据此认定材料全部读取。"];
 const commitments=result.analysis.commitments.flatMap(c=>[`- ${c.commitment}；期限：${c.dueLabel}；记录状态：${c.status}（到期不等于违约）`,...c.evidenceRefs.map(r=>`  - [${r.evidenceId}] ${r.quote} · ${r.provenance?`案件 ${r.provenance.caseId} v${r.provenance.version} ${JSON.stringify(r.provenance.locator)}`:"旧引用版本未解析"}`)]);
 return {schemaVersion:1,caseId:result.caseId||null,generatedAt:result.analysis.generatedAt,mode:result.analysis.analysisMode,markdown:analysisReport(result,notes)+"\n\n## 承诺记录\n"+commitments.join("\n")+"\n\n## 覆盖与核查边界\n"+limitations.join("\n")+"\n引用存在不等于文本支持，更不等于外部事实已核实。来源未提供版本时按旧引用处理，不推断版本。\n报告格式版本：1；模型名称/提示词版本：未记录。"};
}
function escapeHtml(value:string){return value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));}
export function renderReport(document:ReportDocument,format:"markdown"|"html"):string {
 if(format==="markdown")return document.markdown;
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>TruthTrace 调查报告</title><style>body{max-width:900px;margin:2rem auto;padding:1rem;color:#222;font:16px/1.8 system-ui,sans-serif}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}@media print{body{margin:0;max-width:none}pre{orphans:3;widows:3}}@page{margin:18mm}</style></head><body><pre>${escapeHtml(document.markdown)}</pre></body></html>`;
}
