"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";
import { analyzeFiles, type CaseAnalysis } from "./truthtrace/api-client";
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
  const goalDraft = useRef("");
  useEffect(() => {
    if (!root.current) return;
    const element=root.current;
    const dispose=mountStudio(element, { assets, analyzeFiles, onAnalysisReady, onContext, cases, onOpenCase, onOpenChannel });
    const input=element.querySelector<HTMLTextAreaElement>("#entryGoal");
    if(input)input.value=goalDraft.current;
    return ()=>{goalDraft.current=element.querySelector<HTMLTextAreaElement>("#entryGoal")?.value??goalDraft.current;dispose();};
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
  const openAnalysis = useCallback(async (value: CaseAnalysis) => {
    const previousCase=cases.find(item=>item.caseId===value.caseId);
    const next = { ...value, goal:value.goal||previousCase?.goal, caseId: value.caseId || crypto.randomUUID() };
    setCases(previous => [...previous.filter(item => item.caseId !== next.caseId), next]);
    setActiveId(next.caseId);
    await fetch("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).then(async r => {
      const data = await r.json(); if (!r.ok) throw new Error(data.error || "保存失败");
      setCases(previous => previous.map(item => item.caseId === data.case.caseId ? data.case : item));
      setStorageError("");
      if(previousCase&&JSON.stringify(previousCase.evidence)!==JSON.stringify(data.case.evidence)) {
        const tasks=await fetch(`/api/cases/${data.case.caseId}/investigations`).then(r=>r.json());
        const task=tasks.tasks?.[0];
        if(task&&task.state!=="cancelled") {
          const service=await fetch("/api/assistant/service",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
          if(!service.ok)throw new Error("材料已保存，但调查服务暂不可用，请在助手中继续核查");
          const revised=await fetch(`/api/investigations/${task.id}/actions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"revise",goal:data.case.goal||task.goal})});
          if(!revised.ok)throw new Error("材料已保存，自动继续失败，请在助手中加入新材料");
        }
      }
    }).catch(e => {setStorageError(e.message);throw e;});
  }, [cases]);
  const openCase = useCallback((id: string) => setActiveId(id), []);
  const [channelTarget,setChannelTarget]=useState<CaseAnalysis|undefined>();
  const [pendingGoal,setPendingGoal]=useState("");
  const openChannel = useCallback((value:ChannelId,goal="")=>{setChannelTarget(cases.find(item=>item.caseId===activeId));setPendingGoal(goal);setChannel(value);},[cases,activeId]);
  const closeChannel = useCallback(() => setChannel(null), []);
  const importedCase = useCallback(async (value: CaseAnalysis) => { await openAnalysis({...value,goal:value.goal||pendingGoal});setChannel(null);requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent("truthtrace:assistant",{detail:{view:"investigation"}}))); }, [openAnalysis,pendingGoal]);
  function goHome() { history.replaceState(null, "", "#home"); setSample(null); setActiveId(null); }
  const result = cases.find(item => item.caseId === activeId);
  return <>{storageError && <p role="alert">{storageError}</p>}{result ? <ContractWorkbench key={`${result.caseId}-workbench`} result={result} onHome={goHome} onUpdate={openAnalysis} /> : <Studio cases={cases} onOpenCase={openCase} onAnalysisReady={openAnalysis} onContext={onContext} onOpenChannel={openChannel} />}<AgentPanel context={result || sample} onReady={openAnalysis} onChannel={openChannel} />{channel && <ChannelImport key={channel} existing={channelTarget} goal={pendingGoal} channel={channel} onClose={closeChannel} onReady={importedCase} />}</>;
}
