"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileQuestion,
  FileText,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Play,
  RotateCcw,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
} from "lucide-react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";
import { demoAnalysis, demoEvidence } from "@/lib/demo-case";
import { RelationshipGraph } from "./relationship-graph";
import { Timeline } from "./timeline";

type WorkbenchProps = {
  initialEvidence: Evidence[];
  initialAnalysis: AnalysisResult;
};

type CenterView = "graph" | "timeline" | "actions";

export function InvestigationWorkbench({ initialEvidence, initialAnalysis }: WorkbenchProps) {
  const [evidence, setEvidence] = useState<Evidence[]>(initialEvidence);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(initialAnalysis);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(initialEvidence[0]?.id ?? "");
  const [centerView, setCenterView] = useState<CenterView>("graph");
  const [isParsing, setIsParsing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedEvidence = evidence.find((item) => item.id === selectedEvidenceId) ?? evidence[0];
  const isBusy = isParsing || isAnalyzing;

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setIsParsing(true);
    setError("");

    try {
      const body = new FormData();
      files.forEach((file) => body.append("files", file));
      const response = await fetch("/api/evidence/parse", { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "证据解析失败");

      const parsed = result.evidence as Evidence[];
      setEvidence((current) => [...current.filter((item) => !item.id.startsWith("demo-")), ...parsed]);
      setAnalysis(null);
      setSelectedEvidenceId(parsed[0].id);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "证据解析失败");
    } finally {
      setIsParsing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function runAnalysis() {
    if (evidence.length === 0) return;
    setIsAnalyzing(true);
    setError("");

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidence }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "分析失败");
      setAnalysis(result.analysis);
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "分析失败");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function loadDemo() {
    setEvidence(demoEvidence);
    setAnalysis(demoAnalysis);
    setSelectedEvidenceId(demoEvidence[0].id);
    setCenterView("graph");
    setError("");
  }

  function openEvidence(evidenceId: string) {
    setSelectedEvidenceId(evidenceId);
  }

  return (
    <div className="workbench-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><ShieldCheck size={23} /></div>
          <div>
            <div className="brand-name">TRUTHTRACE</div>
            <div className="brand-subtitle">AI 现实档案调查局</div>
          </div>
        </div>
        <div className="case-heading">
          <span className="case-kicker">当前调查档案</span>
          <strong>{analysis?.caseTitle ?? "等待分析证据"}</strong>
        </div>
        <div className="topbar-actions">
          <span className="track-badge">赛题四 · 网络安全与反诈</span>
          <button className="button button-ghost" onClick={loadDemo} disabled={isBusy}>
            <RotateCcw size={15} /> 载入演示案件
          </button>
          <button className="button button-primary" onClick={runAnalysis} disabled={isBusy || evidence.length === 0}>
            {isAnalyzing ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
            {isAnalyzing ? "正在分析" : "开始调查"}
          </button>
        </div>
      </header>

      <div className="statusbar">
        <span><FolderOpen size={13} /> {evidence.length} 份证据</span>
        <span><Users size={13} /> {analysis?.people.length ?? 0} 名人物</span>
        <span><Clock3 size={13} /> {analysis?.events.length ?? 0} 个事件</span>
        <span className={analysis?.contradictions.length ? "status-alert" : ""}>
          <AlertTriangle size={13} /> {analysis?.contradictions.length ?? 0} 处待核查差异
        </span>
        <span className="privacy-note"><ShieldCheck size={13} /> 虚构数据 · 不作事实或法律定性</span>
      </div>

      {error && <div className="error-banner" role="alert"><AlertTriangle size={16} /> {error}</div>}

      <main className="workspace-grid">
        <aside className="panel evidence-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">01 / EVIDENCE</span><h2>证据档案</h2></div>
            <span className="count-badge">{evidence.length}</span>
          </div>

          <button
            className="upload-zone"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void uploadFiles(Array.from(event.dataTransfer.files));
            }}
            disabled={isBusy}
          >
            {isParsing ? <LoaderCircle className="spin" size={23} /> : <Upload size={23} />}
            <strong>{isParsing ? "正在解析材料" : "拖入或选择证据"}</strong>
            <span>文本、聊天截图、图片 · PDF 由 A 接入</span>
          </button>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            multiple
            accept=".txt,.md,.json,.csv,.log,.pdf,image/*"
            onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))}
          />

          <div className="evidence-list">
            {evidence.map((item, index) => (
              <button
                className={`evidence-item ${selectedEvidence?.id === item.id ? "selected" : ""}`}
                key={item.id}
                onClick={() => setSelectedEvidenceId(item.id)}
              >
                <span className="file-icon"><FileText size={16} /></span>
                <span className="file-copy"><strong>{item.name}</strong><small>{item.source ?? item.kind}</small></span>
                <span className="file-index">{String(index + 1).padStart(2, "0")}</span>
              </button>
            ))}
            {evidence.length === 0 && <div className="empty-compact">尚未上传证据</div>}
          </div>

          {selectedEvidence && (
            <section className="source-viewer">
              <div className="source-title"><span>原文回溯</span><small>{selectedEvidence.id}</small></div>
              {selectedEvidence.kind === "image" ? (
                <Image className="source-image" src={selectedEvidence.content} alt={selectedEvidence.name} width={640} height={480} unoptimized />
              ) : (
                <pre>{selectedEvidence.content}</pre>
              )}
            </section>
          )}
        </aside>

        <section className="panel investigation-panel">
          <div className="panel-heading center-heading">
            <div><span className="eyebrow">02 / RECONSTRUCTION</span><h2>调查重建</h2></div>
            <div className="view-tabs" role="tablist" aria-label="调查视图">
              <button className={centerView === "graph" ? "active" : ""} onClick={() => setCenterView("graph")}><GitBranch size={14} />关系图</button>
              <button className={centerView === "timeline" ? "active" : ""} onClick={() => setCenterView("timeline")}><Clock3 size={14} />时间线</button>
              <button className={centerView === "actions" ? "active" : ""} onClick={() => setCenterView("actions")}><SearchCheck size={14} />承诺与补证</button>
            </div>
          </div>

          <div className="investigation-content">
            {!analysis ? (
              <div className="empty-state large"><Sparkles size={30} /><strong>证据已就绪</strong><span>点击“开始调查”生成结构化分析，或载入演示案件。</span></div>
            ) : centerView === "graph" ? (
              <RelationshipGraph analysis={analysis} />
            ) : centerView === "timeline" ? (
              <Timeline analysis={analysis} evidence={evidence} onOpenEvidence={openEvidence} />
            ) : (
              <div className="action-view">
                <section>
                  <div className="section-title"><CheckCircle2 size={17} /><h3>承诺追踪</h3><span>{analysis.commitments.length}</span></div>
                  {analysis.commitments.map((commitment) => {
                    const person = analysis.people.find((item) => item.id === commitment.personId);
                    return (
                      <article className="action-card" key={commitment.id}>
                        <div><strong>{commitment.commitment}</strong><span className={`commitment-status status-${commitment.status}`}>{commitment.status === "disputed" ? "履行存疑" : commitment.status}</span></div>
                        <p>{person?.name ?? "未知人物"} · 约定：{commitment.dueLabel}</p>
                        {commitment.evidenceRefs.map((ref, index) => <button className="quote-link" key={index} onClick={() => openEvidence(ref.evidenceId)}>“{ref.quote}”</button>)}
                      </article>
                    );
                  })}
                  {analysis.commitments.length === 0 && <div className="empty-compact">未提取到明确承诺</div>}
                </section>
                <section>
                  <div className="section-title"><FileQuestion size={17} /><h3>下一步补证</h3><span>{analysis.evidenceGaps.length}</span></div>
                  {analysis.evidenceGaps.map((gap) => (
                    <article className="action-card gap-card" key={gap.id}>
                      <strong>{gap.title}</strong><p>{gap.reason}</p>
                      <div className="suggestion">建议：{gap.suggestedEvidence}</div>
                    </article>
                  ))}
                  {analysis.evidenceGaps.length === 0 && <div className="empty-compact">暂无补证建议</div>}
                </section>
              </div>
            )}
          </div>
          <div className="canvas-footer"><span><span className="live-dot" /> 所有分析条目均应可回溯原始证据</span><span>TRUTHTRACE / WORKBENCH 0.1</span></div>
        </section>

        <aside className="panel findings-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">03 / FINDINGS</span><h2>核验发现</h2></div>
            {analysis && <span className={`mode-badge mode-${analysis.analysisMode}`}>{analysis.analysisMode === "mock" ? "模拟分析" : "模型分析"}</span>}
          </div>
          {analysis ? (
            <div className="findings-scroll">
              <section className="case-summary"><span>案件摘要</span><p>{analysis.summary}</p></section>
              <section>
                <div className="section-title findings-title"><AlertTriangle size={16} /><h3>证据差异</h3><span>{analysis.contradictions.length}</span></div>
                {analysis.contradictions.map((contradiction) => (
                  <article className="contradiction-card" key={contradiction.id}>
                    <div className="contradiction-label"><span>{contradiction.severity === "high" ? "优先核查" : "待核查"}</span><small>非事实定性</small></div>
                    <h3>{contradiction.title}</h3><p>{contradiction.description}</p>
                    <div className="contradiction-evidence">
                      {contradiction.evidenceRefs.map((ref, index) => {
                        const source = evidence.find((item) => item.id === ref.evidenceId);
                        return (
                          <button key={`${ref.evidenceId}-${index}`} onClick={() => openEvidence(ref.evidenceId)}>
                            <span>{source?.name ?? ref.evidenceId}</span><blockquote>“{ref.quote}”</blockquote>
                          </button>
                        );
                      })}
                    </div>
                  </article>
                ))}
                {analysis.contradictions.length === 0 && <div className="empty-compact">当前未检测到证据差异</div>}
              </section>
              <div className="review-notice"><ShieldCheck size={17} /><p>AI 只标记值得核查的材料关系。请结合完整上下文人工判断，不据此指控任何个人。</p></div>
            </div>
          ) : (
            <div className="empty-state"><SearchCheck size={25} /><span>分析后在此显示摘要与证据差异。</span></div>
          )}
        </aside>
      </main>
    </div>
  );
}
