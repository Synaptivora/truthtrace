"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";
import { analyzeFiles, type CaseAnalysis } from "./truthtrace/api-client";
import { InvestigatorPanel } from "./truthtrace/investigator-panel";
import { ContractWorkbench } from "./truthtrace/contract-workbench";
import { mountStudio } from "./truthtrace/runtime.mjs";
import { AgentPanel, type AgentContext } from "./truthtrace/agent-panel";
import { ChannelImport, type ChannelId } from "./truthtrace/channel-import";
import campus from "./truthtrace/assets/campus.jpg";
import contacts from "./truthtrace/assets/contacts.jpg";
import cork from "./truthtrace/assets/cork.jpg";
import lamp from "./truthtrace/assets/desk-lamp.png";
import cat from "./truthtrace/assets/detective-cat.png";
import avatar from "./truthtrace/assets/inspector-avatar.png";
import students from "./truthtrace/assets/students.jpg";

type WorkbenchProps = { initialEvidence: Evidence[]; initialAnalysis: AnalysisResult };
const assets = {
  "campus.jpg": campus.src, "contacts.jpg": contacts.src, "cork.jpg": cork.src,
  "desk-lamp.png": lamp.src, "detective-cat.png": cat.src,
  "inspector-avatar.png": avatar.src, "students.jpg": students.src,
};

function Studio({ onAnalysisReady, onContext, cases, onOpenCase, onOpenChannel }: { onAnalysisReady: (result: CaseAnalysis) => void; onContext: (context: AgentContext | null) => void; cases: CaseAnalysis[]; onOpenCase: (id: string) => void; onOpenChannel: (channel: ChannelId) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    return mountStudio(root.current, { assets, analyzeFiles, onAnalysisReady, onContext, cases, onOpenCase, onOpenChannel });
  }, [onAnalysisReady, onContext, cases, onOpenCase, onOpenChannel]);
  return <div ref={root} className="studio-host" aria-label="TruthTrace 案件工作空间" />;
}

// Keep page.tsx compatible; its demo props must not bypass the empty entry.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function InvestigationWorkbench(_initialData: WorkbenchProps) {
  const [sample, setSample] = useState<AgentContext | null>(null);
  const onContext = useCallback((value: AgentContext | null) => setSample(value), []);
  const [cases, setCases] = useState<CaseAnalysis[]>([]);
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/cases", { signal: controller.signal }).then(r => r.json()).then(data => {
      if (data.error) throw new Error(data.error);
      setCases(previous => [...data.cases.filter((c: CaseAnalysis) => !previous.some(p => p.caseId === c.caseId)), ...previous]);
    }).catch(e => { if (!controller.signal.aborted) setStorageError(`读取本地案件失败：${e.message}`); });
    return () => controller.abort();
  }, []);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [channel, setChannel] = useState<ChannelId | null>(null);
  const openAnalysis = useCallback((value: CaseAnalysis) => {
    const next = { ...value, caseId: value.caseId || crypto.randomUUID() };
    setCases(previous => [...previous.filter(item => item.caseId !== next.caseId), next]);
    setActiveId(next.caseId);
    fetch("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).then(async r => {
      const data = await r.json(); if (!r.ok) throw new Error(data.error || "保存失败");
      setCases(previous => previous.map(item => item.caseId === data.case.caseId ? data.case : item));
      setStorageError("");
    }).catch(e => setStorageError(`案件尚未保存：${e.message}`));
  }, []);
  const openCase = useCallback((id: string) => setActiveId(id), []);
  const openChannel = useCallback((value: ChannelId) => setChannel(value), []);
  const closeChannel = useCallback(() => setChannel(null), []);
  const importedCase = useCallback((value: CaseAnalysis) => { setChannel(null); openAnalysis(value); }, [openAnalysis]);
  function goHome() { history.replaceState(null, "", "#home"); setSample(null); setActiveId(null); }
  const result = cases.find(item => item.caseId === activeId);
  return <>{storageError && <p role="alert">{storageError}</p>}{result && <InvestigatorPanel key={result.caseId} context={result} />}{result ? <ContractWorkbench key={result.caseId} result={result} onHome={goHome} onUpdate={openAnalysis} /> : <Studio cases={cases} onOpenCase={openCase} onAnalysisReady={openAnalysis} onContext={onContext} onOpenChannel={openChannel} />}<AgentPanel context={result || sample} />{channel && <ChannelImport channel={channel} onClose={closeChannel} onReady={importedCase} />}</>;
}
