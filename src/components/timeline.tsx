"use client";

import { useState } from "react";
import { Clock3, Quote } from "lucide-react";
import type { AnalysisResult, Evidence, EvidenceRef } from "@/lib/contracts";

import { mergeTimeline } from "./truthtrace/case-view";

type TimelineProps = {
  analysis: AnalysisResult;
  evidence: Evidence[];
  onOpenEvidence: (evidenceId: string) => void;
  onOpenReference?: (ref:EvidenceRef)=>void;
};

export function Timeline({ analysis, evidence, onOpenEvidence,onOpenReference }: TimelineProps) {
  const [shown,setShown]=useState<number|null>(null);
  const events = mergeTimeline(analysis.events);
  const timed=events.filter(event=>event.occurredAt&&event.timePrecision==="exact"&&event.evidenceRefs.length);
  const count=Math.min(shown??timed.length,timed.length);
  const visible=events.filter(event=>!timed.includes(event)||timed.indexOf(event)<count);

  if (events.length === 0) return <div className="empty-state">暂无可展示的事件。</div>;

  return (
    <div className="timeline-scroll">
      {timed.length>0&&<label>按有明确时间的事件回看 {count}/{timed.length}<input aria-label="时间线回看" type="range" min={0} max={timed.length} value={count} onChange={e=>setShown(Number(e.target.value))}/></label>}
      <p>约略时间和未知时间单独保留，不推断先后。事件来自材料陈述，仍需核实。</p>
      <div className="timeline">
        {visible.map((event) => (
          <article className="timeline-item" key={event.id}>
            <div className="timeline-marker" />
            <div className="timeline-time">
              <Clock3 size={14} />
              {event.timeLabel}
            </div>
            <div className="timeline-card">
              <div className="timeline-card-heading">
                <h3>{event.title}</h3>
                <span className={`precision precision-${event.timePrecision}`}>
                  {event.timePrecision === "exact" ? "明确时间" : event.timePrecision === "approximate" ? "约略时间" : "时间未知"}
                </span>
              </div>
              {event.description.trim() !== event.title.trim() && <p>{event.description}</p>}
              <div className="evidence-chips">
                {[...new Map(event.evidenceRefs.map(ref => [ref.evidenceId, ref])).values()].map((ref, index) => {
                  const source = evidence.find((item) => item.id === ref.evidenceId);
                  return (
                    <button key={`${ref.evidenceId}-${index}`} onClick={() => onOpenReference?onOpenReference(ref):onOpenEvidence(ref.evidenceId)}>
                      <Quote size={12} />
                      {source?.name ?? ref.evidenceId}
                    </button>
                  );
                })}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
