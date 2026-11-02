"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";
import { analyzeFiles, type CaseAnalysis } from "./truthtrace/api-client";
import { ContractWorkbench } from "./truthtrace/contract-workbench";
import { mountStudio } from "./truthtrace/runtime.mjs";
import { AgentPanel, type AgentContext } from "./truthtrace/agent-panel";
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

function Studio({ onAnalysisReady, onContext, cases, onOpenCase }: { onAnalysisReady: (result: CaseAnalysis) => void; onContext: (context: AgentContext | null) => void; cases: CaseAnalysis[]; onOpenCase: (id: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    return mountStudio(root.current, { assets, analyzeFiles, onAnalysisReady, onContext, cases, onOpenCase });
  }, [onAnalysisReady, onContext, cases, onOpenCase]);
  return <div ref={root} className="studio-host" aria-label="TruthTrace 案件工作空间" />;
}

// Keep page.tsx compatible; its demo props must not bypass the empty entry.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function InvestigationWorkbench(_initialData: WorkbenchProps) {
  const [sample, setSample] = useState<AgentContext | null>(null);
  const onContext = useCallback((value: AgentContext | null) => setSample(value), []);
  const [cases, setCases] = useState<CaseAnalysis[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const openAnalysis = useCallback((value: CaseAnalysis) => {
    const next = { ...value, caseId: value.caseId || crypto.randomUUID() };
    setCases(previous => [...previous.filter(item => item.caseId !== next.caseId), next]);
    setActiveId(next.caseId);
  }, []);
  const openCase = useCallback((id: string) => setActiveId(id), []);
  function goHome() { history.replaceState(null, "", "#home"); setSample(null); setActiveId(null); }
  const result = cases.find(item => item.caseId === activeId);
  return <>{result ? <ContractWorkbench key={result.caseId} result={result} onHome={goHome} onUpdate={openAnalysis} /> : <Studio cases={cases} onOpenCase={openCase} onAnalysisReady={openAnalysis} onContext={onContext} />}<AgentPanel context={result || sample} /></>;
}
