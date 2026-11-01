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

function Studio({ onAnalysisReady, onContext }: { onAnalysisReady: (result: CaseAnalysis) => void; onContext: (context: AgentContext | null) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    return mountStudio(root.current, { assets, analyzeFiles, onAnalysisReady, onContext });
  }, [onAnalysisReady, onContext]);
  return <div ref={root} className="studio-host" aria-label="TruthTrace 案件工作空间" />;
}

// Keep page.tsx compatible; its demo props must not bypass the empty entry.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function InvestigationWorkbench(_initialData: WorkbenchProps) {
  const [sample, setSample] = useState<AgentContext | null>(null);
  const onContext = useCallback((value: AgentContext | null) => setSample(value), []);
  const [home, setHome] = useState(false);
  const [result, setResult] = useState<CaseAnalysis | null>(null);
  const openAnalysis = useCallback((value: CaseAnalysis) => { setHome(false); setResult(value); }, []);
  function goHome() { history.replaceState(null, "", "#home"); setHome(true); }
  return <>{result && !home ? <ContractWorkbench result={result} onHome={goHome} /> : <>{result && <button className="resume-analysis" onClick={() => setHome(false)}>继续查看：{result.caseName || result.analysis.caseTitle} →</button>}<Studio onAnalysisReady={openAnalysis} onContext={onContext} /></>}<AgentPanel context={result && !home ? result : sample} /></>;
}
