"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Flag, FolderOpen, GitBranch, Clock3, FileText, Maximize, X, Sparkles, Plus, Download, Search } from "lucide-react";
import { RelationshipGraph } from "../relationship-graph";
import { Timeline } from "../timeline";
import { EvidenceSchema, type Evidence, type EvidenceRef } from "@/lib/contracts";
import { analyzeFiles } from "./api-client";
import { materialKinds, uniqueRefs } from "./case-view";
import type { CaseAnalysis } from "./api-client";
import { EvidenceContent } from "./evidence-content";
import { EvidenceThumbnail } from "./evidence-thumbnail";
import { CommitmentPanel } from "./commitments/panel";
import { reportDocument, renderReport } from "@/lib/report-render";

import avatar from "./assets/inspector-avatar.png";

export function ContractWorkbench({ result, onHome, onUpdate }: { result: CaseAnalysis; onHome: () => void; onUpdate: (value: CaseAnalysis) => void | Promise<void> }) {
  const { analysis, evidence } = result;
  const [reportFormat,setReportFormat]=useState<"markdown"|"html">("markdown");
  const [reportPreview,setReportPreview]=useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [analyzing,setAnalyzing]=useState(false);
  const [notes, setNotes] = useState<Record<string, string>>(result.reviewNotes || {});
  const [comparison, setComparison] = useState<string | null>(null);
  const downloadUrls = useRef(new Set<string>());
  useEffect(() => () => { for (const url of downloadUrls.current) URL.revokeObjectURL(url); downloadUrls.current.clear(); }, []);
  const upload = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [view, setView] = useState<"graph" | "timeline" | "evidence" | "actions" | "commitments">("graph");
  const [selected, setSelected] = useState<string | null>(null);
  const [historical,setHistorical]=useState<Evidence|null>(null);
  const [citation,setCitation]=useState<EvidenceRef|null>(null);
  const sourceRequest=useRef<AbortController|null>(null);
  useEffect(()=>()=>sourceRequest.current?.abort(),[]);
  const [focused, setFocused] = useState<string[]>([]);
  const [immersive, setImmersive] = useState(false);
  const nativeFullscreen = useRef(false);
  // 导入提示（跳过的会话 / 被裁剪的证据）弹层关掉后才看得到，所以放在工作台里，允许手动关闭
  const [noticeOpen, setNoticeOpen] = useState(true);
  const notice = result.notice;
  const hasNotice = Boolean(notice && (notice.skipped?.length || notice.truncated || notice.truncatedChars
    || notice.droppedEvidence || notice.droppedImages || notice.note));
  const dialog = useRef<HTMLDialogElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const original = historical || evidence.find(item => item.id === selected);

  const finding = analysis.contradictions.find(item => item.id === comparison);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (original || finding) dialog.current?.showModal(); else dialog.current?.close(); }, [original, finding]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    if (immersive) document.body.style.overflow = "hidden";
    function escape(event: KeyboardEvent) { if (event.key === "Escape" && !dialog.current?.open) setImmersive(false); }
    function nativeChanged() { if (nativeFullscreen.current && !document.fullscreenElement) { nativeFullscreen.current = false; setImmersive(false); } }
    document.addEventListener("keydown", escape);
    document.addEventListener("fullscreenchange", nativeChanged);
    return () => { document.body.style.overflow = previous; document.removeEventListener("keydown", escape); document.removeEventListener("fullscreenchange", nativeChanged); };
  }, [immersive]);
  async function toggleFullscreen() {
    setImmersive(value => !value);
    if (document.fullscreenElement === shell.current) { nativeFullscreen.current = false; await document.exitFullscreen(); }
    else if (!immersive && document.fullscreenEnabled) {
      try { await shell.current?.requestFullscreen(); nativeFullscreen.current = document.fullscreenElement === shell.current; } catch { nativeFullscreen.current = false; }
    }
  }
  function focusSources(refs: EvidenceRef[]) { setView("graph"); setFocused([...new Set(refs.map(ref => ref.evidenceId))]); }
  const openSource = useCallback((id: string) => { sourceRequest.current?.abort();setHistorical(null);setCitation(null);setComparison(null); setSelected(id); }, []);
  async function openReference(ref:EvidenceRef) {
    sourceRequest.current?.abort();setSelected(null);setHistorical(null);setComparison(null);setCitation(null);
    if(!ref.provenance){setError("旧引用未记录版本，不能精确定位；引文："+ref.quote);return;}
    if(ref.provenance.caseId!==result.caseId){setError("引用不属于当前案件");return;}
    const controller=new AbortController();sourceRequest.current=controller;
    try{const response=await fetch(`/api/cases/${encodeURIComponent(ref.provenance.caseId)}/evidence/${encodeURIComponent(ref.evidenceId)}?version=${ref.provenance.version}`,{signal:controller.signal});if(!response.ok)throw Error("历史版本不可用");const data=await response.json();const item=EvidenceSchema.parse(data.evidence);if(item.id!==ref.evidenceId||item.version!==ref.provenance.version)throw Error("历史版本不匹配");if(ref.provenance.locator.type==="text_range"&&item.content.slice(ref.provenance.locator.start,ref.provenance.locator.end)!==ref.quote)throw Error("引用范围不匹配");if(!controller.signal.aborted){setHistorical(item);setCitation(ref);}}
    catch{if(!controller.signal.aborted)setError("无法打开确切历史版本；保留引文："+ref.quote);}
  }
  useEffect(()=>{
    const locate=(event:Event)=>{const d=(event as CustomEvent).detail;if(!d||d.caseId!==result.caseId||!Number.isInteger(d.version)||!Number.isInteger(d.start)||!Number.isInteger(d.end)||typeof d.quote!=="string")return;void openReference({evidenceId:d.evidenceId,quote:d.quote,provenance:{schemaVersion:2,caseId:d.caseId,evidenceId:d.evidenceId,version:d.version,segmentId:d.segmentId||null,originalHash:null,parserVersion:null,locator:{type:"text_range",start:d.start,end:d.end},verificationMethod:"exact_text"}});};
    try{const raw=sessionStorage.getItem("truthtrace.pending-locator.v1");if(raw){const d=JSON.parse(raw);if(d.caseId===result.caseId){sessionStorage.removeItem("truthtrace.pending-locator.v1");if(Number.isInteger(d.version)&&d.version>0&&Number.isInteger(d.start)&&Number.isInteger(d.end)&&d.start>=0&&d.end>d.start)void fetch(`/api/cases/${encodeURIComponent(d.caseId)}/evidence/${encodeURIComponent(d.evidenceId)}?version=${d.version}`).then(async response=>{if(!response.ok)throw Error();return response.json();}).then(data=>{const item=EvidenceSchema.parse(data.evidence);if(item.id!==d.evidenceId||item.version!==d.version||d.end>item.content.length)throw Error();locate(new CustomEvent("truthtrace:locate-evidence",{detail:{...d,quote:item.content.slice(d.start,d.end)}}));}).catch(()=>setError("搜索引用的历史版本不可用"));}}}catch{sessionStorage.removeItem("truthtrace.pending-locator.v1");}
    window.addEventListener("truthtrace:locate-evidence",locate);window.dispatchEvent(new CustomEvent("truthtrace:workbench-ready",{detail:{caseId:result.caseId}}));
    return ()=>window.removeEventListener("truthtrace:locate-evidence",locate);
  });
  async function supplement(files: File[]) {
    if (!files.length) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError("");
    try {
      const next = await analyzeFiles(files, controller.signal, () => {}, evidence);
      if (!controller.signal.aborted) { await onUpdate({ ...next, caseName: result.caseName, caseId: result.caseId, reviewNotes: notes }); setFocused([]); }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "补充材料失败，请重试。"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function exportReport() {
    const url = URL.createObjectURL(new Blob([renderReport(reportDocument(result, notes), reportFormat)], { type: reportFormat==="html"?"text/html;charset=utf-8":"text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `TruthTrace-调查报告.${reportFormat==="html"?"html":"md"}`; downloadUrls.current.add(url); document.body.appendChild(link); link.click(); link.remove();
  }
  async function reanalyze(){setAnalyzing(true);setError("");try{
    const response=await fetch(`/api/cases/${result.caseId}/analyze`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});const data=await response.json();
    if(!response.ok)throw new Error(data.error||"分析未完成");await onUpdate(data.case);setNoticeOpen(true);
  }catch(e){setError((e as Error).message);}finally{setAnalyzing(false);}}
  const sourceChips = (refs: EvidenceRef[]) => uniqueRefs(refs).map((ref, index) => <button type="button" key={index} onClick={() => void openReference(ref)} title={ref.quote}>{evidence.find(item => item.id === ref.evidenceId)?.name ?? ref.evidenceId} ↗</button>);

  return <div ref={shell} className={`contract-shell ${immersive ? "contract-immersive" : ""}`}>
    {reportPreview&&<section role="dialog" aria-modal="true" aria-label="报告预览" style={{position:"fixed",inset:"5%",zIndex:1000,background:"white",padding:16,display:"flex",flexDirection:"column"}}><button onClick={()=>setReportPreview(false)}>关闭报告预览</button><iframe title="报告内容" sandbox="" srcDoc={renderReport(reportDocument(result,notes),"html")} style={{width:"100%",flex:1,border:0}} /></section>}
    <header className="contract-topbar">
      <button className="contract-brand" onClick={onHome} aria-label="返回案件首页" title="点击咪探长，返回案件首页"><Image src={avatar} alt="咪探长" width={57} height={60} /><span>返回首页</span></button>
      <div className="contract-case-heading"><h1>{result.caseName || analysis.caseTitle}</h1></div>
      <span className={`contract-mode mode-${analysis.analysisMode}`}>{{ mock: "模拟分析", rule: "规则分析", model: "模型分析" }[analysis.analysisMode]}</span>
      <button className="contract-outline investigator-entry" onClick={()=>window.dispatchEvent(new CustomEvent("truthtrace:assistant",{detail:{view:"investigation"}}))}><Search size={18} />自主调查</button>
      <input ref={upload} type="file" accept="image/*,.pdf,.txt,.md" multiple hidden onChange={event => { void supplement(Array.from(event.target.files || [])); event.target.value = ""; }} /><button className="contract-outline" disabled={busy} onClick={() => upload.current?.click()}><Plus size={14} />{busy ? "正在整理…" : "补充材料"}</button><label>报告格式<select aria-label="报告格式" value={reportFormat} onChange={event=>setReportFormat(event.target.value as "markdown"|"html")}><option value="markdown">Markdown</option><option value="html">HTML / 打印</option></select></label><button className="contract-outline" onClick={()=>setReportPreview(true)}>预览报告</button><button className="contract-outline" onClick={exportReport}><Download size={14} />导出报告</button>
    </header>
    <div className="contract-import-notice" role="status"><strong>{analysis.analysisMode==="model"?"当前为模型分析，点击连线可查互动依据。":"当前只有材料统计，尚未完成模型分析。"}</strong><button className="contract-outline" disabled={analyzing||busy} onClick={()=>void reanalyze()}>{analyzing?"正在核对原文并整理关系…":analysis.analysisMode==="model"?"重新分析材料":"用模型分析已有材料"}</button>{analysis.analysisMode!=="model"&&<span>无需重新导入；可在底部应用设置中连接模型。</span>}</div>
    {busy && <p className="contract-feedback" role="status">正在整理补充材料，现有结果保留。</p>}{error && <p className="contract-feedback" role="alert">{error}</p>}
    {hasNotice && noticeOpen && notice && (
      <div className="contract-import-notice" role="status">
        <strong>{notice.synced ? `已导入 ${notice.synced} 条证据` : "已导入证据"}</strong>
        {notice.truncated && <span>· 超出单次取数上限，只保留了前一部分</span>}
        {notice.droppedEvidence ? <span>· {notice.droppedEvidence} 条材料超出单次上限，未参与本次分析</span> : null}
        {notice.droppedImages ? <span>· {notice.droppedImages} 张图片未参与本次分析（当前连接范围或图片预算限制），请查看原图核对</span> : null}
        {notice.truncatedChars ? <span>· {notice.truncatedChars} 条正文过长，模型只读到前一部分</span> : null}
        {notice.skipped?.length ? <span>· {notice.skipped.length} 段被跳过（不在下面证据里）</span> : null}
        {notice.skipped?.map(item => <small key={item.title}>{item.title}：{item.reason}</small>)}
        {notice.note && <small>{notice.note}</small>}
        <button type="button" onClick={() => setNoticeOpen(false)} aria-label="关闭导入提示"><X size={14} /></button>
      </div>
    )}
    <div className="contract-columns">
      <aside className="contract-catalog"><h2>证据档案 <small>{evidence.length}</small></h2>{evidence.map((item, index) => <button key={item.id} type="button" onClick={() => openSource(item.id)} className={focused.includes(item.id) ? "is-focused" : ""}><FileText size={17} /><span><small>材料 {String(index + 1).padStart(2, "0")}</small><strong>{item.name}</strong><em>{item.source || materialKinds[item.kind]}</em></span></button>)}</aside>
      <section className="contract-investigation">
        <header><h2>调查工作台</h2><nav aria-label="调查视图">{([["graph", "关系图", GitBranch], ["timeline", "时间线", Clock3], ["evidence", "证据档案", FolderOpen], ["actions", "补证建议", FileText], ["commitments", "承诺追踪", Flag]] as const).map(([key, label, Icon]) => <button key={key} aria-pressed={view === key} onClick={() => setView(key)}><Icon size={14} />{label}</button>)}</nav><button onClick={() => void toggleFullscreen()} className="contract-expand" aria-label={immersive ? "退出沉浸展示" : "沉浸展示"}><Maximize size={16} /></button></header>
        {focused.length > 0 && <div className="contract-focus-bar" role="status"><span>已定位 {focused.length} 份关联证据</span><button onClick={() => setFocused([])}>显示全部 ×</button></div>}
        <div className="contract-content">{view === "graph" ? <RelationshipGraph analysis={analysis} evidence={evidence} focusedEvidenceIds={focused} onOpenEvidence={openSource} /> : view === "timeline" ? <Timeline analysis={analysis} evidence={evidence} onOpenEvidence={openSource} onOpenReference={ref=>void openReference(ref)} /> : view === "evidence" ? <div className="contract-evidence-grid">{evidence.map(item => <button key={item.id} className="contract-material-card" onClick={() => openSource(item.id)}><EvidenceThumbnail item={item} /><strong>{item.name}</strong><span>{materialKinds[item.kind]} · 查看原文 ↗</span></button>)}</div> : view === "commitments" ? <CommitmentPanel result={result} onOpen={openSource} onReview={()=>void reanalyze()} /> : <div className="contract-records">
          <h3>承诺追踪</h3>{analysis.commitments.map(item => <article key={item.id}><strong>{item.commitment}</strong><p>{item.dueLabel} · {{ fulfilled: "已履行", pending: "待履行", disputed: "履行存疑", unknown: "尚未明确" }[item.status]}</p><div>{sourceChips(item.evidenceRefs)}</div></article>)}{analysis.commitments.length === 0 && <p>当前结果未提取到明确承诺。</p>}
          <h3>下一步补证</h3>{(analysis.analysisMode === "model" ? analysis.evidenceGaps : []).map(item => <article key={item.id}><strong>{item.title}</strong><p>{item.reason}</p><p>{item.suggestedEvidence}</p><div>{sourceChips(item.evidenceRefs)}</div></article>)}{(analysis.evidenceGaps.length === 0 || analysis.analysisMode === "mock") && <p>{analysis.analysisMode === "mock" ? "模拟分析未生成补证建议。" : "当前结果没有补证建议。"}</p>}
        </div>}</div>
      </section>
      <aside className="contract-findings"><h2><Flag size={18} />重点发现</h2><p className="contract-summary">{analysis.analysisMode === "mock" ? "仅完成材料登记，尚未连接分析模型。" : analysis.analysisMode === "rule" ? "已完成材料整理；人物关系与疑点需连接分析模型。" : analysis.summary}</p>{analysis.contradictions.map((item, index) => <article key={item.id} className="contract-finding"><button className="contract-finding-title" onClick={() => focusSources(item.evidenceRefs)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong></button><p>{item.description}</p><small>待核实</small><button className="contract-compare" onClick={() => { setSelected(null); setComparison(item.id); }}>对照原文 →</button><div className="contract-sources">{sourceChips(item.evidenceRefs)}</div></article>)}{analysis.contradictions.length === 0 && analysis.analysisMode !== "mock" && <div className="contract-empty"><Sparkles size={23} /><p>当前结果未标出证据差异。</p></div>}</aside>
    </div>
    <dialog ref={dialog} className="contract-source-dialog" onClose={() => { sourceRequest.current?.abort();setSelected(null); setHistorical(null);setCitation(null); setComparison(null); }} onClick={event => { if (event.target === event.currentTarget) { sourceRequest.current?.abort();setSelected(null); setHistorical(null);setCitation(null); setComparison(null); } }}><header><span><small>原始材料 · {original?.source || materialKinds[original?.kind || ""] || "证据对照"}</small><h2>{original?.name || finding?.title}</h2></span><button onClick={() => { sourceRequest.current?.abort();setSelected(null); setHistorical(null);setCitation(null); setComparison(null); }} aria-label="关闭原文"><X size={21} /></button></header>{finding ? <div className="contract-comparison">{uniqueRefs(finding.evidenceRefs).map((ref, index) => <article key={index}><h3>{evidence.find(e => e.id === ref.evidenceId)?.name || ref.evidenceId}</h3><blockquote>{ref.quote}</blockquote><small>{ref.locator}</small><button onClick={() => void openReference(ref)}>查看完整材料 ↗</button></article>)}</div> : original?.kind === "image" ? <Image src={original.content} alt={original.name} width={1000} height={800} unoptimized /> : original ? <EvidenceContent item={original} all={evidence} onOpen={openSource} highlight={citation?.provenance?.locator.type==="text_range"?{...citation.provenance.locator,quote:citation.quote}:undefined} /> : null}{citation&&<p>引用版本 v{citation.provenance?.version} · {citation.provenance?.locator.type==="text_range"?"按原文字符范围定位":"整份材料；未提供精确坐标"}<button onClick={()=>setCitation(null)}>退出高亮</button></p>}{original && <details className="source-note"><summary>核查备注</summary><label><span className="agent-sr">核查备注</span><textarea value={notes[original.id] || ""} onChange={event => { const next = { ...notes, [original.id]: event.target.value }; setNotes(next); void Promise.resolve(onUpdate({ ...result, reviewNotes: next })).catch(e=>setError(e.message)); }} placeholder="识别有误或尚待核实的内容…" maxLength={8000} /><small>保留本页，随报告导出；原始材料不变。</small></label></details>}</dialog>
  </div>;
}
