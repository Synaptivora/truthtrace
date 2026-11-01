"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Flag, FolderOpen, GitBranch, Clock3, FileText, Maximize, X, Users, Sparkles } from "lucide-react";
import { RelationshipGraph } from "../relationship-graph";
import { Timeline } from "../timeline";
import type { EvidenceRef } from "@/lib/contracts";
import type { CaseAnalysis } from "./api-client";
import avatar from "./assets/inspector-avatar.png";

export function ContractWorkbench({ result, onHome }: { result: CaseAnalysis; onHome: () => void }) {
  const { analysis, evidence } = result;
  const [view, setView] = useState<"graph" | "timeline" | "actions">("graph");
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState<string[]>([]);
  const [immersive, setImmersive] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const original = evidence.find(item => item.id === selected);

  useEffect(() => { if (original) dialog.current?.showModal(); else dialog.current?.close(); }, [original]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    if (immersive) document.body.style.overflow = "hidden";
    function escape(event: KeyboardEvent) { if (event.key === "Escape" && !dialog.current?.open) setImmersive(false); }
    function nativeChanged() { if (immersive && !document.fullscreenElement) setImmersive(false); }
    document.addEventListener("keydown", escape);
    document.addEventListener("fullscreenchange", nativeChanged);
    return () => { document.body.style.overflow = previous; document.removeEventListener("keydown", escape); document.removeEventListener("fullscreenchange", nativeChanged); };
  }, [immersive]);
  async function toggleFullscreen() {
    setImmersive(value => !value);
    if (document.fullscreenElement === shell.current) await document.exitFullscreen();
    else if (!immersive && document.fullscreenEnabled) {
      try { await shell.current?.requestFullscreen(); } catch { /* Viewport presentation remains available. */ }
    }
  }
  function focusSources(refs: EvidenceRef[]) { setView("graph"); setFocused([...new Set(refs.map(ref => ref.evidenceId))]); }
  const hint = analysis.contradictions[0]?.title ?? (analysis.analysisMode === "mock" ? "材料已登记，当前没有真实识别结论。" : "分析已完成，请结合原文核对。");
  const sourceChips = (refs: EvidenceRef[]) => refs.map((ref, index) => <button type="button" key={`${ref.evidenceId}-${index}`} onClick={() => setSelected(ref.evidenceId)} title={ref.quote}>{evidence.find(item => item.id === ref.evidenceId)?.name ?? ref.evidenceId} ↗</button>);

  return <div ref={shell} className={`contract-shell ${immersive ? "contract-immersive" : ""}`}>
    <header className="contract-topbar">
      <button className="contract-brand" onClick={onHome} aria-label="返回案件首页"><Image src={avatar} alt="咪探长" width={57} height={60} /><span>TruthTrace<small>AI 现实档案调查局</small></span></button>
      <div><small>当前案件</small><h1>{result.caseName || analysis.caseTitle}</h1></div>
      <span className={`contract-mode mode-${analysis.analysisMode}`}>{analysis.analysisMode === "mock" ? "模拟分析" : "模型分析"}</span>
      <button className="contract-outline" onClick={onHome}><FolderOpen size={14} /> 案件首页</button>
    </header>
    <section className="case-stats contract-stats" aria-label="本案分析统计">
      {[[FileText, evidence.length, "份原始材料"], [Users, analysis.people.length, "位相关人物"], [Flag, analysis.contradictions.length, "处待核查差异"], [GitBranch, analysis.relationships.length, "条有来源的关联"]].map(([Icon, count, label], i) => {
        const StatIcon = Icon as typeof FileText;
        return <div className="stat" key={i}><span className="stat-icon"><StatIcon /></span><strong>{String(count).padStart(2, "0")}</strong><span>{label as string}</span></div>;
      })}
    </section>
    <div className="contract-columns">
      <aside className="contract-catalog"><h2>证据档案 <small>{evidence.length}</small></h2>{evidence.map((item, index) => <button key={item.id} type="button" onClick={() => setSelected(item.id)} className={focused.includes(item.id) ? "is-focused" : ""}><FileText size={17} /><span><small>材料 {String(index + 1).padStart(2, "0")}</small><strong>{item.name}</strong><em>{item.source || item.kind}</em></span></button>)}</aside>
      <section className="contract-investigation">
        <header><h2>调查工作台</h2><nav aria-label="调查视图">{([["graph", "关系图", GitBranch], ["timeline", "时间线", Clock3], ["actions", "核查记录", FileText]] as const).map(([key, label, Icon]) => <button key={key} aria-pressed={view === key} onClick={() => setView(key)}><Icon size={14} />{label}</button>)}</nav><button onClick={() => void toggleFullscreen()} className="contract-expand" aria-label={immersive ? "退出沉浸展示" : "沉浸展示"}><Maximize size={16} /></button></header>
        {focused.length > 0 && <div className="contract-focus-bar" role="status"><span>已定位 {focused.length} 份关联证据</span><button onClick={() => setFocused([])}>显示全部 ×</button></div>}
        <div className="contract-content">{view === "graph" ? <RelationshipGraph analysis={analysis} evidence={evidence} focusedEvidenceIds={focused} onOpenEvidence={setSelected} /> : view === "timeline" ? <Timeline analysis={analysis} evidence={evidence} onOpenEvidence={setSelected} /> : <div className="contract-records">
          <h3>承诺追踪</h3>{analysis.commitments.map(item => <article key={item.id}><strong>{item.commitment}</strong><p>{item.dueLabel} · {{ fulfilled: "已履行", pending: "待履行", disputed: "履行存疑", unknown: "尚未明确" }[item.status]}</p><div>{sourceChips(item.evidenceRefs)}</div></article>)}{analysis.commitments.length === 0 && <p>当前结果未提取到明确承诺。</p>}
          <h3>下一步补证</h3>{analysis.evidenceGaps.map(item => <article key={item.id}><strong>{item.title}</strong><p>{item.reason}</p><p>{item.suggestedEvidence}</p><div>{sourceChips(item.evidenceRefs)}</div></article>)}{analysis.evidenceGaps.length === 0 && <p>当前结果没有补证建议。</p>}
        </div>}</div>
        <div className="contract-assistant"><Image src={avatar} alt="Synapse · 咪探长" width={45} height={48} /><span><strong>Synapse · 咪探长</strong><small>{hint}</small></span><button onClick={() => setSelected(evidence[0]?.id ?? null)}>查看原文 →</button></div>
      </section>
      <aside className="contract-findings"><h2><Flag size={18} />重点发现</h2><p className="contract-summary">{analysis.summary}</p>{analysis.contradictions.map((item, index) => <article key={item.id} className="contract-finding"><button className="contract-finding-title" onClick={() => focusSources(item.evidenceRefs)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong></button><p>{item.description}</p><small>待核查 · 点击标题在图中定位</small><div className="contract-sources">{sourceChips(item.evidenceRefs)}</div></article>)}{analysis.contradictions.length === 0 && <div className="contract-empty"><Sparkles size={23} /><p>{analysis.analysisMode === "mock" ? "当前仅完成登记，不生成虚构疑点。" : "当前结果未标出证据差异。"}</p></div>}<p className="contract-boundary">每项发现都保留来源，需结合原文人工核查。</p></aside>
    </div>
    <dialog ref={dialog} className="contract-source-dialog" onClose={() => setSelected(null)} onClick={event => { if (event.target === event.currentTarget) setSelected(null); }}><header><span><small>原始材料 · {original?.source || original?.kind}</small><h2>{original?.name}</h2></span><button onClick={() => setSelected(null)} aria-label="关闭原文"><X size={21} /></button></header>{original?.kind === "image" ? <Image src={original.content} alt={original.name} width={1000} height={800} unoptimized /> : <pre>{original?.content}</pre>}</dialog>
  </div>;
}
